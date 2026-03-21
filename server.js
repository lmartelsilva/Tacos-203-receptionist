const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');

require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const conversations = {};
const orders = [];
const customers = {};

function escapeXml(str) {
  return str.replace(/&/g,'and').replace(/</g,'').replace(/>/g,'').replace(/"/g,'').replace(/'/g,'').replace(/#/g,'number');
}

function getOrderNumber() {
  return Math.floor(100 + Math.random() * 900).toString();
}

function saveOrder(callSid, phone, name, orderText, orderNumber) {
  var order = { id: orderNumber, callSid: callSid, phone: phone, name: name || 'Guest', order: orderText, time: new Date().toISOString(), status: 'pending' };
  orders.unshift(order);
  if (orders.length > 200) orders.pop();
  if (phone) {
    if (!customers[phone]) customers[phone] = { name: name, orderCount: 0, lastOrder: null, orders: [] };
    customers[phone].name = name || customers[phone].name;
    customers[phone].orderCount++;
    customers[phone].lastOrder = order.time;
    customers[phone].orders.unshift(orderText);
    if (customers[phone].orders.length > 5) customers[phone].orders.pop();
  }
  return order;
}

async function sendSms(toPhone, name, orderSummary, orderNumber) {
  if (!toPhone || !process.env.TWILIO_PHONE_NUMBER) return;
  try {
    await twilioClient.messages.create({
      body: 'Hi ' + (name || 'there') + '! Your Tacos 203 order number ' + orderNumber + ' is confirmed!\n\n' + orderSummary + '\n\nPickup only. See you soon!',
      from: process.env.TWILIO_PHONE_NUMBER,
      to: toPhone
    });
    console.log('SMS sent to ' + toPhone);
  } catch (err) {
    console.error('SMS error:', err.message);
  }
}

function getCustomerContext(phone) {
  if (!phone || !customers[phone] || customers[phone].orderCount === 0) return '';
  var c = customers[phone];
  return 'RETURNING CUSTOMER INFO: Name on file is ' + (c.name || 'unknown') + ', has ordered ' + c.orderCount + ' time(s) before. Last order was: ' + (c.orders[0] || 'unknown') + '. Greet them warmly by name at the start. At the NAME step, ask: "Would you like to use the same name ' + (c.name || '') + ', or a different one?" and use whatever they say.';
}

function buildSystemPrompt(phone) {
  var ctx = getCustomerContext(phone);
  return 'You are Sofia, the warm and friendly AI phone receptionist for Tacos 203, a Mexican fast-food restaurant in Connecticut. You make every customer feel welcome and excited about their food.\n\n' +
(ctx ? ctx + '\n\n' : '') +
'PERSONALITY:\n' +
'- Sound like a real, warm, enthusiastic person. Not a robot.\n' +
'- Use contractions: I\'d, we\'ve, that\'s, don\'t, it\'s, you\'ll.\n' +
'- Be upbeat and friendly but efficient. Keep responses short — max 2 sentences.\n' +
'- Never say Certainly, Absolutely, Of course, Great choice. Use: Sure, Got it, Perfect, Sounds good, Awesome.\n' +
'- ENGLISH ONLY always.\n' +
'- PICKUP ONLY. No delivery. If asked: "We are pickup only, but we would love to see you!"\n\n' +
'CALL FLOW — follow this exact order every call:\n\n' +
'STEP 1 - GREETING: Already done automatically. Do NOT repeat the greeting. Jump straight to taking the order.\n\n' +
'STEP 2 - TAKE THE ORDER:\n' +
'- Let the customer order freely. Repeat each item back naturally as they say it.\n' +
'- For every taco and tacodilla ask: "Would you like that con todo — with cilantro, onions, and salsa — or plain?"\n' +
'- If they seem unsure, suggest: "Our Al Pastor and Steak Birria tacos are super popular!"\n' +
'- Keep energy warm and positive.\n\n' +
'STEP 3 - CONFIRM THE ORDER:\n' +
'Repeat everything clearly: "Alright, so I have [full order list]. Does that sound right?"\n' +
'Wait for confirmation before moving on.\n\n' +
'STEP 4 - UPSELL (once, naturally):\n' +
'After confirmation, suggest ONE thing: "Our TG Wings are amazing — 7 wings in Valentina buffalo sauce. Want to add those?" or "Want to add some churros or street corn on the side?" If they say no, move on immediately.\n\n' +
'STEP 5 - NAME:\n' +
'New customer: "Perfect! What name can I put this order under?"\n' +
'Returning customer: "Would you like to use the same name [name on file], or a different one?"\n\n' +
'STEP 6 - ORDER NUMBER + PICKUP:\n' +
'Generate a random 3 digit number.\n' +
'"Perfect [name]! Your order number is [number] and you will get a text confirmation right now. We are pickup only so we will have everything ready when you get here!"\n\n' +
'STEP 7 - CLOSING:\n' +
'"Thanks so much for calling Tacos 203 — we will see you soon! Have a great day!"\n\n' +
'STEP 8 - OUTPUT after closing (new line):\n' +
'ORDER_COMPLETE|[name]|[full order summary]|[order number]\n\n' +
'ALLERGY INFO:\n' +
'- Gluten free: all tacos on corn tortilla. Tacodillas have flour tortilla — contain gluten.\n' +
'- Dairy: tacodillas have chihuahua cheese. Tacos are dairy free.\n' +
'- Spicy: Chorizo Tacodilla, TG Wings medium heat, Loaded Fries. All salsas NON-spicy.\n' +
'- Vegetarian: Cactus Taco, Cactus Tacodilla, Cheese Tacodilla, Street Corn, Churros.\n' +
'- Pork: Al Pastor, Chorizo, Buche/Tripe, Charro Beans. No shellfish, no nuts.\n\n' +
'MENU:\n' +
'TACOS corn tortilla gluten free. Con todo = cilantro onions salsa. Plain = protein only.\n' +
'- Al Pastor Taco marinated pork 3 ninety-nine\n' +
'- Chorizo Taco sausage 3 ninety-nine\n' +
'- Cactus Taco vegetarian 4 forty-five\n' +
'- Buche/Tripe Taco pork tripe 4 ninety-five\n' +
'- Steak Birria Taco slow-cooked steak 5 forty-five\n\n' +
'TACODILLAS flour tortilla chihuahua cheese gluten and dairy.\n' +
'- Al Pastor Tacodilla 6 fifty\n' +
'- Chorizo Tacodilla spicy 6 fifty\n' +
'- Cactus Tacodilla vegetarian 6 fifty\n' +
'- Buche/Tripe Tacodilla 6 fifty\n' +
'- Steak Birria Tacodilla 6 fifty\n' +
'- Cheese Tacodilla vegetarian 5 dollars\n\n' +
'SNACKS:\n' +
'- Walking Taco corn chips al pastor 6 ninety-nine\n' +
'- Street Corn 6 ninety-nine\n' +
'- TG Wings 7 wings Valentina buffalo sauce blue cheese dip 9 ninety-nine\n' +
'- Charro Beans contains meat 4 ninety-nine\n' +
'- Loaded Fries spicy contains meat 7 dollars\n' +
'- Churros 8 ninety-nine';
}

function buildResponse(text, callSid) {
  var twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna-Neural', language: 'en-US' }, escapeXml(text));
  twiml.pause({ length: 1 });
  twiml.gather({
    input: 'speech',
    action: '/respond?callSid=' + callSid,
    method: 'POST',
    language: 'en-US',
    enhanced: 'true',
    speechTimeout: 'auto',
    timeout: 20,
    actionOnEmptyResult: true,
    hints: 'tacos, taco, birria, pastor, chorizo, cactus, buche, tripe, wings, churros, corn, fries, beans, order, pickup, con todo, plain, yes, no, done, same name, different name, my name is',
  });
  return twiml.toString();
}

app.post('/incoming-call', function(req, res) {
  var callSid = req.body.CallSid;
  var phone = req.body.From || '';
  conversations[callSid] = { messages: [], phone: phone };
  var isReturning = phone && customers[phone] && customers[phone].orderCount > 0 && customers[phone].name;
  var greeting = isReturning
    ? 'Hey ' + customers[phone].name + '! So great to hear from you again at Tacos 203! What are we getting today?'
    : 'Thank you for calling Tacos 203, I am Sofia — what can I get for you today?';
  res.type('text/xml');
  res.send(buildResponse(greeting, callSid));
});

app.post('/respond', async function(req, res) {
  var callSid = req.query.callSid || req.body.CallSid;
  var speech = (req.body.SpeechResult || '').trim();
  if (!conversations[callSid]) conversations[callSid] = { messages: [], phone: req.body.From || '' };
  var conv = conversations[callSid];
  console.log('[' + callSid + '] Customer: "' + speech + '"');
  if (!speech) {
    res.type('text/xml');
    res.send(buildResponse('What can I get for you today?', callSid));
    return;
  }
  conv.messages.push({ role: 'user', content: speech });
  try {
    var response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      system: buildSystemPrompt(conv.phone),
      messages: conv.messages,
    });
    var reply = response.content[0].text.trim();
    if (reply.includes('ORDER_COMPLETE|')) {
      var lines = reply.split('\n');
      var orderLine = lines.find(function(l) { return l.startsWith('ORDER_COMPLETE|'); });
      var spokenReply = lines.filter(function(l) { return !l.startsWith('ORDER_COMPLETE|'); }).join(' ').trim();
      if (orderLine) {
        var parts = orderLine.split('|');
        var customerName = parts[1] || 'Guest';
        var orderSummary = parts[2] || 'Order';
        var orderNumber = parts[3] || getOrderNumber();
        saveOrder(callSid, conv.phone, customerName, orderSummary, orderNumber);
        sendSms(conv.phone, customerName, orderSummary, orderNumber);
        console.log('Order number ' + orderNumber + ' saved for ' + customerName);
        var goodbyeText = spokenReply || 'Thanks so much for calling Tacos 203 — we will see you soon! Have a great day!';
        conv.messages.push({ role: 'assistant', content: goodbyeText });
        var byeTwiml = new twilio.twiml.VoiceResponse();
        byeTwiml.say({ voice: 'Polly.Joanna-Neural', language: 'en-US' }, escapeXml(goodbyeText));
        byeTwiml.pause({ length: 1 });
        byeTwiml.hangup();
        res.type('text/xml');
        res.send(byeTwiml.toString());
        return;
      }
    }
    conv.messages.push({ role: 'assistant', content: reply });
    console.log('[' + callSid + '] Sofia: "' + reply + '"');
    res.type('text/xml');
    res.send(buildResponse(reply, callSid));
  } catch (err) {
    console.error('Error:', err.message);
    res.type('text/xml');
    res.send(buildResponse('Sorry about that, what can I get for you?', callSid));
  }
});

app.get('/no-input', function(req, res) {
  res.type('text/xml');
  res.send(buildResponse('Still there? What can I get for you today?', req.query.callSid));
});

app.get('/api/orders', function(req, res) {
  res.json({ orders: orders.slice(0, 50), total: orders.length });
});

app.post('/api/orders/:id/status', function(req, res) {
  var order = orders.find(function(o) { return o.id === req.params.id; });
  if (order) { order.status = req.body.status; res.json({ success: true }); }
  else res.status(404).json({ error: 'Not found' });
});

app.get('/api/stats', function(req, res) {
  var today = new Date().toDateString();
  var weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  res.json({
    todayCount: orders.filter(function(o) { return new Date(o.time).toDateString() === today; }).length,
    weekCount: orders.filter(function(o) { return new Date(o.time) >= weekAgo; }).length,
    totalCount: orders.length,
    returningCustomers: Object.values(customers).filter(function(c) { return c.orderCount > 1; }).length,
    totalCustomers: Object.keys(customers).length,
  });
});

app.get('/dashboard', function(req, res) {
  res.type('text/html');
  res.send('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Tacos 203 Orders</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#1a0a02;color:#f5f0e8}.topbar{background:#C85A1E;padding:14px 24px;display:flex;align-items:center;justify-content:space-between}.topbar h1{font-size:20px;font-weight:700;color:#fff}.topbar p{font-size:12px;color:rgba(255,255,255,0.8)}.dot{width:8px;height:8px;border-radius:50%;background:#4ade80;display:inline-block;margin-right:6px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:20px 24px}.stat{background:#2a1208;border-radius:10px;padding:16px;border:1px solid #3a1a08}.stat-label{font-size:11px;color:#a08060;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}.stat-val{font-size:32px;font-weight:700;color:#E8A820}.main{padding:0 24px 24px}.sec{font-size:13px;font-weight:600;color:#c8a04a;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}.list{display:flex;flex-direction:column;gap:8px}.card{background:#2a1208;border:1px solid #3a1a08;border-radius:10px;padding:14px 16px;display:flex;align-items:center;gap:16px}.card.pending{border-left:3px solid #E8A820}.card.ready{border-left:3px solid #4ade80}.card.done{border-left:3px solid #555;opacity:0.6}.num{font-size:22px;font-weight:700;color:#C85A1E;min-width:50px}.info{flex:1}.name{font-size:15px;font-weight:600}.items{font-size:13px;color:#a08060;margin-top:3px}.time{font-size:12px;color:#666;margin-top:3px}.actions{display:flex;gap:8px}.btn{font-size:12px;padding:6px 14px;border-radius:20px;border:none;cursor:pointer;font-weight:600}.btn-r{background:#E8A820;color:#1a0a02}.btn-d{background:#2a3a2a;color:#4ade80;border:1px solid #4ade80}.empty{text-align:center;padding:40px;color:#555;font-size:14px}.badge{font-size:11px;background:#3a1a08;color:#c8a04a;padding:2px 8px;border-radius:10px;margin-left:8px}</style></head><body><div class="topbar"><div><h1>Tacos 203 - Live Orders</h1><p><span class="dot"></span>Sofia AI active</p></div><div style="text-align:right;font-size:12px;color:rgba(255,255,255,0.7)" id="clk"></div></div><div class="stats"><div class="stat"><div class="stat-label">Today</div><div class="stat-val" id="st">0</div></div><div class="stat"><div class="stat-label">This Week</div><div class="stat-val" id="sw">0</div></div><div class="stat"><div class="stat-label">Total</div><div class="stat-val" id="sa">0</div></div><div class="stat"><div class="stat-label">Returning</div><div class="stat-val" id="sr">0</div></div></div><div class="main"><div class="sec">Live Orders</div><div class="list" id="list"><div class="empty">No orders yet - Sofia is ready!</div></div></div><script>function fmt(d){return new Date(d).toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",hour12:true})}function mark(id,s){fetch("/api/orders/"+id+"/status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:s})}).then(function(){load()})}function load(){Promise.all([fetch("/api/orders"),fetch("/api/stats")]).then(function(r){return Promise.all(r.map(function(x){return x.json()}))}).then(function(d){var o=d[0],s=d[1];document.getElementById("st").textContent=s.todayCount;document.getElementById("sw").textContent=s.weekCount;document.getElementById("sa").textContent=s.totalCount;document.getElementById("sr").textContent=s.returningCustomers;var l=document.getElementById("list");if(!o.orders||!o.orders.length){l.innerHTML="<div class=\'empty\'>No orders yet - Sofia is ready!</div>";return}l.innerHTML=o.orders.map(function(x){var a="";if(x.status==="pending")a="<button class=\'btn btn-r\' onclick=\'mark(\\""+x.id+"\\",\\"ready\\")\'>Ready</button>";else if(x.status==="ready")a="<button class=\'btn btn-d\' onclick=\'mark(\\""+x.id+"\\",\\"done\\")\'>Done</button>";else a="<span style=\'color:#4ade80;font-size:12px\'>Done</span>";return"<div class=\'card "+x.status+"\'><div class=\'num\'>#"+x.id+"</div><div class=\'info\'><div class=\'name\'>"+x.name+"<span class=\'badge\'>"+(x.phone||"")+"</span></div><div class=\'items\'>"+x.order+"</div><div class=\'time\'>"+fmt(x.time)+"</div></div><div class=\'actions\'>"+a+"</div></div>"}).join("")}).catch(function(e){console.log(e)})}setInterval(load,5000);load();setInterval(function(){document.getElementById("clk").textContent=new Date().toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:true})},1000)</script></body></html>');
});

app.get('/health', function(req, res) {
  res.json({ status: 'ok', service: 'Tacos 203 Pro' });
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Tacos 203 Pro running on port ' + PORT); });
