const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ─────────────────────────────────────────────
// CONFIG — set these in Railway Variables tab
// ─────────────────────────────────────────────
const TWILIO_ACCOUNT_SID  = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN   = process.env.TWILIO_AUTH_TOKEN;
const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY;
const PORT                = process.env.PORT || 3000;

// Your Firebase web config values (from the config you already have)
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'whatsapp-bot-6a12f';
const FIREBASE_API_KEY    = process.env.FIREBASE_API_KEY    || 'AIzaSyBqO5_NAA924fi9quruMk1_NdgZIcLyXsM';

// Firestore REST API base URL
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

// ─────────────────────────────────────────────
// ANTHROPIC CLIENT
// ─────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─────────────────────────────────────────────
// IN-MEMORY SESSION STORE (per phone number)
// ─────────────────────────────────────────────
const sessions = {};
function getSession(phone) {
  if (!sessions[phone]) sessions[phone] = { history: [] };
  return sessions[phone];
}

// ─────────────────────────────────────────────
// FIRESTORE REST HELPERS
// ─────────────────────────────────────────────

// Convert Firestore REST format to plain JS object
function fromFirestore(fields) {
  if (!fields) return {};
  const obj = {};
  for (const [key, val] of Object.entries(fields)) {
    if (val.stringValue  !== undefined) obj[key] = val.stringValue;
    else if (val.integerValue !== undefined) obj[key] = parseInt(val.integerValue);
    else if (val.doubleValue  !== undefined) obj[key] = val.doubleValue;
    else if (val.booleanValue !== undefined) obj[key] = val.booleanValue;
    else if (val.nullValue    !== undefined) obj[key] = null;
    else if (val.mapValue     !== undefined) obj[key] = fromFirestore(val.mapValue.fields);
    else obj[key] = JSON.stringify(val);
  }
  return obj;
}

// Convert plain JS object to Firestore REST format
function toFirestore(obj) {
  const fields = {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'string')  fields[key] = { stringValue: val };
    else if (typeof val === 'number') fields[key] = { integerValue: String(Math.round(val)) };
    else if (typeof val === 'boolean') fields[key] = { booleanValue: val };
    else if (val === null) fields[key] = { nullValue: null };
    else if (typeof val === 'object') fields[key] = { mapValue: { fields: toFirestore(val).fields } };
  }
  return { fields };
}

async function fsGet(path) {
  try {
    const res = await fetch(`${FS_BASE}/${path}?key=${FIREBASE_API_KEY}`);
    if (!res.ok) return null;
    const data = await res.json();
    return fromFirestore(data.fields);
  } catch(e) { console.error('fsGet error', e); return null; }
}

async function fsSet(path, obj) {
  try {
    // Build update mask from keys
    const keys = Object.keys(obj).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    const url = `${FS_BASE}/${path}?${keys}&key=${FIREBASE_API_KEY}`;
    await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toFirestore(obj))
    });
  } catch(e) { console.error('fsSet error', e); }
}

async function fsList(collection) {
  try {
    const res = await fetch(`${FS_BASE}/${collection}?key=${FIREBASE_API_KEY}`);
    if (!res.ok) return [];
    const data = await res.json();
    if (!data.documents) return [];
    return data.documents.map(d => ({
      id: d.name.split('/').pop(),
      ...fromFirestore(d.fields)
    }));
  } catch(e) { console.error('fsList error', e); return []; }
}

async function fsDelete(path) {
  try {
    await fetch(`${FS_BASE}/${path}?key=${FIREBASE_API_KEY}`, { method: 'DELETE' });
  } catch(e) { console.error('fsDelete error', e); }
}

// ─────────────────────────────────────────────
// DATA HELPERS
// ─────────────────────────────────────────────
async function getMeta() {
  const data = await fsGet('valorhousing/meta');
  return data || { tenants: 0, totalUnits: 0 };
}

async function saveMeta(data) {
  await fsSet('valorhousing/meta', data);
}

async function getVoids() {
  return await fsList('valorhousing_voids');
}

async function saveVoid(v) {
  const id = (v.address + '_' + (v.unit || '')).replace(/\s+/g, '_').toLowerCase();
  v.id = id;
  await fsSet(`valorhousing_voids/${id}`, v);
}

async function updateVoidStatus(address, status) {
  const voids = await getVoids();
  for (const v of voids) {
    if (v.address.toLowerCase().includes(address.toLowerCase())) {
      await fsSet(`valorhousing_voids/${v.id}`, { ...v, status });
    }
  }
}

async function deleteVoid(address) {
  const voids = await getVoids();
  for (const v of voids) {
    if (v.address.toLowerCase().includes(address.toLowerCase())) {
      await fsDelete(`valorhousing_voids/${v.id}`);
    }
  }
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
    await saveVoid({
      address:     data.address     || 'Unknown',
      unit:        data.unit        || '',
      dateVacated: data.dateVacated || 'N/A',
      reason:      data.reason      || '',
      reLetDate:   data.reLetDate   || '',
      status:      data.status      || 'Vacant',
      addedAt:     new Date().toISOString()
    });
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

Tenant tracking: record total units and occupied units. Occupancy rate = (tenants / totalUnits) x 100.

Rules:
- Confirm every update clearly.
- Only ask follow-up questions if address or dateVacated are missing. Reason and status are optional.
- Never delete data unless explicitly instructed.
- Short, structured, professional replies formatted for WhatsApp.
- Use bullet points for lists. Always include totals in summaries.
- Use *bold* for emphasis (WhatsApp markdown).

DATA SYNC: At the END of every response that changes data, output exactly one line:
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
// CLEAN REPLY
// ─────────────────────────────────────────────
function cleanReply(text) {
  return text.replace(/DATA_UPDATE:\s*\{[\s\S]*?\}\s*/g, '').trim();
}

// ─────────────────────────────────────────────
// WEBHOOK
// ─────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const incomingMsg = req.body.Body?.trim();
    const from        = req.body.From;

    if (!incomingMsg) {
      twiml.message('Please send a text message.');
      return res.type('text/xml').send(twiml.toString());
    }

    const meta  = await getMeta();
    const voids = await getVoids();

    const ctx = `${incomingMsg}\n\n[DB: tenants=${meta.tenants||0}, totalUnits=${meta.totalUnits||0}, voids=${JSON.stringify(voids)}]`;

    const session = getSession(from);
    session.history.push({ role: 'user', content: ctx });
    if (session.history.length > 20) session.history = session.history.slice(-20);

    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system:     SYSTEM_PROMPT,
      messages:   session.history
    });

    const reply = response.content[0].text;
    session.history.push({ role: 'assistant', content: reply });

    await processUpdate(reply);

    twiml.message(cleanReply(reply));

  } catch (err) {
    console.error('Webhook error:', err);
    twiml.message('Sorry, something went wrong. Please try again.');
  }

  res.type('text/xml').send(twiml.toString());
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Void Management Bot is running', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Void Management Bot running on port ${PORT}`);
});
