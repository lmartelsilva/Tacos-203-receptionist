const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');

require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ── In-memory stores (replace with DB later) ─────────────────────────────────
const conversations = {};  // callSid -> messages
const orders = [];          // all orders
const customers = {};       // phone -> { name, orderCount, lastOrder }

// ── Helpers ───────────────────────────────────────────────────────────────────
function escapeXml(str) {
  return str.replace(/&/g,'and').replace(/</g,'').replace(/>/g,'').replace(/"/g,'').replace(/'/g,'').replace(/#/g,'number');
}

function getOrderNumber() {
  return Math.floor(100 + Math.random() * 900).toString();
}

function fmt12(date) {
  return new Date(date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function saveOrder(callSid, customerPhone, customerName, orderText, orderNumber) {
  const order = {
    id: orderNumber,
    callSid,
    phone: customerPhone,
    name: customerName || 'Guest',
    order: orderText,
    time: new Date().toISOString(),
    status: 'pending'
  };
  orders.unshift(order);
  if (orders.length > 200) orders.pop();

  // Update customer memory
  if (customerPhone) {
    if (!customers[customerPhone]) {
      customers[customerPhone] = { name: customerName, orderCount: 0, lastOrder: null, orders: [] };
    }
    customers[customerPhone].name = customerName || customers[customerPhone].name;
    customers[customerPhone].orderCount++;
    customers[customerPhone].lastOrder = order.time;
    customers[customerPhone].orders.unshift(orderText);
    if (customers[customerPhone].orders.length > 5) customers[customerPhone].orders.pop();
  }
  return order;
}

async function sendSmsConfirmation(toPhone, customerName, orderSummary, orderNumber) {
  if (!toPhone || !process.env.TWILIO_PHONE_NUMBER) return;
  try {
    const msg = `Hi ${customerName || 'there'}! Your Tacos 203 order #${orderNumber} has been received!\n\n${orderSummary}\n\nPickup only. See you soon! 🌮`;
    await twilioClient.messages.create({
      body: msg,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: toPhone
    });
    console.log(`SMS sent to ${toPhone}`);
  } catch (err) {
    console.error('SMS error:', err.message);
  }
}

function getCustomerContext(phone) {
  if (!phone || !customers[phone]) return '';
  const c = customers[phone];
  if (c.orderCount === 0) return '';
  return `RETURNING CUSTOMER: This customer has ordered ${c.orderCount} time(s) before. Their name is ${c.name || 'unknown'}. Last order: ${c.orders[0] || 'unknown'}. Greet them warmly by name if you know it and mention you remember them.`;
}

// ── System Prompt ─────────────────────────────────────────────────────────────
function buildSystemPrompt(customerPhone) {
  const customerCtx = getCustomerContext(customerPhone);
  return `You are Sofia, the AI phone receptionist for Tacos 203, a Mexican fast-food restaurant in Connecticut. You are warm, efficient, and human-sounding.

${customerCtx}

CALL FLOW — follow this exact sequence every call:

STEP 1 — GREETING:
If returning customer: "Hey [name]! Great to hear from you again at Tacos 203, I am Sofia. What can I get for you today?"
If new customer: "Hi! Thanks for calling Tacos 203, my name is Sofia. Are you ready for some tacos today? ... What can I get for you?"

STEP 2 — TAKING THE ORDER:
- Repeat items back naturally as they order.
- Ask con todo or plain for every taco and taco'dilla.
- Keep it moving.

STEP 3 — UPSELL (ALWAYS do this once after main order):
- "Our TG Wings are amazing — 7 wings in Valentina buffalo sauce. Want to add those?"
- "Most people grab some churros or street corn on the side — want to add either?"
- Only suggest once. If they say no, move on immediately.

STEP 4 — ORDER CONFIRMATION:
"Alright, I have: [list every item]. Did I get everything right?"
Wait for yes.

STEP 5 — CUSTOMER NAME:
"Perfect! May I have your name for the order?"

STEP 6 — ORDER NUMBER + PICKUP + SMS:
Generate a random 3 digit number.
"Great [name], your order number is [number]. You will also get a text confirmation right now. We are pickup only — see you soon!"

STEP 7 — CLOSING:
"Thanks for calling Tacos 203, we will see you soon!"

STEP 8 — AFTER CLOSING (IMPORTANT):
Once the order is complete and you have the customer name, output this EXACTLY on a new line:
ORDER_COMPLETE|[customer_name]|[full_order_summary]|[order_number]

Example: ORDER_COMPLETE|John|2 Al Pastor Tacos con todo, 1 Steak Birria Taco plain, 1 Street Corn|247

BEHAVIOR RULES:
- ENGLISH ONLY always.
- Max 2 sentences per response.
- Sound human: use contractions.
- NEVER say: Certainly, Absolutely, Of course, Great choice.
- Use: Sure, Got it, No problem, Sounds good, Perfect.
- PICKUP ONLY. No delivery.
- If unsure, suggest Al Pastor Taco, Steak Birria Taco, or TG Wings.

ALLERGY INFO:
- Gluten free: tacos on corn tortilla. Taco'dillas have flour tortilla — contain gluten.
- Dairy: taco'dillas contain chihuahua cheese.
- Spicy: Chorizo Taco'dilla, TG Wings medium, Loaded Fries. All salsas NON-spicy.
- Vegetarian: Cactus Taco, Cactus Taco'dilla, Cheese Taco'dilla, Street Corn, Churros.
- Pork: Al Pastor, Chorizo, Buche/Tripe, Charro Beans. No shellfish, no nuts.

MENU:
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
}

// ── TwiML Builder ─────────────────────────────────────────────────────────────
function buildResponse(text, callSid) {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna-Neural', language: 'en-US' }, escapeXml(text));
  const gather = twiml.gather({
    input: 'speech',
    action: `/respond?callSid=${callSid}`,
    method: 'POST',
    language: 'en-US',
    enhanced: 'true',
    speechTimeout: 'auto',
    timeout: 15,
    hints: 'tacos, taco, birria, pastor, chorizo, cactus, buche, tripe, wings, churros, corn, fries, beans, order, pickup, con todo, plain, yes, no, that is all, done, my name is',
  });
  gather.pause({ length: 1 });
  twiml.redirect(`/no-input?callSid=${callSid}`);
  return twiml.toString();
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.post('/incoming-call', (req, res) => {
  const callSid = req.body.CallSid;
  const callerPhone = req.body.From || '';
  conversations[callSid] = { messages: [], phone: callerPhone, orderNumber: null, customerName: null };
  console.log(`New call: ${callSid} from ${callerPhone}`);

  const isReturning = callerPhone && customers[callerPhone] && customers[callerPhone].orderCount > 0;
  const greeting = isReturning && customers[callerPhone].name
    ? `Hey ${customers[callerPhone].name}! Great to hear from you again at Tacos 203. What can I get for you today?`
    : "Hi! Thanks for calling Tacos 203, my name is Sofia. Are you ready for some tacos today? ... What can I get for you?";

  res.type('text/xml');
  res.send(buildResponse(greeting, callSid));
});

app.post('/respond', async (req, res) => {
  const callSid = req.query.callSid || req.body.CallSid;
  const speech = (req.body.SpeechResult || '').trim();

  if (!conversations[callSid]) conversations[callSid] = { messages: [], phone: req.body.From || '', orderNumber: null, customerName: null };

  const conv = conversations[callSid];
  console.log(`[${callSid}] Customer: "${speech}"`);

  if (!speech) {
    res.type('text/xml');
    res.send(buildResponse("What can I get for you today?", callSid));
    return;
  }

  conv.messages.push({ role: 'user', content: speech });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      system: buildSystemPrompt(conv.phone),
      messages: conv.messages,
    });

    let reply = response.content[0].text.trim();

    // Check for order completion signal
    if (reply.includes('ORDER_COMPLETE|')) {
      const lines = reply.split('\n');
      const orderLine = lines.find(l => l.startsWith('ORDER_COMPLETE|'));
      const spokenReply = lines.filter(l => !l.startsWith('ORDER_COMPLETE|')).join(' ').trim();

      if (orderLine) {
        const parts = orderLine.split('|');
        const customerName = parts[1] || 'Guest';
        const orderSummary = parts[2] || 'Order';
        const orderNumber = parts[3] || getOrderNumber();

        conv.customerName = customerName;
        conv.orderNumber = orderNumber;

        const order = saveOrder(callSid, conv.phone, customerName, orderSummary, orderNumber);
        console.log(`Order saved: #${orderNumber} for ${customerName}`);

        // Send SMS confirmation
        await sendSmsConfirmation(conv.phone, customerName, orderSummary, orderNumber);

        reply = spokenReply || `Thanks for calling Tacos 203, we will see you soon!`;
      }
    }

    conv.messages.push({ role: 'assistant', content: reply });
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

// ── Dashboard API ─────────────────────────────────────────────────────────────
app.get('/api/orders', (req, res) => {
  res.json({ orders: orders.slice(0, 50), total: orders.length });
});

app.post('/api/orders/:id/status', (req, res) => {
  const order = orders.find(o => o.id === req.params.id);
  if (order) {
    order.status = req.body.status;
    res.json({ success: true, order });
  } else {
    res.status(404).json({ error: 'Order not found' });
  }
});

app.get('/api/customers', (req, res) => {
  res.json({ customers, total: Object.keys(customers).length });
});

app.get('/api/stats', (req, res) => {
  const today = new Date().toDateString();
  const todayOrders = orders.filter(o => new Date(o.time).toDateString() === today);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const weekOrders = orders.filter(o => new Date(o.time) >= weekAgo);

  res.json({
    todayCount: todayOrders.length,
    weekCount: weekOrders.length,
    totalCount: orders.length,
    returningCustomers: Object.values(customers).filter(c => c.orderCount > 1).length,
    totalCustomers: Object.keys(customers).length,
  });
});

// ── Dashboard UI ──────────────────────────────────────────────────────────────
app.get('/dashboard', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tacos 203 — Order Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#1a0a02;color:#f5f0e8;min-height:100vh}
.topbar{background:#C85A1E;padding:14px 24px;display:flex;align-items:center;justify-content:space-between}
.topbar h1{font-size:20px;font-weight:700;color:#fff}
.topbar p{font-size:12px;color:rgba(255,255,255,0.8)}
.dot{width:10px;height:10px;border-radius:50%;background:#4ade80;display:inline-block;margin-right:6px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:20px 24px}
.stat{background:#2a1208;border-radius:10px;padding:16px;border:1px solid #3a1a08}
.stat-label{font-size:11px;color:#a08060;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
.stat-val{font-size:32px;font-weight:700;color:#E8A820}
.main{padding:0 24px 24px}
.section-title{font-size:14px;font-weight:600;color:#c8a04a;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
.orders-grid{display:flex;flex-direction:column;gap:8px}
.order-card{background:#2a1208;border:1px solid #3a1a08;border-radius:10px;padding:14px 16px;display:flex;align-items:center;gap:16px}
.order-card.pending{border-left:3px solid #E8A820}
.order-card.ready{border-left:3px solid #4ade80}
.order-card.done{border-left:3px solid #555;opacity:0.6}
.order-num{font-size:22px;font-weight:700;color:#C85A1E;min-width:50px}
.order-info{flex:1}
.order-name{font-size:15px;font-weight:600;color:#f5f0e8}
.order-items{font-size:13px;color:#a08060;margin-top:3px}
.order-time{font-size:12px;color:#666;margin-top:3px}
.order-actions{display:flex;gap:8px}
.btn{font-size:12px;padding:6px 14px;border-radius:20px;border:none;cursor:pointer;font-weight:600}
.btn-ready{background:#E8A820;color:#1a0a02}
.btn-done{background:#2a3a2a;color:#4ade80;border:1px solid #4ade80}
.empty{text-align:center;padding:40px;color:#555;font-size:14px}
.phone-badge{font-size:11px;background:#3a1a08;color:#c8a04a;padding:2px 8px;border-radius:10px;margin-left:8px}
</style>
</head>
<body>
<div class="topbar">
  <div>
    <h1>🌮 Tacos 203 — Live Orders</h1>
    <p><span class="dot"></span>Sofia AI is active — (888) 277-5448</p>
  </div>
  <div style="text-align:right;font-size:12px;color:rgba(255,255,255,0.7)" id="clock"></div>
</div>

<div class="stats">
  <div class="stat"><div class="stat-label">Today</div><div class="stat-val" id="s-today">0</div></div>
  <div class="stat"><div class="stat-label">This Week</div><div class="stat-val" id="s-week">0</div></div>
  <div class="stat"><div class="stat-label">Total Orders</div><div class="stat-val" id="s-total">0</div></div>
  <div class="stat"><div class="stat-label">Return Customers</div><div class="stat-val" id="s-return">0</div></div>
</div>

<div class="main">
  <div class="section-title">Live Orders</div>
  <div class="orders-grid" id="orders-list"><div class="empty">No orders yet — Sofia is ready to take calls!</div></div>
</div>

<script>
function fmt(iso) {
  return new Date(iso).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:true});
}

function statusClass(s) {
  if (s==='ready') return 'ready';
  if (s==='done') return 'done';
  return 'pending';
}

async function markStatus(id, status) {
  await fetch('/api/orders/'+id+'/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});
  load();
}

async function load() {
  const [oRes, sRes] = await Promise.all([fetch('/api/orders'), fetch('/api/stats')]);
  const {orders} = await oRes.json();
  const stats = await sRes.json();

  document.getElementById('s-today').textContent = stats.todayCount;
  document.getElementById('s-week').textContent = stats.weekCount;
  document.getElementById('s-total').textContent = stats.totalCount;
  document.getElementById('s-return').textContent = stats.returningCustomers;

  const list = document.getElementById('orders-list');
  if (!orders.length) {
    list.innerHTML = '<div class="empty">No orders yet — Sofia is ready to take calls!</div>';
    return;
  }
  list.innerHTML = orders.map(o => `
    <div class="order-card ${statusClass(o.status)}">
      <div class="order-num">#${o.id}</div>
      <div class="order-info">
        <div class="order-name">${o.name}<span class="phone-badge">${o.phone||'Unknown'}</span></div>
        <div class="order-items">${o.order}</div>
        <div class="order-time">${fmt(o.time)}</div>
      </div>
      <div class="order-actions">
        ${o.status==='pending'?`<button class="btn btn-ready" onclick="markStatus('${o.id}','ready')">Ready</button>`:''}
        ${o.status==='ready'?`<button class="btn btn-done" onclick="markStatus('${o.id}','done')">Done</button>`:''}
        ${o.status==='done'?`<span style="font-size:12px;color:#4ade80">Completed</span>`:''}
      </div>
    </div>`).join('');
}

setInterval(load, 5000);
load();

setInterval(()=>{
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true});
}, 1000);
</script>
</body>
</html>`);
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'Tacos 203 AI Receptionist Pro' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌮 Tacos 203 Pro running on port ${PORT}`));
