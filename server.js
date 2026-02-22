const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ─────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────
const TWILIO_ACCOUNT_SID  = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN   = process.env.TWILIO_AUTH_TOKEN;
const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY;
const PORT                = process.env.PORT || 3000;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'whatsapp-bot-6a12f';
const FIREBASE_API_KEY    = process.env.FIREBASE_API_KEY    || 'AIzaSyBqO5_NAA924fi9quruMk1_NdgZIcLyXsM';

const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const sessions  = {};

function getSession(phone) {
  if (!sessions[phone]) sessions[phone] = { history: [] };
  return sessions[phone];
}

// ─────────────────────────────────────────
// FIRESTORE CONVERTERS
// ─────────────────────────────────────────
function fromFS(fields) {
  if (!fields) return {};
  const obj = {};
  for (const [k, v] of Object.entries(fields)) {
    if ('stringValue'  in v) obj[k] = v.stringValue;
    else if ('integerValue' in v) obj[k] = parseInt(v.integerValue);
    else if ('doubleValue'  in v) obj[k] = v.doubleValue;
    else if ('booleanValue' in v) obj[k] = v.booleanValue;
    else if ('nullValue'    in v) obj[k] = null;
    else if ('mapValue'     in v) obj[k] = fromFS(v.mapValue.fields);
  }
  return obj;
}

function toFS(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string')        fields[k] = { stringValue: v };
    else if (typeof v === 'number')   fields[k] = { integerValue: String(Math.round(v)) };
    else if (typeof v === 'boolean')  fields[k] = { booleanValue: v };
    else if (typeof v === 'object')   fields[k] = { mapValue: { fields: toFS(v) } };
  }
  return fields;
}

// ─────────────────────────────────────────
// FIRESTORE REST CALLS
// ─────────────────────────────────────────
async function fsGet(path) {
  const url = `${FS_BASE}/${path}?key=${FIREBASE_API_KEY}`;
  const res  = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = await res.text();
    console.error(`fsGet FAILED [${res.status}] ${path}:`, err);
    return null;
  }
  const data = await res.json();
  return fromFS(data.fields);
}

async function fsPatch(path, obj) {
  const fields     = toFS(obj);
  const maskParams = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const url        = `${FS_BASE}/${path}?${maskParams}&key=${FIREBASE_API_KEY}`;
  const res        = await fetch(url, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ fields })
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`fsPatch FAILED [${res.status}] ${path}:`, err);
  }
  return res.ok;
}

async function fsList(col) {
  const url = `${FS_BASE}/${col}?key=${FIREBASE_API_KEY}`;
  const res  = await fetch(url);
  if (!res.ok) {
    const err = await res.text();
    console.error(`fsList FAILED [${res.status}] ${col}:`, err);
    return [];
  }
  const data = await res.json();
  if (!data.documents) return [];
  return data.documents.map(d => ({ id: d.name.split('/').pop(), ...fromFS(d.fields) }));
}

async function fsDelete(path) {
  const url = `${FS_BASE}/${path}?key=${FIREBASE_API_KEY}`;
  const res  = await fetch(url, { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.text();
    console.error(`fsDelete FAILED [${res.status}] ${path}:`, err);
  }
  return res.ok;
}

// ─────────────────────────────────────────
// DATA HELPERS
// ─────────────────────────────────────────
async function getMeta() {
  const d = await fsGet('valorhousing/meta');
  return d || { tenants: 0, totalUnits: 0 };
}

async function saveMeta(data) {
  const ok = await fsPatch('valorhousing/meta', data);
  console.log('saveMeta:', ok ? 'OK' : 'FAILED', data);
}

async function getVoids() {
  return await fsList('valorhousing_voids');
}

async function saveVoid(v) {
  const id = (v.address + '_' + (v.unit || '')).replace(/\s+/g, '_').toLowerCase().replace(/[^a-z0-9_]/g, '');
  v.id = id;
  const ok = await fsPatch(`valorhousing_voids/${id}`, v);
  console.log('saveVoid:', ok ? 'OK' : 'FAILED', id);
}

async function updateVoidStatus(address, status) {
  const voids = await getVoids();
  for (const v of voids) {
    if (v.address.toLowerCase().includes(address.toLowerCase())) {
      await fsPatch(`valorhousing_voids/${v.id}`, { ...v, status });
      console.log('updateVoidStatus OK:', v.id, '->', status);
    }
  }
}

async function deleteVoid(address) {
  const voids = await getVoids();
  for (const v of voids) {
    if (v.address.toLowerCase().includes(address.toLowerCase())) {
      await fsDelete(`valorhousing_voids/${v.id}`);
      console.log('deleteVoid OK:', v.id);
    }
  }
}

// ─────────────────────────────────────────
// JSON EXTRACTOR
// ─────────────────────────────────────────
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
  const raw   = text.slice(brace, i + 1);
  const clean = raw.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(clean); } catch(e) { console.error('JSON parse error:', raw, e); return null; }
}

// ─────────────────────────────────────────
// PROCESS DATA UPDATE
// ─────────────────────────────────────────
async function processUpdate(text) {
  const parsed = extractJSON(text);
  if (!parsed) return;
  console.log('processUpdate action:', parsed.action, parsed.data);

  const { action, data } = parsed;
  const meta = await getMeta();
  let { tenants = 0, totalUnits = 0 } = meta;

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

// ─────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────
const SYSTEM_PROMPT = `You are the Void Management Bot for Valor Housing, a professional WhatsApp assistant for property management staff.

Your job:
1. Manage void (vacant) property data — add, update, remove voids.
2. Track tenant numbers and occupancy.
3. Answer staff queries clearly and professionally.

Void fields: address, unit (optional), dateVacated, reason (optional), reLetDate (optional), status (optional — defaults to Vacant).
Tenant tracking: Occupancy rate = (tenants / totalUnits) x 100.

Rules:
- Confirm every update clearly.
- Only ask follow-up questions if address or dateVacated are missing.
- Never delete data unless explicitly instructed.
- Short, structured, professional replies formatted for WhatsApp.
- Use bullet points for lists. Always include totals in summaries.
- Use *bold* for WhatsApp emphasis.

DATA SYNC: At the END of every response that changes data, output exactly one line:
DATA_UPDATE:{"action":"...","data":{...}}

Actions: add_void | update_void | remove_void | move_in | move_out | set_total_units
Omit DATA_UPDATE for read-only queries.

add_void fields: address, unit, dateVacated, reason, reLetDate, status
update_void fields: address, status
remove_void fields: address
move_in/move_out fields: count
set_total_units fields: total

Current DB state is in [brackets] at the end of each message.`;

function cleanReply(text) {
  return text.replace(/DATA_UPDATE:\s*\{[\s\S]*?\}\s*/g, '').trim();
}

// ─────────────────────────────────────────
// HEALTH CHECK — also tests Firebase
// ─────────────────────────────────────────
app.get('/', async (req, res) => {
  const meta  = await getMeta();
  const voids = await getVoids();
  res.json({
    status:    'Void Management Bot is running ✅',
    firebase:  meta !== null ? 'connected ✅' : 'ERROR ❌',
    meta,
    voidCount: voids.length,
    timestamp: new Date().toISOString()
  });
});

// ─────────────────────────────────────────
// WEBHOOK
// ─────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  try {
    const incomingMsg = req.body.Body?.trim();
    const from        = req.body.From;

    if (!incomingMsg) {
      twiml.message('Please send a text message.');
      return res.type('text/xml').send(twiml.toString());
    }

    console.log(`Message from ${from}: ${incomingMsg}`);

    const meta  = await getMeta();
    const voids = await getVoids();
    const ctx   = `${incomingMsg}\n\n[DB: tenants=${meta.tenants||0}, totalUnits=${meta.totalUnits||0}, voids=${JSON.stringify(voids)}]`;

    const session = getSession(from);
    session.history.push({ role: 'user', content: ctx });
    if (session.history.length > 20) session.history = session.history.slice(-20);

    const response = await anthropic.messages.create({
      model:    'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system:   SYSTEM_PROMPT,
      messages: session.history
    });

    const reply = response.content[0].text;
    session.history.push({ role: 'assistant', content: reply });

    console.log('Claude reply:', reply.slice(0, 200));

    await processUpdate(reply);

    twiml.message(cleanReply(reply));

  } catch (err) {
    console.error('Webhook error:', err);
    twiml.message('Sorry, something went wrong. Please try again.');
  }

  res.type('text/xml').send(twiml.toString());
});

app.listen(PORT, () => console.log(`🚀 Bot running on port ${PORT}`));
