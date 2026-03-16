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
- PICKUP ONLY — no delivery, no exceptions. If asked about delivery say: "We are pickup only, but we'd love to have you come in!" or in Spanish: "Solo hacemos pickup, pero con gusto te esperamos aquí."
- Keep ALL responses under 2 sentences maximum. Be fast and direct.
- Never use bullet points, lists, or markdown. Speak naturally.
- Detect language from first message and respond in that language always.
- Ask ONE question at a time only.
- For orders: confirm "con todo" (cilantro, onions, salsa) or "plain" for each item.
- Say prices as words: "three ninety-nine" not "$3.99".
- Summarize order and total at the end.

ALLERGY INFORMATION:
GLUTEN/WHEAT:
- Tacos (corn tortilla): GLUTEN FREE
- Taco'dillas (flour tortilla): CONTAIN GLUTEN
- Churros: CONTAIN GLUTEN
- Walking Taco (corn chips): GLUTEN FREE

DAIRY:
- Taco'dillas: CONTAIN DAIRY (chihuahua cheese)
- All tacos: dairy free
- Street Corn: may contain dairy

SPICY:
- Chorizo Taco'dilla: SPICY
- TG Wings: medium-hot
- Loaded Fries: SPICY (diablo)
- All salsas: NON-SPICY

VEGETARIAN: Cactus Taco, Cactus Taco'dilla, Cheese Taco'dilla, Street Corn, Churros.
CONTAINS PORK: Al Pastor, Chorizo, Buche/Tripe, Charro Beans.
NO SHELLFISH. NO NUTS. LOW SOY. LOW EGG.

MENU:
TACOS (corn tortilla — GLUTEN FREE):
- Al Pastor Taco: marinated pork — $3.99
- Chorizo Taco: sausage — $3.99
- Cactus Taco: vegetarian — $4.45
- Buche/Tripe Taco: pork tripe — $4.95
- Steak Birria Taco: slow-cooked steak — $5.45

TACO'DILLAS (flour tortilla + chihuahua cheese — HAS GLUTEN + DAIRY):
- Al Pastor Taco'dilla — $6.50
- Chorizo Taco'dilla: SPICY — $6.50
- Cactus Taco'dilla: vegetarian — $6.50
- Buche/Tripe Taco'dilla — $6.50
- Steak Birria Taco'dilla — $6.50
- Cheese Taco'dilla: vegetarian — $5.00

SNACKS:
- Walking Taco — $6.99
- Street Corn — $6.99
- TG Wings: 7 wings, Valentina sauce, blue cheese dip — $9.99
- Charro Beans: contains meat — $4.99
- Loaded Fries: spicy, contains meat — $7.00
- Churros — $8.99`;

function escapeXml(str) {
  return str
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&apos;');
}

function detectLanguage(text) {
  if (!text) return 'en';
  return /[áéíóúñ¿¡]/.test(text) ||
    /\b(hola|gracias|sí|si|claro|quiero|tengo|cómo|como|qué|que|cuánto|cuanto|tienen|buenas|bueno|necesito|me|para|dos|tres|por favor|puedo|tiene|hay|quisiera|dame|quiero|favor|deme|orden|ordeno|tacos|también|tambien)\b/i.test(text)
    ? 'es' : 'en';
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
    hints: isSpanish
      ? 'hola, sí, no, quiero, tacos, orden, gracias, con todo, plain, para llevar, pickup, delivery, alergias, vegetariano, picante, precio, cuánto, cuántos'
      : 'yes, no, I want, tacos, order, thank you, con todo, plain, pickup, delivery, allergies, vegetarian, spicy, price, how much',
    speechTimeout: '3',
    timeout: 7,
    enhanced: 'true',
  });

  gather.say({ voice, language: speechLang }, escapeXml(textToSay));
  twiml.redirect(`/no-input?callSid=${callSid}&lang=${lang}`);
  return twiml.toString();
}

app.post('/incoming-call', (req, res) => {
  const callSid = req.body.CallSid;
  conversations[callSid] = [];
  const greeting = "Thanks for calling Tacos 203, I'm Sofia! Pickup only. How can I help? También hablo español.";
  res.type('text/xml');
  res.send(buildGatherResponse(greeting, callSid, 'en'));
});

app.post('/respond', async (req, res) => {
  const callSid = req.query.callSid || req.body.CallSid;
  const speechResult = req.body.SpeechResult || '';
  const prevLang = req.query.lang || 'en';
  const lang = speechResult.trim() ? detectLanguage(speechResult) : prevLang;

  console.log(`[${callSid}] [${lang}] Customer: "${speechResult}"`);

  if (!conversations[callSid]) conversations[callSid] = [];

  if (!speechResult.trim()) {
    const sorry = lang === 'es'
      ? 'No te escuché bien, ¿puedes repetir?'
      : "Didn't catch that, could you repeat?";
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
    console.log(`[${callSid}] Sofia: "${aiText}"`);

    res.type('text/xml');
    res.send(buildGatherResponse(aiText, callSid, lang));
  } catch (err) {
    console.error('Error:', err);
    const errMsg = lang === 'es'
      ? 'Hubo un problema técnico, intenta de nuevo.'
      : 'Technical issue, please try again.';
    res.type('text/xml');
    res.send(buildGatherResponse(errMsg, callSid, lang));
  }
});

app.get('/no-input', (req, res) => {
  const callSid = req.query.callSid;
  const lang = req.query.lang || 'en';
  const msg = lang === 'es'
    ? '¿Sigues ahí? ¿En qué te puedo ayudar?'
    : 'Still there? How can I help?';
  res.type('text/xml');
  res.send(buildGatherResponse(msg, callSid, lang));
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'Tacos 203 AI Receptionist' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌮 Tacos 203 running on port ${PORT}`));
