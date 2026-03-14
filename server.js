/**
 * Tacos 203 — AI Phone Receptionist
 * Stack: Twilio (calls + STT via Gather) + Claude (AI) + Twilio TTS
 * Works with Twilio Trial accounts
 */

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');

require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const conversations = {};

const SYSTEM_PROMPT = `You are Sofia, the friendly bilingual AI phone receptionist for Tacos 203, a Mexican fast-food restaurant. You answer calls, respond to menu questions, and take orders over the phone.

IMPORTANT VOICE RULES:
- Keep responses SHORT — maximum 2-3 sentences. This is a phone call.
- Never use bullet points, markdown, or lists. Speak naturally.
- Always detect the customer's language and respond in the same language.
- Ask ONE question at a time.
- For orders: always confirm "con todo" (with cilantro, onions, salsa) or "plain" for each item.
- Speak prices clearly: "three ninety-nine" not "$3.99".
- At the end of an order, summarize it and give the total.

MENU:
TACOS (corn tortilla) — "con todo" = cilantro, onions, non-spicy salsa; "plain" = protein only:
- Al Pastor Taco: marinated pork — $3.99
- Chorizo Taco: flavorful sausage — $3.99
- Cactus Taco: sauteed cactus with tomato, NOT spicy — $4.45
- Buche/Tripe Taco: pork tripe — $4.95
- Steak Birria Taco: slow-cooked steak — $5.45

TACO'DILLAS (flour tortilla + chihuahua cheese) — "con todo" = cilantro, onions, salsa; "plain" = protein + cheese only:
- Al Pastor Taco'dilla — $6.50
- Chorizo Taco'dilla: spicy pork sausage — $6.50
- Cactus Taco'dilla — $6.50
- Buche/Tripe Taco'dilla — $6.50
- Steak Birria Taco'dilla — $6.50
- Cheese Taco'dilla — $5.00

SNACKS:
- Walking Taco: corn chips with Al Pastor, cilantro, onion — $6.99
- Street Corn — $6.99
- TG Wings: 7 wings in Valentina buffalo sauce, blue cheese dip — $9.99
- Charro Beans: refried beans with al pastor and chorizo — $4.99
- Loaded Fries: diablo fries, charro beans, cotija cheese — $7.00
- Churros — $8.99

VEGETARIAN: Cactus Taco, Cactus Taco'dilla, Cheese Taco'dilla, Street Corn, Churros.`;

function escapeXml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

function detectLanguage(text) {
  return /[áéíóúñ¿¡]/.test(text) || /\b(hola|gracias|sí|claro|quiero|tengo|cómo|qué|cuánto|tienen)\b/i.test(text) ? 'es-US' : 'en-US';
}

function getVoice(lang) {
  return lang === 'es-US' ? 'Polly.Lupe-Neural' : 'Polly.Joanna-Neural';
}

function buildGatherResponse(textToSay, callSid, lang = 'en-US') {
  const voice = getVoice(lang);
  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    action: `/respond?callSid=${callSid}`,
    method: 'POST',
    language: lang === 'es-US' ? 'es-US' : 'en-US',
    speechTimeout: 'auto',
    timeout: 5,
  });
  gather.say({ voice }, escapeXml(textToSay));
  twiml.redirect(`/no-input?callSid=${callSid}`);
  return twiml.toString();
}

app.post('/incoming-call', (req, res) => {
  const callSid = req.body.CallSid;
  conversations[callSid] = [];
  const greeting = "Hi! Thanks for calling Tacos 203, I'm Sofia. How can I help you today? I also speak Spanish!";
  res.type('text/xml');
  res.send(buildGatherResponse(greeting, callSid, 'en-US'));
});

app.post('/respond', async (req, res) => {
  const callSid = req.query.callSid || req.body.CallSid;
  const speechResult = req.body.SpeechResult || '';
  console.log(`[${callSid}] Customer said: ${speechResult}`);
  if (!conversations[callSid]) conversations[callSid] = [];
  const lang = detectLanguage(speechResult);
  if (!speechResult.trim()) {
    res.type('text/xml');
    res.send(buildGatherResponse("Sorry, I didn't catch that. Could you repeat please?", callSid, lang));
    return;
  }
  conversations[callSid].push({ role: 'user', content: speechResult });
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: conversations[callSid],
    });
    const aiText = response.content[0].text;
    conversations[callSid].push({ role: 'assistant', content: aiText });
    console.log(`[${callSid}] Sofia says: ${aiText}`);
    res.type('text/xml');
    res.send(buildGatherResponse(aiText, callSid, lang));
  } catch (err) {
    console.error('Claude error:', err);
    res.type('text/xml');
    res.send(buildGatherResponse("Sorry, I had a technical issue. Please try again.", callSid, 'en-US'));
  }
});

app.get('/no-input', (req, res) => {
  const callSid = req.query.callSid;
  res.type('text/xml');
  res.send(buildGatherResponse("Are you still there? How can I help you?", callSid, 'en-US'));
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'Tacos 203 AI Receptionist' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌮 Tacos 203 AI Receptionist running on port ${PORT}`);
});
