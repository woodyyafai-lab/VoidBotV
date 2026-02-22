const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const admin = require('firebase-admin');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ─────────────────────────────────────────────
// CONFIG — set these as environment variables
// ─────────────────────────────────────────────
const TWILIO_ACCOUNT_SID  = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN   = process.env.TWILIO_AUTH_TOKEN;
const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY;
const PORT                = process.env.PORT || 3000;

// Firebase service account JSON stored as an env variable
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : null;

// ─────────────────────────────────────────────
// FIREBASE INIT
// ─────────────────────────────────────────────
let db = null;
if (FIREBASE_SERVICE_ACCOUNT) {
  admin.initializeApp({
    credential: admin.credential.cert(FIREBASE_SERVICE_ACCOUNT)
  });
  db = admin.firestore();
  console.log('✅ Firebase connected');
} else {
  console.warn('⚠️  Firebase not configured — running without persistence');
}

// ─────────────────────────────────────────────
// ANTHROPIC CLIENT
// ─────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─────────────────────────────────────────────
// IN-MEMORY STORE (per phone number session)
// ─────────────────────────────────────────────
const sessions = {};

function getSession(phone) {
  if (!sessions[phone]) {
    sessions[phone] = { history: [] };
  }
  return sessions[phone];
}

// ─────────────────────────────────────────────
// FIREBASE HELPERS
// ─────────────────────────────────────────────
async function getMeta() {
  if (!db) return { tenants: 0, totalUnits: 0 };
  try {
    const snap = await db.collection('valorhousing').doc('meta').get();
    return snap.exists ? snap.data() : { tenants: 0, totalUnits: 0 };
  } catch(e) { return { tenants: 0, totalUnits: 0 }; }
}

async function saveMeta(data) {
  if (!db) return;
  try { await db.collection('valorhousing').doc('meta').set(data, { merge: true }); }
  catch(e) { console.error('saveMeta error', e); }
}

async function getVoids() {
  if (!db) return [];
  try {
    const snap = await db.collection('valorhousing_voids').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch(e) { return []; }
}

async function saveVoid(v) {
  if (!db) return;
  try {
    const id = (v.address + '_' + (v.unit || '')).replace(/\s+/g, '_').toLowerCase();
    v.id = id;
    await db.collection('valorhousing_voids').doc(id).set(v, { merge: true });
  } catch(e) { console.error('saveVoid error', e); }
}

async function updateVoidStatus(address, status) {
  if (!db) return;
  try {
    const snap = await db.collection('valorhousing_voids').get();
    const batch = db.batch();
    snap.docs.forEach(d => {
      if (d.data().address.toLowerCase().includes(address.toLowerCase())) {
        batch.update(d.ref, { status });
      }
    });
    await batch.commit();
  } catch(e) { console.error('updateVoidStatus error', e); }
}

async function deleteVoid(address) {
  if (!db) return;
  try {
    const snap = await db.collection('valorhousing_voids').get();
    const batch = db.batch();
    snap.docs.forEach(d => {
      if (d.data().address.toLowerCase().includes(address.toLowerCase())) {
        batch.delete(d.ref);
      }
    });
    await batch.commit();
  } catch(e) { console.error('deleteVoid error', e); }
}

// ─────────────────────────────────────────────
// JSON EXTRACTOR (robust)
// ─────────────────────────────────────────────
function extractJSON(text) {
  const start = text.indexOf('DATA_UPDATE:');
  if (start === -1) return null;
  const brace = text.indexOf('{', start);
  if (brace === -1) return null;
  let depth = 0, i = brace;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) break; }
  }
  const raw = text.slice(brace, i + 1);
  const clean = raw.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(clean); } catch(e) { return null; }
}

// ─────────────────────────────────────────────
// PROCESS DATA UPDATE
// ─────────────────────────────────────────────
async function processUpdate(text) {
  const parsed = extractJSON(text);
  if (!parsed) return;

  const { action, data } = parsed;
  const meta = await getMeta();
  let tenants    = meta.tenants    || 0;
  let totalUnits = meta.totalUnits || 0;

  if (action === 'add_void') {
    const v = {
      address:     data.address    || 'Unknown',
      unit:        data.unit       || '',
      dateVacated: data.dateVacated|| 'N/A',
      reason:      data.reason     || '',
      reLetDate:   data.reLetDate  || '',
      status:      data.status     || 'Vacant',
      addedAt:     new Date().toISOString()
    };
    await saveVoid(v);

  } else if (action === 'update_void') {
    await updateVoidStatus(data.address, data.status);

  } else if (action === 'remove_void') {
    await deleteVoid(data.address);

  } else if (action === 'move_in') {
    tenants += (data.count || 1);
    if (totalUnits < tenants) totalUnits = tenants;
    await saveMeta({ tenants, totalUnits });

  } else if (action === 'move_out') {
    tenants = Math.max(0, tenants - (data.count || 1));
    await saveMeta({ tenants, totalUnits });

  } else if (action === 'set_total_units') {
    await saveMeta({ tenants, totalUnits: data.total || 0 });
  }
}

// ─────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────
const SYSTEM_PROMPT = `You are the Void Management Bot for Valor Housing, a professional WhatsApp assistant for property management staff.

Your job:
1. Manage void (vacant) property data — add, update, remove voids.
2. Track tenant numbers and occupancy.
3. Answer staff queries clearly and professionally.

Void fields: address, unit (optional), dateVacated, reason (optional), reLetDate (optional), status (optional — defaults to Vacant).

Tenant tracking: record total units and occupied units. Occupancy rate = (tenants / totalUnits) × 100.

Rules:
- Confirm every update clearly.
- Only ask follow-up questions if address or dateVacated are missing. Reason and status are optional.
- Never delete data unless explicitly instructed.
- Short, structured, professional replies formatted for WhatsApp.
- Use bullet points for lists. Always include totals in summaries.
- Use *bold* for emphasis (WhatsApp markdown).

DATA SYNC — at the END of every response that changes data, output exactly one line:
DATA_UPDATE:{"action":"...","data":{...}}

Actions: add_void | update_void | remove_void | move_in | move_out | set_total_units
Omit DATA_UPDATE entirely for read-only queries.

Fields per action:
- add_void: address, unit, dateVacated, reason, reLetDate, status
- update_void: address, status
- remove_void: address
- move_in / move_out: count
- set_total_units: total

Current DB state is appended to every user message in [brackets].`;

// ─────────────────────────────────────────────
// STRIP DATA_UPDATE FROM REPLY
// ─────────────────────────────────────────────
function cleanReply(text) {
  return text.replace(/DATA_UPDATE:\s*\{[\s\S]*?\}\s*/g, '').trim();
}

// ─────────────────────────────────────────────
// MAIN WEBHOOK
// ─────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const incomingMsg = req.body.Body?.trim();
    const from        = req.body.From; // e.g. whatsapp:+447911123456

    if (!incomingMsg) {
      twiml.message('Please send a text message.');
      return res.type('text/xml').send(twiml.toString());
    }

    // Load current DB state
    const meta  = await getMeta();
    const voids = await getVoids();

    // Build context message
    const ctx = `${incomingMsg}\n\n[DB: tenants=${meta.tenants||0}, totalUnits=${meta.totalUnits||0}, voids=${JSON.stringify(voids)}]`;

    // Get or create session
    const session = getSession(from);
    session.history.push({ role: 'user', content: ctx });
    if (session.history.length > 20) session.history = session.history.slice(-20);

    // Call Claude
    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system:     SYSTEM_PROMPT,
      messages:   session.history
    });

    const reply = response.content[0].text;
    session.history.push({ role: 'assistant', content: reply });

    // Process any data updates
    await processUpdate(reply);

    // Send clean reply back via WhatsApp
    twiml.message(cleanReply(reply));

  } catch (err) {
    console.error('Webhook error:', err);
    twiml.message('⚠️ Sorry, something went wrong. Please try again.');
  }

  res.type('text/xml').send(twiml.toString());
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Void Management Bot is running ✅', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 Void Management Bot running on port ${PORT}`);
});
