/**
 * Jabber — single-file web+API server (Render-ready)
 * Features:
 * - Chat (OpenAI)
 * - Memory (SQLite)
 * - Image generation (OpenAI)
 * - Simple web search (DuckDuckGo)
 * - Google Calendar OAuth (create/read/update/delete)
 * - Serves a ChatGPT-like web UI (inline)
 *
 * Env needed on Render:
 *   OPENAI_API_KEY = sk-...
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   OAUTH_REDIRECT = https://YOUR-RENDER-URL/oauth2callback
 */
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const { google } = require('googleapis');

const app = express();
const upload = multer();
app.use(cors());
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const OAUTH_REDIRECT = process.env.OAUTH_REDIRECT || '';

/* ---------- DB ---------- */
const dbDir = path.join(__dirname, 'data');
fs.mkdirSync(dbDir, { recursive: true });
const db = new sqlite3.Database(path.join(dbDir, 'jabber.db'));
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS memories(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT, value TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS messages(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT, content TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT, description TEXT, start TEXT, end TEXT, timezone TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS oauth_tokens(
    id INTEGER PRIMARY KEY CHECK (id=1),
    access_token TEXT, refresh_token TEXT, scope TEXT, token_type TEXT, expiry_date INTEGER
  )`);
  db.get('SELECT id FROM oauth_tokens WHERE id=1', (e, row) => !row && db.run('INSERT INTO oauth_tokens (id) VALUES (1)'));
});

/* ---------- OAuth helpers ---------- */
function getOAuth2Client() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !OAUTH_REDIRECT) return null;
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT);
}
function loadTokens() {
  return new Promise((resolve) => {
    db.get('SELECT * FROM oauth_tokens WHERE id=1', (err, row) => resolve(row || null));
  });
}
function saveTokens(tokens) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE oauth_tokens SET access_token=?, refresh_token=?, scope=?, token_type=?, expiry_date=? WHERE id=1`,
      [tokens.access_token || null, tokens.refresh_token || null, tokens.scope || null, tokens.token_type || null, tokens.expiry_date || null],
      (e) => (e ? reject(e) : resolve())
    );
  });
}
async function getCalendarClient() {
  const o = getOAuth2Client();
  if (!o) throw new Error('Google OAuth not configured');
  const tokens = await loadTokens();
  if (!tokens || !tokens.access_token) throw new Error('Not authenticated with Google. Visit /auth/google');
  o.setCredentials(tokens);
  o.on('tokens', (t) => saveTokens({ ...tokens, ...t }).catch(()=>{}));
  return google.calendar({ version: 'v3', auth: o });
}

/* ---------- UI (inline) ---------- */
const INDEX_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Jabber</title>
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#0b0b0b">
<style>
:root{--bg:#0b0b0b;--panel:#0f1720;--muted:#94a3b8;--accent:#10b981;--text:#e6eef8}
*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#061018,#071426);font-family:Inter,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--text)}
.app{display:flex;height:100vh}.sidebar{width:260px;background:var(--panel);padding:18px;border-right:1px solid rgba(255,255,255,0.05)}
.brand{font-weight:700;font-size:20px;margin-bottom:12px}
.sidebar h4{margin:8px 0;color:var(--muted)}
.sidebar ul{list-style:none;padding:0;margin:0 0 12px;max-height:30vh;overflow:auto}
.sidebar li{padding:6px 8px;border-radius:6px;background:rgba(255,255,255,0.04);margin-bottom:6px;font-size:13px}
.main{flex:1;display:flex;flex-direction:column}
.main-header{display:flex;justify-content:space-between;align-items:center;padding:16px;border-bottom:1px solid rgba(255,255,255,0.05)}
.chat{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.msg{max-width:70%;padding:12px;border-radius:10px;background:rgba(255,255,255,0.06)}
.msg.user{align-self:flex-end;background:linear-gradient(90deg,#085f46,#0ea5a9);color:#fff}
.msg.assistant{align-self:flex-start}
.composer{display:flex;padding:12px;gap:8px;border-top:1px solid rgba(255,255,255,0.05)}
.composer input{flex:1;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);background:transparent;color:var(--text)}
.composer button{padding:8px 12px;border-radius:8px;border:none;background:var(--accent);color:#022c22;cursor:pointer}
.modal{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6)}.modal.hidden{display:none}
.modal-content{background:#081019;padding:18px;border-radius:10px;min-width:320px;max-width:720px}
textarea{width:100%;min-height:80px;background:#071426;color:var(--text);padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.06)}
#imgResults img{max-width:200px;margin:8px;border-radius:6px}
</style>
</head><body>
<div class="app">
  <aside class="sidebar">
    <div class="brand">Jabber</div>
    <div>
      <h4>Memories</h4>
      <ul id="memoryList"></ul>
      <button id="refreshMem">Refresh</button>
    </div>
    <div style="margin-top:14px">
      <h4>Events</h4>
      <ul id="eventList"></ul>
      <button id="refreshEvt">Refresh</button>
      <button id="authGoogle">Connect Google Calendar</button>
    </div>
  </aside>
  <main class="main">
    <header class="main-header">
      <h1>Jabber</h1>
      <div class="controls">
        <button id="voiceBtn">🎤 Speak</button>
        <button id="imgBtn">🖼️ Image</button>
      </div>
    </header>
    <section id="chat" class="chat"></section>
    <form id="composer" class="composer">
      <input id="input" autocomplete="off" placeholder="Say something to Jabber..." />
      <button type="submit">Send</button>
      <button type="button" id="rememberBtn">Remember</button>
      <button type="button" id="scheduleBtn">Schedule</button>
    </form>
  </main>
</div>

<!-- Image modal -->
<div id="imageModal" class="modal hidden">
  <div class="modal-content">
    <h3>Generate Image</h3>
    <textarea id="imgPrompt" placeholder="Describe the image..."></textarea>
    <input id="imgCount" type="number" value="2" min="1" max="4" />
    <button id="genImg">Generate</button>
    <div id="imgResults"></div>
    <button id="closeImg">Close</button>
  </div>
</div>

<!-- Schedule modal -->
<div id="scheduleModal" class="modal hidden">
  <div class="modal-content">
    <h3>Schedule Event</h3>
    <input id="evtTitle" placeholder="Title" />
    <input id="evtStart" type="datetime-local" />
    <input id="evtEnd" type="datetime-local" />
    <textarea id="evtDesc" placeholder="Description"></textarea>
    <button id="saveEvent">Save</button>
    <button id="closeSched">Close</button>
    <button id="saveToGoogle">Save to Google Calendar</button>
  </div>
</div>

<script>
// basic PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js');
}
const chatEl = document.getElementById('chat');
const inputEl = document.getElementById('input');
const composer = document.getElementById('composer');
const rememberBtn = document.getElementById('rememberBtn');
const scheduleBtn = document.getElementById('scheduleBtn');
const memoryList = document.getElementById('memoryList');
const eventList = document.getElementById('eventList');
const refreshMem = document.getElementById('refreshMem');
const refreshEvt = document.getElementById('refreshEvt');
const voiceBtn = document.getElementById('voiceBtn');
const authGoogleBtn = document.getElementById('authGoogle');

const imageModal = document.getElementById('imageModal');
const imgBtn = document.getElementById('imgBtn');
const imgPrompt = document.getElementById('imgPrompt');
const imgCount = document.getElementById('imgCount');
const genImg = document.getElementById('genImg');
const imgResults = document.getElementById('imgResults');
const closeImg = document.getElementById('closeImg');

const scheduleModal = document.getElementById('scheduleModal');
const evtTitle = document.getElementById('evtTitle');
const evtStart = document.getElementById('evtStart');
const evtEnd = document.getElementById('evtEnd');
const evtDesc = document.getElementById('evtDesc');
const saveEvent = document.getElementById('saveEvent');
const closeSched = document.getElementById('closeSched');
const saveToGoogle = document.getElementById('saveToGoogle');

function appendMessage(text, role='assistant') {
  const div = document.createElement('div');
  div.className = 'msg ' + (role==='user' ? 'user' : 'assistant');
  div.innerText = text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}
async function sendChat(message) {
  appendMessage(message, 'user');
  const r = await fetch('/api/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ message }) });
  const data = await r.json();
  appendMessage(data.error ? ('Error: ' + data.error) : data.reply, 'assistant');
  if (data.reply && 'speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance(data.reply); speechSynthesis.cancel(); speechSynthesis.speak(u);
  }
}
composer.addEventListener('submit', (e)=>{ e.preventDefault(); const t=inputEl.value.trim(); if(!t) return; sendChat(t); inputEl.value=''; });

rememberBtn.addEventListener('click', async () => {
  const text = inputEl.value.trim();
  if (!text || !text.includes(':')) return alert('Type memory like: Meetings: mornings before 11am');
  const [key, ...rest] = text.split(':'); const value = rest.join(':').trim();
  await fetch('/api/memories', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ key:key.trim(), value }) });
  inputEl.value=''; loadMemories(); alert('Memory saved.');
});
scheduleBtn.addEventListener('click', () => scheduleModal.classList.remove('hidden'));
closeSched.addEventListener('click', () => scheduleModal.classList.add('hidden'));
saveEvent.addEventListener('click', async () => {
  const title=evtTitle.value.trim(), start=evtStart.value, end=evtEnd.value, desc=evtDesc.value;
  if (!title || !start) return alert('title and start required');
  await fetch('/api/events', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ title, start, end, description:desc }) });
  scheduleModal.classList.add('hidden'); loadEvents(); alert('Saved locally.');
});
saveToGoogle.addEventListener('click', async () => {
  const title=evtTitle.value.trim(), start=evtStart.value, end=evtEnd.value, desc=evtDesc.value;
  if (!title || !start || !end) return alert('title, start, end required');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const r = await fetch('/api/calendar/create', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ title, description:desc, start:new Date(start).toISOString(), end:new Date(end).toISOString(), timezone:tz }) });
  const d = await r.json();
  if (d.error && String(d.error).includes('Not authenticated')) { alert('Connect Google Calendar first.'); return; }
  if (d.error) alert('Error: '+d.error); else { alert('Created on Google Calendar.'); scheduleModal.classList.add('hidden'); }
});
authGoogleBtn.addEventListener('click', ()=> window.location.href='/auth/google');

async function loadMemories(){ const r=await fetch('/api/memories'); const data=await r.json(); memoryList.innerHTML=''; data.forEach(m=>{ const li=document.createElement('li'); li.innerText=m.key+': '+m.value; memoryList.appendChild(li); }); }
async function loadEvents(){ const r=await fetch('/api/events'); const data=await r.json(); eventList.innerHTML=''; data.forEach(e=>{ const li=document.createElement('li'); li.innerText=e.title+' — '+e.start; eventList.appendChild(li); }); }
let rec; if ('webkitSpeechRecognition'in window||'SpeechRecognition'in window){const SR=window.SpeechRecognition||window.webkitSpeechRecognition; rec=new SR(); rec.lang='en-US'; rec.onresult=(e)=>{ const t=e.results[0][0].transcript; inputEl.value=t; sendChat(t); }; }
voiceBtn.addEventListener('click',()=>{ if(!rec) return alert('SpeechRecognition not supported.'); rec.start(); });
loadMemories(); loadEvents(); appendMessage('Hello — I am Jabber. Ask me anything!', 'assistant');
</script>
</body></html>`;

const MANIFEST_JSON = JSON.stringify({
  name: "Jabber",
  short_name: "Jabber",
  start_url: "/",
  display: "standalone",
  background_color: "#0b0b0b",
  theme_color: "#0b0b0b",
  icons: []
});

const SW_JS = `
const CACHE='jabber-cache-v1';
const ASSETS=['/','/manifest.json','/service-worker.js'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)))});
self.addEventListener('fetch',e=>{e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)))});
`;

/* ---------- Static routes ---------- */
app.get('/', (_, res) => res.send(INDEX_HTML));
app.get('/manifest.json', (_, res) => { res.type('application/json').send(MANIFEST_JSON); });
app.get('/service-worker.js', (_, res) => { res.type('text/javascript').send(SW_JS); });

/* ---------- API: Chat ---------- */
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });

    const memSummary = await new Promise(resolve => {
      db.all('SELECT key,value FROM memories ORDER BY id DESC', (e, rows) => {
        if (e) return resolve('');
        resolve(rows.map(r => `${r.key}: ${r.value}`).join('\n'));
      });
    });

    db.run('INSERT INTO messages(role,content) VALUES(?,?)', ['user', message]);

    if (!OPENAI_API_KEY) return res.json({ reply: "Set OPENAI_API_KEY in Render to enable responses." });

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: `You are Jabber. Use this memory to personalize answers:\n${memSummary}` },
          { role: 'user', content: message }
        ],
        max_tokens: 800,
        temperature: 0.7
      })
    });
    const data = await resp.json();
    const reply = data?.choices?.[0]?.message?.content || 'Sorry, I could not respond.';
    db.run('INSERT INTO messages(role,content) VALUES(?,?)', ['assistant', reply]);
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: e.message || 'chat failed' });
  }
});

/* ---------- API: Memories ---------- */
app.post('/api/memories', (req, res) => {
  const { key, value } = req.body || {};
  if (!key || !value) return res.status(400).json({ error: 'key and value required' });
  db.run('INSERT INTO memories(key,value) VALUES(?,?)', [key, value], function (e) {
    if (e) return res.status(500).json({ error: e.message });
    res.json({ id: this.lastID });
  });
});
app.get('/api/memories', (_, res) => {
  db.all('SELECT id,key,value,created_at FROM memories ORDER BY id DESC', (e, rows) => {
    if (e) return res.status(500).json({ error: e.message });
    res.json(rows);
  });
});

/* ---------- API: Local events ---------- */
app.post('/api/events', (req, res) => {
  const { title, description, start, end, timezone } = req.body || {};
  if (!title || !start) return res.status(400).json({ error: 'title and start required' });
  db.run('INSERT INTO events(title,description,start,end,timezone) VALUES(?,?,?,?,?)',
    [title, description||'', start, end||'', timezone||''],
    function (e) { if (e) return res.status(500).json({ error: e.message }); res.json({ id: this.lastID }); }
  );
});
app.get('/api/events', (_, res) => {
  db.all('SELECT id,title,description,start,end,timezone,created_at FROM events ORDER BY start ASC', (e, rows) => {
    if (e) return res.status(500).json({ error: e.message }); res.json(rows);
  });
});

/* ---------- API: Google Calendar ---------- */
app.get('/auth/google', (req, res) => {
  const o = getOAuth2Client();
  if (!o) return res.status(500).send('Google OAuth not configured.');
  const scopes = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events'
  ];
  const url = o.generateAuthUrl({ access_type: 'offline', scope: scopes, prompt: 'consent' });
  res.redirect(url);
});
app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  const o = getOAuth2Client();
  if (!code || !o) return res.status(400).send('Missing code or OAuth client.');
  try {
    const { tokens } = await o.getToken(code);
    await saveTokens(tokens);
    res.send(`<script>window.location.href='/'</script>`);
  } catch (e) { res.status(500).send('OAuth exchange failed.'); }
});
app.get('/api/calendar/list', async (req, res) => {
  try {
    const cal = await getCalendarClient();
    const timeMin = req.query.timeMin || (new Date()).toISOString();
    const timeMax = req.query.timeMax || new Date(Date.now()+7*24*3600*1000).toISOString();
    const r = await cal.events.list({ calendarId:'primary', timeMin, timeMax, singleEvents:true, orderBy:'startTime' });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/calendar/create', async (req, res) => {
  try {
    const { title, description, start, end, timezone } = req.body || {};
    if (!title || !start || !end) return res.status(400).json({ error: 'title, start, end required' });
    const cal = await getCalendarClient();
    const event = { summary:title, description:description||'', start:{dateTime:start, timeZone:timezone||'UTC'}, end:{dateTime:end, timeZone:timezone||'UTC'} };
    const r = await cal.events.insert({ calendarId:'primary', requestBody:event });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/calendar/update/:id', async (req, res) => {
  try {
    const cal = await getCalendarClient();
    const r = await cal.events.patch({ calendarId:'primary', eventId:req.params.id, requestBody:req.body });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/calendar/delete/:id', async (req, res) => {
  try {
    const cal = await getCalendarClient();
    await cal.events.delete({ calendarId:'primary', eventId:req.params.id });
    res.json({ ok:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- API: Image generation ---------- */
app.post('/api/images', upload.none(), async (req, res) => {
  const { prompt, n } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  if (!OPENAI_API_KEY) return res.status(400).json({ error: 'OPENAI_API_KEY missing' });
  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${OPENAI_API_KEY}`},
    body: JSON.stringify({ prompt, n: Number(n)||2, size:'1024x1024' })
  });
  const data = await r.json();
  res.json(data);
});

/* ---------- API: Simple search ---------- */
app.get('/api/search', async (req, res) => {
  const q = req.query.q; if (!q) return res.status(400).json({ error:'q param required' });
  try {
    const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&pretty=1`);
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error:'Search failed' }); }
});

/* ---------- Start ---------- */
app.listen(PORT, () => console.log('Jabber running on http://localhost:'+PORT));
