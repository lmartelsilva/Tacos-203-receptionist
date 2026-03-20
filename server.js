const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');

require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  const order = { id: orderNumber, callSid, phone, name: name || 'Guest', order: orderText, time: new Date().toISOString(), status: 'pending' };
  orders.unshift(order);
  if (orders.length > 200) orders.pop();
  if (phone) {
    if (!customers[phone]) customers[phone] = { name, orderCount: 0, lastOrder: null, orders: [] };
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
      body: 'Hi ' + (name || 'there') + '! Your Tacos 203 order #' + orderNumber + ' is confirmed!\n\n' + orderSummary + '\n\nPickup only. See you soon!',
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
  const c = customers[phone];
  return 'RETURNING CUSTOMER: Name is ' + (c.name || 'unknown') + ', ordered ' + c.orderCount + ' time(s) before. Last order: ' + (c.orders[0] || 'unknown') + '. Greet them warmly by name.';
}

function buildSystemPrompt(phone) {
  const ctx = getCustomerContext(phone);
  return 'You are Sofia, the AI phone receptionist for Tacos 203, a Mexican fast-food restaurant in Connecticut.\n\n' + (ctx ? ctx + '\n\n' : '') +
'CALL FLOW:\n' +
'STEP 1 - GREETING: If returning customer: "Hey [name]! Great to hear from you again, I am Sofia. What can I get for you today?" If new: "Hi! Thanks for calling Tacos 203, my name is Sofia. Are you ready for some tacos today? ... What can I get for you?"\n' +
'STEP 2 - ORDER: Repeat items back, ask con todo or plain for each taco and tacodilla.\n' +
'STEP 3 - UPSELL once: Suggest TG Wings, churros, or street corn naturally. If declined, move on.\n' +
'STEP 4 - CONFIRM: "Alright, I have: [full order]. Did I get everything right?"\n' +
'STEP 5 - NAME: "Perfect! May I have your name for the order?"\n' +
'STEP 6 - ORDER NUMBER: Generate a random 3 digit number. "Great [name], your order number is [number]. You will get a text confirmation. We are pickup only!"\n' +
'STEP 7 - CLOSE: "Thanks for calling Tacos 203, we will see you soon!"\n' +
'STEP 8 - AFTER CLOSING output exactly: ORDER_COMPLETE|[name]|[full order summary]|[order number]\n\n' +
'RULES: English only. Max 2 sentences. Sound human, use contractions. Never say Certainly/Absolutely/Of course. Pickup only, no delivery.\n\n' +
'ALLERGIES: Gluten free: tacos on corn tortilla. Tacodillas have flour tortilla. Dairy: tacodillas have chihuahua cheese. Spicy: Chorizo Tacodilla, TG Wings medium, Loaded Fries. All salsas non-spicy. Vegetarian: Cactus Taco, Cactus Tacodilla, Cheese Tacodilla, Street Corn, Churros. Pork: Al Pastor, Chorizo, Buche/Tripe, Charro Beans.\n\n' +
'MENU:\nTACOS - corn tortilla, gluten free. Con todo = cilantro onions salsa. Plain = protein only.\n- Al Pastor Taco: marinated pork - 3 ninety-nine\n- Chorizo Taco: sausage - 3 ninety-nine\n- Cactus Taco: vegetarian - 4 forty-five\n- Buche/Tripe Taco: pork tripe - 4 ninety-five\n- Steak Birria Taco: slow-cooked steak - 5 forty-five\n\nTACODILLAS - flour tortilla + chihuahua cheese.\n- Al Pastor Tacodilla - 6 fifty\n- Chorizo Tacodilla: spicy - 6 fifty\n- Cactus Tacodilla: vegetarian - 6 fifty\n- Buche/Tripe Tacodilla - 6 fifty\n- Steak Birria Tacodilla - 6 fifty\n- Cheese Tacodilla: vegetarian - 5 dollars\n\nSNACKS:\n- Walking Taco: corn chips with al pastor - 6 ninety-nine\n- Street Corn - 6 ninety-nine\n- TG Wings: 7 wings Valentina buffalo sauce blue cheese dip - 9 ninety-nine\n- Charro Beans: contains meat - 4 ninety-nine\n- Loaded Fries: spicy contains meat - 7 dollars\n- Churros - 8 ninety-nine';
}

function buildResponse(text, callSid) {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna-Neural', language: 'en-US' }, escapeXml(text));
  const gather = twiml.gather({
    input: 'speech',
    action: '/respond?callSid=' + callSid,
    method: 'POST',
    language: 'en-US',
    enhanced: 'true',
    speechTimeout: 'auto',
    timeout: 15,
    hints: 'tacos, taco, birria, pastor, chorizo, cactus, buche, tripe, wings, churros, corn, fries, beans, order, pickup, con todo, plain, yes, no, done, my name is',
  });
  gather.pause({ length: 1 });
  twiml.redirect('/no-input?callSid=' + callSid);
  return twiml.toString();
}

app.post('/incoming-call', (req, res) => {
  const callSid = req.body.CallSid;
  const phone = req.body.From || '';
  conversations[callSid] = { messages: [], phone, orderNumber: null, customerName: null };
  const isReturning = phone && customers[phone] && customers[phone].orderCount > 0 && customers[phone].name;
  const greeting = isReturning
    ? 'Hey ' + customers[phone].name + '! Great to hear from you again at Tacos 203. What can I get for you today?'
    : 'Hi! Thanks for calling Tacos 203, my name is Sofia. Are you ready for some tacos today? ... What can I get for you?';
  res.type('text/xml');
  res.send(buildResponse(greeting, callSid));
});

app.post('/respond', async (req, res) => {
  const callSid = req.query.callSid || req.body.CallSid;
  const speech = (req.body.SpeechResult || '').trim();
  if (!conversations[callSid]) conversations[callSid] = { messages: [], phone: req.body.From || '', orderNumber: null, customerName: null };
  const conv = conversations[callSid];
  console.log('[' + callSid + '] Customer: "' + speech + '"');

  if (!speech) {
    res.type('text/xml');
    res.send(buildResponse('What can I get for you today?', callSid));
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

    if (reply.includes('ORDER_COMPLETE|')) {
      const lines = reply.split('\n');
      const orderLine = lines.find(function(l) { return l.startsWith('ORDER_COMPLETE|'); });
      const spokenReply = lines.filter(function(l) { return !l.startsWith('ORDER_COMPLETE|'); }).join(' ').trim();
      if (orderLine) {
        const parts = orderLine.split('|');
        const customerName = parts[1] || 'Guest';
        const orderSummary = parts[2] || 'Order';
        const orderNumber = parts[3] || getOrderNumber();
        saveOrder(callSid, conv.phone, customerName, orderSummary, orderNumber);
        await sendSms(conv.phone, customerName, orderSummary, orderNumber);
        console.log('Order #' + orderNumber + ' saved for ' + customerName);
        reply = spokenReply || 'Thanks for calling Tacos 203, we will see you soon!';
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
  const callSid = req.query.callSid;
  res.type('text/xml');
  res.send(buildResponse('Still there? What can I get for you today?', callSid));
});

app.get('/api/orders', function(req, res) {
  res.json({ orders: orders.slice(0, 50), total: orders.length });
});

app.post('/api/orders/:id/status', function(req, res) {
  const order = orders.find(function(o) { return o.id === req.params.id; });
  if (order) { order.status = req.body.status; res.json({ success: true, order }); }
  else res.status(404).json({ error: 'Not found' });
});

app.get('/api/stats', function(req, res) {
  const today = new Date().toDateString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  res.json({
    todayCount: orders.filter(function(o) { return new Date(o.time).toDateString() === today; }).length,
    weekCount: orders.filter(function(o) { return new Date(o.time) >= weekAgo; }).length,
    totalCount: orders.length,
    returningCustomers: Object.values(customers).filter(function(c) { return c.orderCount > 1; }).length,
    totalCustomers: Object.keys(customers).length,
  });
});

app.get('/dashboard', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/health', function(req, res) {
  res.json({ status: 'ok', service: 'Tacos 203 AI Receptionist Pro' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Tacos 203 Pro running on port ' + PORT); });
