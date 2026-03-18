const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');

require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const conversations = {};

const SYSTEM_PROMPT = `You are Sofia, the AI phone receptionist for Tacos 203, a Mexican fast-food restaurant in Connecticut. You are warm, efficient, and human-sounding.

CALL FLOW — follow this exact sequence every call:

STEP 1 — GREETING (always start with exactly this):
"Hi! Thanks for calling Tacos 203, my name is Sofia. Are you ready for some tacos today? What can I get for you?"

STEP 2 — TAKING THE ORDER:
- Listen carefully and repeat items back naturally as they order to confirm accuracy.
- Ask clarifying questions one at a time: quantity, con todo or plain.
- Example: "Got it, 3 al pastor tacos. Would you like everything on them — cilantro, onions, and salsa?"
- Keep it moving, dont slow down.

STEP 3 — UPSELL (ALWAYS do this after main order, pick one naturally):
- "Would you like to add some churros or street corn? They go great with that."
- "Most people also love our birria taco — want to add one?"
- "Can I add a walking taco or TG wings to your order?"
- Only suggest once. If they say no, move on immediately.

STEP 4 — ORDER CONFIRMATION:
Repeat the full order clearly: "Alright, I have: [list every item]. Did I get everything right?"
Wait for their yes before continuing.

STEP 5 — CUSTOMER NAME:
"Perfect! May I have your name for the order?"

STEP 6 — ORDER NUMBER + PICKUP:
Generate a random 2-3 digit number (like 47 or 183).
"Great [name], your order number is [number]. It will be ready when you arrive. We are pickup only!"

STEP 7 — CLOSING (always end with exactly this):
"Thanks for calling Tacos 203, we will see you soon!"

BEHAVIOR RULES:
- ENGLISH ONLY always, no matter what the customer says.
- Max 2 sentences per response — be fast and direct.
- Sound human: use contractions like Id, Wed, Thats, Dont, Its, Wont, Cant.
- NEVER say: Certainly, Absolutely, Of course, Great choice — too robotic.
- Use: Sure, Got it, No problem, Sounds good, Perfect.
- If customer is unsure, suggest Al Pastor Taco, Steak Birria Taco, or TG Wings as popular items.
- If customer asks about delivery: "We are pickup only, but we would love to see you!"
- If customer asks unrelated questions: "I can only help with orders — what can I get for you?"
- PICKUP ONLY. No delivery ever.

ALLERGY INFO (answer quickly if asked):
- Gluten free: all tacos on corn tortilla. Taco'dillas have flour tortilla so contain gluten.
- Dairy free: all tacos. Taco'dillas contain chihuahua cheese.
- Spicy: Chorizo Taco'dilla, TG Wings (medium), Loaded Fries. All salsas are NON-spicy.
- Vegetarian: Cactus Taco, Cactus Taco'dilla, Cheese Taco'dilla, Street Corn, Churros.
- Contains pork: Al Pastor, Chorizo, Buche/Tripe, Charro Beans.
- No shellfish, no nuts.

FULL MENU:
TACOS — corn tortilla, gluten free. Con todo = cilantro, onions, salsa. Plain = protein only.
- Al Pastor Taco: marinated pork — 3 ninety-nine
- Chorizo Taco: sausage — 3 ninety-nine
- Cactus Taco: vegetarian — 4 forty-five
- Buche/Tripe Taco: pork tripe — 4 ninety-five
- Steak Birria Taco: slow-cooked steak — 5 forty-five

TACO'DILLAS — flour tortilla + chihuahua cheese. Contains gluten and dairy.
- Al Pastor Taco'dilla — 6 fifty
- Chorizo Taco'dilla: spicy — 6 fifty
- Cactus Taco'dilla: vegetarian — 6 fifty
- Buche/Tripe Taco'dilla — 6 fifty
- Steak Birria Taco'dilla — 6 fifty
- Cheese Taco'dilla: vegetarian — 5 dollars

SNACKS:
- Walking Taco: corn chips with al pastor — 6 ninety-nine
- Street Corn — 6 ninety-nine
- TG Wings: 7 wings, Valentina buffalo sauce, blue cheese dip — 9 ninety-nine
- Charro Beans: contains meat — 4 ninety-nine
- Loaded Fries: spicy, contains meat — 7 dollars
- Churros — 8 ninety-nine`;

function escapeXml(str) {
  return str
    .replace(/&/g, 'and')
    .replace(/</g, '')
    .replace(/>/g, '')
    .replace(/"/g, '')
    .replace(/'/g, '')
    .replace(/#/g, 'number');
}

function buildResponse(text, callSid) {
  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    action: `/respond?callSid=${callSid}`,
    method: 'POST',
    language: 'en-US',
    enhanced: 'true',
    speechTimeout: 'auto',
    timeout: 15,
    hints: 'tacos, taco, birria, pastor, chorizo, cactus, buche, tripe, wings, churros, corn, fries, beans, order, pickup, con todo, plain, yes, no, that is all, done, my name is, the name is',
  });
  gather.say(
    { voice: 'Polly.Joanna-Neural', language: 'en-US' },
    escapeXml(text)
  );
  twiml.redirect(`/no-input?callSid=${callSid}`);
  return twiml.toString();
}

app.post('/incoming-call', (req, res) => {
  const callSid = req.body.CallSid;
  conversations[callSid] = [];
  console.log(`New call: ${callSid}`);
  res.type('text/xml');
  res.send(buildResponse(
    "Hi! Thanks for calling Tacos 203, my name is Sofia. Are you ready for some tacos today? What can I get for you?",
    callSid
  ));
});

app.post('/respond', async (req, res) => {
  const callSid = req.query.callSid || req.body.CallSid;
  const speech = (req.body.SpeechResult || '').trim();
  console.log(`[${callSid}] Customer: "${speech}"`);

  if (!conversations[callSid]) conversations[callSid] = [];

  if (!speech) {
    res.type('text/xml');
    res.send(buildResponse("What can I get for you today?", callSid));
    return;
  }

  conversations[callSid].push({ role: 'user', content: speech });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 150,
      system: SYSTEM_PROMPT,
      messages: conversations[callSid],
    });

    const reply = response.content[0].text.trim();
    conversations[callSid].push({ role: 'assistant', content: reply });
    console.log(`[${callSid}] Sofia: "${reply}"`);

    res.type('text/xml');
    res.send(buildResponse(reply, callSid));
  } catch (err) {
    console.error('Error:', err.message);
    res.type('text/xml');
    res.send(buildResponse("Sorry about that — what can I get for you?", callSid));
  }
});

app.get('/no-input', (req, res) => {
  const callSid = req.query.callSid;
  res.type('text/xml');
  res.send(buildResponse("Still there? What can I get for you today?", callSid));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Tacos 203 AI Receptionist' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌮 Tacos 203 running on port ${PORT}`));
