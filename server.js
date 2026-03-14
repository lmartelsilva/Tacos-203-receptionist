/**
 * Tacos 203 — AI Phone Receptionist
 * Stack: Twilio (calls) + Deepgram (STT) + Claude (AI) + Twilio TTS
 * 
 * Flow: Incoming call → Twilio streams audio → Deepgram transcribes →
 *       Claude generates response → Twilio speaks it back
 */

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

// ─── Menu & System Prompt ────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Sofia, the friendly bilingual AI phone receptionist for Tacos 203, a Mexican fast-food restaurant. You answer calls, respond to menu questions, and take orders over the phone.

IMPORTANT VOICE RULES:
- Keep responses SHORT and conversational — this is a phone call, not a chat.
- Never use bullet points, markdown, or lists. Speak naturally.
- Always detect the customer's language and respond in the same language.
- Ask clarifying questions one at a time (don't list all options at once).
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
- TG Wings: 7 wings in Valentina buffalo sauce, served with blue cheese dip — $9.99
- Charro Beans: refried beans with al pastor and chorizo — $4.99
- Loaded Fries: diablo fries, charro beans, cotija cheese — $7.00
- Churros — $8.99

VEGETARIAN: Cactus Taco, Cactus Taco'dilla, Cheese Taco'dilla, Street Corn, Churros.

When the order is complete, say something like: "Great! Your order is [items]. Your total is [total]. We'll have that ready for you!"`;

// ─── Twilio webhook: incoming call ──────────────────────────────────────────

app.post('/incoming-call', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  // Greet the caller
  twiml.say(
    { voice: 'Polly.Lupe-Neural', language: 'es-US' },
    'Thank you for calling Tacos 203! Gracias por llamar a Tacos 203. Hold on one moment while I connect you with Sofia, our AI assistant.'
  );

  // Open a media stream to our WebSocket
  const connect = twiml.connect();
  connect.stream({
    url: `wss://${req.headers.host}/media-stream`,
    track: 'inbound_track'
  });

  res.type('text/xml');
  res.send(twiml.toString());
});

// ─── WebSocket: audio streaming ─────────────────────────────────────────────

wss.on('connection', (ws) => {
  console.log('New call connected');

  let streamSid = null;
  let callSid = null;
  const conversationHistory = [];
  let transcript = '';
  let silenceTimer = null;
  let dgConnection = null;

  // Connect to Deepgram for real-time transcription
  const setupDeepgram = () => {
    dgConnection = deepgram.listen.live({
      model: 'nova-2',
      language: 'multi',        // Auto-detect English + Spanish
      punctuate: true,
      endpointing: 500,         // ms of silence to detect end of speech
      encoding: 'mulaw',
      sample_rate: 8000,
      channels: 1,
    });

    dgConnection.on(LiveTranscriptionEvents.Open, () => {
      console.log('Deepgram connected');
    });

    dgConnection.on(LiveTranscriptionEvents.Transcript, async (data) => {
      const text = data.channel?.alternatives?.[0]?.transcript;
      if (!text || text.trim() === '') return;

      if (data.is_final) {
        transcript += ' ' + text;
        console.log('Customer said:', transcript.trim());

        // Debounce: wait 600ms of silence before sending to Claude
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(async () => {
          const userText = transcript.trim();
          transcript = '';
          if (userText.length < 2) return;
          await getAIResponse(userText);
        }, 600);
      }
    });

    dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
      console.error('Deepgram error:', err);
    });
  };

  // Get Claude response and speak it via Twilio
  const getAIResponse = async (userText) => {
    conversationHistory.push({ role: 'user', content: userText });

    try {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: conversationHistory,
      });

      const aiText = response.content[0].text;
      conversationHistory.push({ role: 'assistant', content: aiText });
      console.log('Sofia says:', aiText);

      // Send TwiML to speak the response
      speakResponse(aiText, callSid);
    } catch (err) {
      console.error('Claude error:', err);
    }
  };

  // Use Twilio REST API to inject TwiML mid-call
  const speakResponse = async (text, cSid) => {
    if (!cSid) return;
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

    // Detect language for voice selection
    const isSpanish = /[áéíóúñ¿¡]/.test(text) || /\b(hola|gracias|sí|claro|quiero|tengo|cómo)\b/i.test(text);
    const voice = isSpanish ? 'Polly.Lupe-Neural' : 'Polly.Joanna-Neural';

    try {
      await client.calls(cSid).update({
        twiml: `<Response><Say voice="${voice}">${escapeXml(text)}</Say><Pause length="30"/></Response>`
      });
    } catch (err) {
      console.error('Twilio speak error:', err);
    }
  };

  // Handle incoming Twilio media stream messages
  ws.on('message', (message) => {
    const msg = JSON.parse(message);

    switch (msg.event) {
      case 'start':
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        console.log(`Stream started: ${streamSid} | Call: ${callSid}`);
        setupDeepgram();

        // Sofia's opening line
        setTimeout(() => {
          speakResponse(
            "Hi! Thanks for calling Tacos 203. I'm Sofia, how can I help you today? ¡También puedo ayudarte en español!",
            callSid
          );
        }, 1000);
        break;

      case 'media':
        // Forward audio to Deepgram
        if (dgConnection) {
          const audioBuffer = Buffer.from(msg.media.payload, 'base64');
          dgConnection.send(audioBuffer);
        }
        break;

      case 'stop':
        console.log('Call ended');
        if (dgConnection) dgConnection.finish();
        break;
    }
  });

  ws.on('close', () => {
    console.log('WebSocket closed');
    if (dgConnection) dgConnection.finish();
    clearTimeout(silenceTimer);
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'Tacos 203 AI Receptionist' }));

// ─── Start server ────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌮 Tacos 203 AI Receptionist running on port ${PORT}`);
});
