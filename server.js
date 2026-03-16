const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');

require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const conversations = {};

const SYSTEM_PROMPT = `You are Sofia, the friendly bilingual AI phone receptionist for Tacos 203, a Mexican fast-food restaurant in Connecticut. You answer calls, respond to menu questions, and take orders over the phone.

CRITICAL RULES:
- PICKUP ONLY — no delivery, no exceptions. If asked about delivery say: "We are pickup only, but we'd love to have you come in!"
- Keep ALL responses under 2 sentences maximum. Be fast and direct.
- Never use bullet points, lists, or markdown. Speak naturally.
- Detect language from first message and respond in that language always.
- Ask ONE question at a time only.
- For orders: confirm "con todo" (cilantro, onions, salsa) or "plain" for each item.
- Say prices as words: "three ninety-nine" not "$3.99".
- Summarize order and total at the end.

ALLERGY INFORMATION (answer accurately and quickly):
GLUTEN/WHEAT:
- Tacos (corn tortilla): GLUTEN FREE
- Taco'dillas (flour tortilla): CONTAIN GLUTEN
- Churros: CONTAIN GLUTEN
- Walking Taco (corn chips): GLUTEN FREE
- All other snacks: check with kitchen for cross-contamination

DAIRY:
- Taco'dillas: CONTAIN DAIRY (chihuahua cheese)
- Charro Beans: dairy free
- All tacos: dairy free
- Street Corn: may contain dairy (ask customer preference)
- Churros: may contain dairy

NUTS: No nut-based ingredients in any menu item. Low risk.

SOY: Not a primary ingredient in any dish.

EGGS: Not a primary ingredient in any dish.

SHELLFISH: No shellfish on the menu.

SPICY / HEAT:
- Chorizo Taco'dilla: SPICY (spicy sausage)
- TG Wings: medium-hot (Valentina buffalo sauce)
- Diablo Fries (in Loaded Fries): SPICY
- All salsas served are NON-SPICY
- Everything else: mild / not spicy

MEAT / VEGETARIAN:
- Vegetarian safe: Cactus Taco, Cactus Taco'dilla, Cheese Taco'dilla, Street Corn, Churros
- Contains meat: Al Pastor, Chorizo, Buche/Tripe, Steak Birria, Walking Taco, Charro Beans, Loaded Fries, TG Wings

PORK:
- Contains pork: Al Pastor, Chorizo, Buche/Tripe, Charro Beans
- No pork: Cactus items, Cheese Taco'dilla, Steak Birria, TG Wings, Street Corn, Churros

MENU:
TACOS (corn tortilla — GLUTEN FREE) — "con todo" = cilantro, onions, salsa; "plain" = protein only:
- Al Pastor Taco: marinated pork — $3.99
- Chorizo Taco: sausage — $3.99
- Cactus Taco: sauteed cactus with tomato, vegetarian — $4.45
- Buche/Tripe Taco: pork tripe — $4.95
- Steak Birria Taco: slow-cooked steak — $5.45

TACO'DILLAS (flour tortilla + chihuahua cheese — CONTAIN GLUTEN + DAIRY):
- Al Pastor Taco'dilla — $6.50
- Chorizo Taco'dilla: SPICY — $6.50
- Cactus Taco'dilla: vegetarian — $6.50
- Buche/Tripe Taco'dilla — $6.50
- Steak Birria Taco'dilla — $6.50
- Cheese Taco'dilla: vegetarian — $5.00

SNACKS:
- Walking Taco: corn chips + Al Pastor — $6.99
- Street Corn — $6.99
- TG Wings: 7 wings, Valentina buffalo sauce, blue cheese dip — $9.99
- Charro Beans: contains meat (al pastor + chorizo) — $4.99
- Loaded Fries: diablo fries + charro beans + cotija — $7.00
- Churros — $8.99`;

function escapeXml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

function detectLanguage(text) {
  return /[áéíóúñ¿¡]/.test(text) || /\b(hola|gracias|sí|claro|quiero|tengo|cómo|qué|cuánto|tienen|buenas|bueno|necesito|me|para|un|una|dos|tres|por favor|puedo|tiene|hay)\b/i.test(text) ? 'es' : 'en';
}

function buildGatherResponse(textToSay, callSid, lang = 'en') {
  const isSpanish = lang === 'es';
  const voice = isSpanish ? 'Polly.Conchita' : 'Polly.Joanna';
  const speechLang = isSpanish ? 'es-ES' : 'en-US';

  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    action: `/respond?callSid=${callSid}&lang=${lang}`,
    method: 'POST',
    language: speechLang,
    speechTimeout: 'auto',
    timeout: 5,
  });
  gather.say({ voice, language: speechLang }, escapeXml(textToSay));
  twiml.redirect(`/no-input?callSid=${callSid}&lang=${lang}`);
  return twiml.toString();
}

app.post('/incoming-call', (req, res) => {
  const callSid = req.body.CallSid;
  conversations[callSid] = [];
  const greeting = "Thanks for calling Tacos 203, I'm Sofia! We're pickup only. How can I help you?";
  res.type('text/xml');
  res.send(buildGatherResponse(greeting, callSid, 'en'));
});

app.post('/respond', async (req, res) => {
  const callSid = req.query.callSid || req.body.CallSid;
  const speechResult = req.body.SpeechResult || '';
  const prevLang = req.query.lang || 'en';
  const lang = speechResult ? detectLanguage(speechResult) : prevLang;

  console.log(`[${callSid}] [${lang}] Customer: ${speechResult}`);

  if (!conversations[callSid]) conversations[callSid] = [];

  if (!speechResult.trim()) {
    const sorry = lang === 'es' ? 'No te escuché, ¿puedes repetir?' : "Didn't catch that, could you repeat?";
    res.type('text/xml');
    res.send(buildGatherResponse(sorry, callSid, lang));
    return;
  }

  conversations[callSid].push({ role: 'user', content: speechResult });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 120,
      system: SYSTEM_PROMPT,
      messages: conversations[callSid],
    });

    const aiText = response.content[0].text;
    conversations[callSid].push({ role: 'assistant', content: aiText });
    console.log(`[${callSid}] Sofia: ${aiText}`);

    res.type('text/xml');
    res.send(buildGatherResponse(aiText, callSid, lang));
  } catch (err) {
    console.error('Error:', err);
    const errMsg = lang === 'es' ? 'Hubo un error, intenta de nuevo.' : 'Technical issue, please try again.';
    res.type('text/xml');
    res.send(buildGatherResponse(errMsg, callSid, lang));
  }
});

app.get('/no-input', (req, res) => {
  const callSid = req.query.callSid;
  const lang = req.query.lang || 'en';
  const msg = lang === 'es' ? '¿Sigues ahí? ¿Te puedo ayudar?' : 'Still there? How can I help?';
  res.type('text/xml');
  res.send(buildGatherResponse(msg, callSid, lang));
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'Tacos 203 AI Receptionist' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌮 Tacos 203 running on port ${PORT}`));
