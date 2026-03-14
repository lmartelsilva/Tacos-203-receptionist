# 🌮 Tacos 203 — AI Phone Receptionist
## Setup Guide

---

## How It Works

```
Customer calls → Twilio receives call → audio streams to your server →
Deepgram transcribes speech → Claude generates response →
Twilio speaks it back with a natural voice
```

**Sofia** is your bilingual AI receptionist. She:
- Answers in English or Spanish automatically
- Knows the full Tacos 203 menu
- Takes orders, confirms "con todo" vs "plain"
- Gives totals and confirms orders

---

## Step 1 — Get Your API Keys

### Twilio (phone number + call handling)
1. Sign up at https://twilio.com
2. Buy a phone number (~$1/month)
3. Copy your **Account SID** and **Auth Token** from the dashboard

### Deepgram (speech-to-text)
1. Sign up at https://deepgram.com
2. Go to API Keys → Create a new key
3. Copy the key (free tier includes $200 credits)

### Anthropic (Claude AI)
1. Go to https://console.anthropic.com
2. API Keys → Create new key
3. Copy the key

---

## Step 2 — Deploy the Server

You need a public HTTPS URL. Use **Railway** (easiest) or **Render**.

### Option A: Railway (recommended, ~$5/month)
```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and deploy
railway login
railway init
railway up
```
Railway will give you a URL like: `https://tacos203.up.railway.app`

### Option B: Render (free tier available)
1. Push code to GitHub
2. Go to https://render.com → New Web Service
3. Connect your repo, set build command: `npm install`
4. Set start command: `npm start`

### Option C: Local testing with ngrok
```bash
# Install ngrok at https://ngrok.com
ngrok http 3000
# Use the https URL it gives you
```

---

## Step 3 — Configure Environment Variables

Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

On Railway/Render, add these as environment variables in the dashboard:
- `ANTHROPIC_API_KEY`
- `DEEPGRAM_API_KEY`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `PORT=3000`

---

## Step 4 — Install & Run

```bash
npm install
npm start
```

You should see:
```
🌮 Tacos 203 AI Receptionist running on port 3000
```

---

## Step 5 — Connect Twilio to Your Server

1. Go to **Twilio Console → Phone Numbers → Manage → Active Numbers**
2. Click your phone number
3. Under **Voice & Fax → A Call Comes In**:
   - Set to: **Webhook**
   - URL: `https://YOUR-DOMAIN/incoming-call`
   - Method: **HTTP POST**
4. Save

---

## Step 6 — Test It!

Call your Twilio number. Sofia will answer and say:
> *"Hi! Thanks for calling Tacos 203. I'm Sofia, how can I help you today? ¡También puedo ayudarte en español!"*

Try asking:
- "What tacos do you have?"
- "¿Tienen opciones vegetarianas?"
- "I want 2 al pastor tacos con todo and a birria taco plain"

---

## Cost Estimate (per month)

| Service | Cost |
|---------|------|
| Twilio phone number | ~$1/month |
| Twilio per-minute calls | ~$0.013/min inbound |
| Deepgram transcription | ~$0.0043/min (free $200 credit) |
| Claude API | ~$0.003 per call avg |
| Railway hosting | ~$5/month |
| **Total** | **~$6–10/month** |

---

## Customization

### Change Sofia's voice
In `server.js`, find `Polly.Lupe-Neural` (Spanish) and `Polly.Joanna-Neural` (English).
Available Twilio voices: https://www.twilio.com/docs/voice/tts

### Add hours / location response
Add to the system prompt in `server.js`:
```
RESTAURANT INFO:
- Address: [your address]
- Hours: Mon-Sun 11am-10pm
- Phone: [your number]
```

### Add a hold message or music
In the `/incoming-call` webhook, replace the `<Say>` with `<Play>` to play an MP3.

---

## Troubleshooting

**No audio / silence on call**
- Check that your server URL is HTTPS (not HTTP)
- Verify Twilio webhook URL is correct

**Sofia doesn't understand Spanish**
- Deepgram `language: 'multi'` handles both — no changes needed

**Error: Cannot read callSid**
- Make sure Twilio Media Streams are enabled on your account

---

## Support

For issues, check:
- Twilio logs: https://console.twilio.com/us1/monitor/logs/calls
- Deepgram dashboard: https://console.deepgram.com
- Your server logs in Railway/Render
