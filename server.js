const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');

require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const conversations = {};

const SYSTEM_PROMPT = `You are Sofia, a warm and friendly AI phone receptionist for Tacos 203, a Mexican fast-food restaurant in Connecticut.

PERSONALITY — sound like a real person, not a robot:
- Use natural contractions: I'd, we've, that's, you'll, don't, can't, it's
- Use casual phrases: "Sure!", "Got it!", "No problem!", "Sounds good!"
- NEVER say: "Certainly!", "Absolutely!", "Of course!", "Great choice!" — too robotic
- Max 2 short sentences per response
- Ask ONE question at a time

IMPORTANT RULES:
- PICKUP ONLY. No delivery. If asked: "We're pickup only, but come on in!"
- Always respond in ENGLISH only regardless of what language the customer uses
- Confirm each taco/taco'dilla as "con todo" or "plain"
- Say prices as words: "three ninety-nine" not $3.99
- Summarize full order and total at the end

ALLERGY INFO:
- Gluten free: all tacos (corn tortilla), walking taco, churros are gluten-free
- Contains gluten: all taco'dillas (flour tortilla)
- Contains dairy: all taco'dillas (chihuahua cheese)
- Spicy: Chorizo Taco'dilla, TG Wings (medium), Loaded Fries
- All salsas: NON-spicy
- Vegetarian: Cactus Taco, Cactus Taco'dilla, Cheese Taco'dilla, Street Corn, Churros
- Contains pork: Al Pastor, Chorizo, Buche/Tripe, Charro Beans
- No shellfish, no nuts

MENU:
TACOS — corn tortilla, gluten free. Con todo = cilantro, onions, salsa. Plain = protein only.
- Al Pastor Taco: marinated pork — $3.99
- Chorizo Taco: sausage — $3.99
- Cactus Taco: vegetarian — $4.45
- Buche/Tripe Taco: pork tripe — $4.95
- Steak Birria Taco: slow-cooked steak — $5.45

TACO'DILLAS — flour tortilla + chihuahua cheese. Contains gluten and dairy.
- Al Pastor Taco'dilla — $6.50
- Chorizo Taco'dilla: spicy — $6.50
- Cactus Taco'dilla: vegetarian — $6.50
- Buche/Tripe Taco'dilla — $6.50
- Steak Birria Taco'dilla — $6.50
- Cheese Taco'dilla: vegetarian — $5.00

SNACKS:
- Walking Taco: corn chips + al pastor — $6.99
- Street Corn — $6.99
- TG Wings: 7 wings, Valentina buffalo sauce, blue cheese dip — $9.99
- Charro Beans: contains meat — $4.99
- Loaded Fries: spicy, contains meat — $7.00
- Churros — $8.99`;

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildResponse(text, callSid) {
  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    action: `/respond?callSid=${callSid}`,
    method: 'POST',
    language: 'en-US',
    hints: 'yes, no, I want, tacos, order, pickup, con todo, plain, allergies, vegetarian, spicy, gluten, dairy, price, total',
    speechTimeout: '2',
    timeout: 8,
    enhanced: 'true',
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
    "Hey, thanks for calling Tacos 203! I'm Sofia. We're pickup only. What can I get for you today?",
    callSid
  ));
});

app.post('/respond', async (req, res) => {
  const callSid = req.query.callSid || req.body.CallSid;
  const speech = req.body.SpeechResult || '';
  console.log(`[${callSid}] Customer: "${speech}"`);

  if (!conversations[callSid]) conversations[callSid] = [];

  if (!speech.trim()) {
    res.type('text/xml');
    res.send(buildResponse("Didn't catch that — could you repeat?", callSid));
    return;
  }

  conversations[callSid].push({ role: 'user', content: speech });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 120,
      system: SYSTEM_PROMPT,
      messages: conversations[callSid],
    });

    const reply = response.content[0].text;
    conversations[callSid].push({ role: 'assistant', content: reply });
    console.log(`[${callSid}] Sofia: "${reply}"`);

    res.type('text/xml');
    res.send(buildResponse(reply, callSid));
  } catch (err) {
    console.error('Error:', err.message);
    res.type('text/xml');
    res.send(buildResponse("Sorry, I had a little hiccup — give me one second and try again!", callSid));
  }
});

app.get('/no-input', (req, res) => {
  const callSid = req.query.callSid;
  res.type('text/xml');
  res.send(buildResponse("Still there? What can I get for you?", callSid));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Tacos 203 AI Receptionist' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌮 Tacos 203 running on port ${PORT}`));
