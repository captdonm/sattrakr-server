'use strict';
// SatTrakR backend. No dependencies: needs only Node 18+.
// Endpoints (also served under /api):
//   GET  /tle                 merged keps (PE0SAT first, CelesTrak fills the gaps), plain 3-line text
//   POST /tle/refresh         {source: "pe0sat" | "celestrak" | "all"}
//   GET  /stats               counters
//   POST /stats/ping          {device_id, callsign, grid}
//   POST /stats/event         {kind, device_id}
//   GET  /chat, POST /chat/send, /chat/report, GET /chat/status   public chat; moderation page: /admin/chat?key=ADMIN_KEY
//   GET  /stats/map           stations seen in the last 30 days (4-character grid squares only)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8787;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*'; // set to https://sattrakr.netlify.app to lock the web app down
const SOURCES = {
  pe0sat: process.env.PE0SAT_URL || 'http://tle.pe0sat.nl/kepler/amateur.txt',
  celestrak: process.env.CELESTRAK_URL || 'https://celestrak.org/NORAD/elements/gp.php?GROUP=amateur&FORMAT=tle',
  meteor: process.env.METEOR_JSON_URL || 'https://celestrak.org/NORAD/elements/gp.php?NAME=METEOR-M2&FORMAT=json', // weather satellites, receive only
};
const TLE_MAX_AGE_MS = 6 * 3600e3;
const MAP_DAYS = 30;
const MAX_EVENT_KINDS = 100;
let DATA = DATA_DIR;
try { fs.mkdirSync(DATA, { recursive: true }); fs.accessSync(DATA, fs.constants.W_OK); }
catch { DATA = path.join(require('os').tmpdir(), 'sattrakr-data'); fs.mkdirSync(DATA, { recursive: true }); console.log('DATA_DIR is not writable, using ' + DATA + ' (data may not survive restarts)'); }

// ---------- storage (one small JSON file, written every few seconds) ----------
const DB_FILE = path.join(DATA, 'db.json');
let db = { devices: {}, events: {}, launches: 0, pings: 0 };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch {}
let dirty = false;
const touch = () => { dirty = true; };
function save() {
  if (!dirty) return;
  dirty = false;
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) { console.log('could not save db: ' + e.message); }
}
setInterval(save, 5000).unref();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { save(); process.exit(0); });

// ---------- OMM (JSON) to TLE: new satellites have 6-digit catalog numbers and no TLE ----------
// Since July 2026 new satellites get 6-digit catalog numbers (100000+) and CelesTrak can no longer publish them as classic TLEs.
// CelesTrak still publishes them as JSON (OMM). This turns those records into ordinary 3-line TLE text so the rest of the app is unchanged.
// A catalog number of 100000 or more is written in Alpha-5 (A1101 = 101101), the same way PE0SAT writes it, so both sources agree.
const pad = (v, n, ch = ' ') => String(v).padStart(n, ch);
function checksum(line) {
  let s = 0;
  for (const c of line.slice(0, 68)) { if (c >= '0' && c <= '9') s += Number(c); else if (c === '-') s += 1; }
  return s % 10;
}
function expField(x) { // 8 characters, e.g. "-11606-4"
  if (!x) return ' 00000-0';
  const sign = x < 0 ? '-' : ' ';
  const a = Math.abs(x);
  let e = Math.floor(Math.log10(a)) + 1;
  let mant = Math.round((a / Math.pow(10, e)) * 1e5);
  if (mant >= 100000) { mant = Math.round(mant / 10); e += 1; }
  return sign + pad(mant, 5, '0') + (e < 0 ? '-' : '+') + Math.abs(e);
}
const dotField = (x) => (x < 0 ? '-' : ' ') + Math.abs(x).toFixed(8).slice(1); // 10 characters, e.g. "-.00002182"
function epochField(iso) {
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
  const d = new Date(t), y = d.getUTCFullYear();
  const day = (t - Date.UTC(y, 0, 1)) / 86400000 + 1;
  return pad(y % 100, 2, '0') + pad(day.toFixed(8), 12, '0');
}
function ommToLines(o, satnum) {
  const des = o.OBJECT_ID && o.OBJECT_ID.length >= 8 ? o.OBJECT_ID.slice(2, 4) + o.OBJECT_ID.slice(5) : '';
  let l1 = '1 ' + pad(satnum, 5, '0') + (o.CLASSIFICATION_TYPE || 'U') + ' ' + des.padEnd(8) + ' ' + epochField(o.EPOCH) + ' ' + dotField(o.MEAN_MOTION_DOT || 0)
    + ' ' + expField(o.MEAN_MOTION_DDOT || 0) + ' ' + expField(o.BSTAR || 0) + ' ' + (o.EPHEMERIS_TYPE || 0) + ' ' + pad((o.ELEMENT_SET_NO || 0) % 10000, 4);
  l1 = l1 + checksum(l1);
  let l2 = '2 ' + pad(satnum, 5, '0') + ' ' + pad(Number(o.INCLINATION).toFixed(4), 8) + ' ' + pad(Number(o.RA_OF_ASC_NODE).toFixed(4), 8)
    + ' ' + pad(Math.round(Number(o.ECCENTRICITY) * 1e7), 7, '0') + ' ' + pad(Number(o.ARG_OF_PERICENTER).toFixed(4), 8) + ' ' + pad(Number(o.MEAN_ANOMALY).toFixed(4), 8)
    + ' ' + pad(Number(o.MEAN_MOTION).toFixed(8), 11) + pad((o.REV_AT_EPOCH || 0) % 100000, 5, '0');
  l2 = l2 + checksum(l2);
  return [l1, l2];
}
const A5 = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function alpha5(n) { // 101101 -> "A1101"; null if it doesn't fit
  if (n <= 99999) return String(n).padStart(5, '0');
  const lead = Math.floor(n / 10000) - 10;
  return lead >= 0 && lead < A5.length ? A5[lead] + String(n % 10000).padStart(4, '0') : null;
}
function ommListToText(list) {
  const out = [];
  for (const o of list) {
    try {
      const num = alpha5(Number(o.NORAD_CAT_ID));
      if (!num) continue;
      const [l1, l2] = ommToLines(o, num);
      out.push(`${o.OBJECT_NAME || ''}\n${l1}\n${l2}`);
    } catch (e) { /* skip a bad record */ }
  }
  return out.join('\n') + '\n';
}

// ---------- TLE cache ----------
const TLE_FILE = path.join(DATA, 'tle.json');
let tle = { pe0sat: null, celestrak: null, meteor: null }; // each: {t, text}
try { tle = { ...tle, ...JSON.parse(fs.readFileSync(TLE_FILE, 'utf8')) }; } catch {}
const lastTry = {};
let badId = 0;
function satNum(field) { // Alpha-5: A1101 = 101101
  const t = field.trim();
  if (/^[A-Za-z]/.test(t)) { const i = A5.indexOf(t[0].toUpperCase()); const n = (10 + i) * 10000 + parseInt(t.slice(1), 10); if (i >= 0 && !Number.isNaN(n)) return n; }
  const n = parseInt(t, 10);
  return Number.isNaN(n) ? --badId : n;
}
function parseSets(text) {
  const L = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean), out = [];
  for (let i = 0; i < L.length - 1; i++) {
    if (L[i].startsWith('1 ') && L[i + 1].startsWith('2 ')) {
      out.push({ name: i > 0 && !L[i - 1].startsWith('2 ') ? L[i - 1] : '', l1: L[i], l2: L[i + 1], id: satNum(L[i].slice(2, 7)) });
      i++;
    }
  }
  return out;
}
function mergedTle() {
  const m = new Map();
  for (const k of ['pe0sat', 'celestrak', 'meteor']) if (tle[k]) for (const s of parseSets(tle[k].text)) if (!m.has(s.id)) m.set(s.id, s);
  return [...m.values()].map((s) => `${s.name}\n${s.l1}\n${s.l2}`).join('\n') + '\n';
}
const tleUpdated = () => Math.max(0, ...['pe0sat', 'celestrak'].map((k) => (tle[k] ? tle[k].t : 0)));
const CELESTRAK_JSON = process.env.CELESTRAK_JSON_URL || 'https://celestrak.org/NORAD/elements/gp.php?GROUP=amateur&FORMAT=json';
// Why a fetch failed, in a few words (Node hides the real reason in e.cause).
const why = (e) => e.message + (e.cause ? ' [' + (e.cause.code || e.cause.message) + ']' : '');
// Try each address in turn until one answers. CelesTrak has two domain names, so if one is blocked the other may still work.
async function getFrom(urls, asJson) {
  let last;
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'SatTrakR/1.0 (amateur radio satellite tracker; +https://sattrakr.netlify.app)' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return asJson ? await r.json() : await r.text();
    } catch (e) { last = e; console.log('fetch failed for ' + u.slice(0, 70) + ' : ' + why(e)); }
  }
  throw last;
}
const mirrors = (u) => [u, u.replace('https://celestrak.org', 'https://celestrak.com')];
async function fetchSourceText(key) {
  if (key === 'meteor') { // CelesTrak first, then SatNOGS (looked up by catalog number: METEOR-M2 3 = 57166, METEOR-M2 4 = 59051)
    try {
      const list = await getFrom(mirrors(SOURCES.meteor), true);
      if (Array.isArray(list) && list.length) return ommListToText(list);
    } catch (e) { console.log('Meteor from CelesTrak failed, trying SatNOGS'); }
    let out = '';
    for (const id of [57166, 59051]) {
      try {
        const raw = await getFrom(['https://db.satnogs.org/api/tle/?norad_cat_id=' + id + '&format=json'], true);
        const t = (Array.isArray(raw) ? raw : (raw && raw.results) || [])[0];
        if (t && t.tle1 && t.tle2) out += '\n' + String(t.tle0 || '').replace(/^0\s+/, '') + '\n' + String(t.tle1).trim() + '\n' + String(t.tle2).trim();
      } catch (e) { /* skip this one */ }
    }
    if (!/^1 /m.test(out)) throw new Error('no Meteor data from CelesTrak or SatNOGS');
    return out;
  }
  if (key === 'celestrak') {
    try {
      const list = await getFrom(mirrors(CELESTRAK_JSON), true);
      if (Array.isArray(list) && list.length > 5) return ommListToText(list);
    } catch (e) { console.log('CelesTrak JSON failed, using the TLE address'); }
    return getFrom(mirrors(SOURCES.celestrak), false);
  }
  return getFrom([SOURCES[key]], false);
}
async function refreshSource(key, force) {
  if (!force && Date.now() - (lastTry[key] || 0) < 60000) return 'skipped';
  lastTry[key] = Date.now();
  try {
    const text = await fetchSourceText(key);
    if (parseSets(text).length < (key === 'meteor' ? 1 : 5)) throw new Error('no TLE sets in response');
    tle[key] = { t: Date.now(), text };
    try { fs.writeFileSync(TLE_FILE, JSON.stringify(tle)); } catch {}
    return 'ok';
  } catch (e) {
    console.log(`TLE refresh ${key} failed: ${why(e)}`);
    return 'failed';
  }
}
const refreshAll = async (force) => ({ pe0sat: await refreshSource('pe0sat', force), celestrak: await refreshSource('celestrak', force), meteor: await refreshSource('meteor', force) });
refreshAll(true);
setInterval(() => refreshAll(false), TLE_MAX_AGE_MS).unref();

// ---------- helpers ----------
const GRID_RE = /^[A-R]{2}\d{2}([A-X]{2})?$/i;
const CALL_RE = /^[A-Z0-9/]{0,12}$/;
const gridCenter4 = (g) => ({ lat: (g.charCodeAt(1) - 65) * 10 - 90 + Number(g[3]) + 0.5, lon: (g.charCodeAt(0) - 65) * 20 - 180 + Number(g[2]) * 2 + 1 });
const hits = new Map();
function limited(ip) {
  const now = Date.now(), h = hits.get(ip);
  if (!h || h.reset < now) { hits.set(ip, { n: 1, reset: now + 60000 }); return false; }
  return ++h.n > 300;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, 60000).unref();
function send(res, code, body, type = 'application/json', extra = {}) {
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Access-Control-Allow-Origin': ALLOW_ORIGIN, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store', ...extra });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
const readJson = (req) => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > 4096) { reject(new Error('too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});

// ---------- public chat storage + admin page ----------
// Env vars (Render): ADMIN_KEY = a long secret for /admin/chat?key=..., CHAT_FREE_LIMIT = free messages per install (0 = unlimited, the default).
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const CHAT_FREE_LIMIT = Number(process.env.CHAT_FREE_LIMIT) || 0;
db.chat = Object.assign({ seq: 0, msgs: [], bans: {}, counts: {}, last: {} }, db.chat || {});
// Reserved callsigns (W8CPT, also W8CPT/P etc.): only the moderator, who sends ADMIN_KEY, can chat or show on the map under them.
const RESERVED = (process.env.RESERVED_CALLS || 'W8CPT').toUpperCase().split(',').map((x) => x.trim()).filter(Boolean);
const isReserved = (c) => String(c).toUpperCase().split('/').some((part) => RESERVED.includes(part));
const isAdmin = (k) => !!ADMIN_KEY && k === ADMIN_KEY;
const ADMIN_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SatTrakR chat moderation</title>
<style>body{font:15px system-ui;margin:0;background:#111;color:#eee}header{padding:12px;background:#222;position:sticky;top:0}.m{padding:10px 12px;border-bottom:1px solid #333}.m.h{background:#3a1a1a}.c{color:#ffd54a;font-weight:700}.t{color:#888;font-size:12px}button{margin:6px 6px 0 0;padding:6px 10px;border:0;border-radius:6px;background:#345;color:#fff}button.d{background:#a33}</style>
<header><b>Chat moderation</b> <button id="rf">Refresh</button> <span id="bn" class="t"></span></header><div id="l"></div>
<script>
const key=new URLSearchParams(location.search).get('key');
const post=(u,b)=>fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({key},b))}).then(r=>r.json());
async function load(){const r=await post('/admin/chat/list',{});const l=document.getElementById('l');l.textContent='';
 const bans=Object.keys(r.bans||{});const bn=document.getElementById('bn');bn.textContent=bans.length?'Banned: ':'';
 bans.forEach(b=>{const x=document.createElement('button');x.textContent='Unban '+b;x.onclick=async()=>{await post('/admin/chat/action',{action:'unban',target:b});load()};bn.appendChild(x)});
 (r.msgs||[]).forEach(m=>{const d=document.createElement('div');d.className='m'+(m.hidden?' h':'');
  const h=document.createElement('div');const c=document.createElement('span');c.className='c';c.textContent=m.call;h.appendChild(c);
  const t=document.createElement('span');t.className='t';t.textContent='  '+new Date(m.t).toLocaleString()+'  reports: '+m.reports.length+(m.hidden?'  HIDDEN':'');h.appendChild(t);d.appendChild(h);
  const p=document.createElement('div');p.textContent=m.text;d.appendChild(p);
  [['delete','Delete','d'],['hide','Hide',''],['restore','Restore',''],['ban_call','Ban callsign','d'],['ban_dev','Ban device','d']].forEach(a=>{const b=document.createElement('button');b.textContent=a[1];if(a[2])b.className=a[2];b.onclick=async()=>{await post('/admin/chat/action',{action:a[0],id:m.id});load()};d.appendChild(b)});
  l.appendChild(d)})}
document.getElementById('rf').onclick=load;load();setInterval(load,20000);
</script>`;

// ---------- routes ----------
http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain');
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
    if (limited(ip)) return send(res, 429, { error: 'too many requests' });
    const p = (new URL(req.url, 'http://x').pathname.replace(/^\/api/, '') || '/').replace(/\/+$/, '') || '/';
    const now = Date.now();

    if (req.method === 'GET' && (p === '/' || p === '/health')) return send(res, 200, { ok: true, service: 'sattrakr' });

    if (req.method === 'GET' && p === '/tle') {
      if (!tleUpdated()) await refreshAll(false);
      else if (now - tleUpdated() > TLE_MAX_AGE_MS) refreshAll(false);
      const body = mergedTle();
      if (body.trim() === '') return send(res, 503, { error: 'no TLE data yet, try again shortly' });
      return send(res, 200, body, 'text/plain', { 'X-TLE-Updated': new Date(tleUpdated()).toISOString() });
    }

    if (req.method === 'POST' && p === '/tle/refresh') {
      const b = await readJson(req);
      const s = String(b.source || 'all').toLowerCase();
      const result = s === 'pe0sat' || s === 'meteor' ? { [s]: await refreshSource(s, false) } : s === 'celestrak' ? { celestrak: await refreshSource('celestrak', false), meteor: await refreshSource('meteor', false) } : await refreshAll(false);
      return send(res, 200, { ok: true, result, updated: tleUpdated() ? new Date(tleUpdated()).toISOString() : null });
    }

    if (req.method === 'POST' && p === '/stats/ping') {
      const b = await readJson(req);
      const id = String(b.device_id || ''), grid = String(b.grid || '').trim();
      let call = String(b.callsign || '').trim().toUpperCase();
      if (id.length < 3 || id.length > 80) return send(res, 400, { error: 'device_id must be 3-80 characters' });
      if (!CALL_RE.test(call)) return send(res, 400, { error: 'callsign: letters, numbers and / only, up to 12' });
      if (grid && !GRID_RE.test(grid)) return send(res, 400, { error: 'grid must look like EN82 or EN82ab' });
      if (isReserved(call) && !isAdmin(b.admin_key)) call = '';
      const d = db.devices[id] || (db.devices[id] = { first: now, pings: 0 });
      d.last = now; d.callsign = call; d.grid = grid.toUpperCase(); d.pings += 1;
      db.pings += 1; touch();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/stats/event') {
      const b = await readJson(req);
      const kind = String(b.kind || ''), id = String(b.device_id || '');
      if (!/^[a-z0-9_.:-]{1,40}$/i.test(kind)) return send(res, 400, { error: 'kind: letters, numbers and _ . : - only, up to 40' });
      if (!(kind in db.events) && Object.keys(db.events).length >= MAX_EVENT_KINDS) return send(res, 400, { error: 'too many event kinds' });
      db.events[kind] = (db.events[kind] || 0) + 1;
      if (kind === 'app_open') db.launches += 1;
      if (db.devices[id]) db.devices[id].last = now;
      touch();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/stats') {
      const ds = Object.values(db.devices), day = 86400e3;
      return send(res, 200, {
        devices: ds.length,
        active_24h: ds.filter((d) => now - d.last < day).length,
        active_30d: ds.filter((d) => now - d.last < MAP_DAYS * day).length,
        stations: ds.filter((d) => d.grid).length,
        launches: db.launches,
        pings: db.pings,
        events: db.events,
      });
    }

    if (req.method === 'GET' && p === '/stats/map') {
      const stations = Object.values(db.devices)
        .filter((d) => d.grid && now - d.last < MAP_DAYS * 86400e3)
        .map((d) => { const g4 = d.grid.slice(0, 4); const c = gridCenter4(g4); return { callsign: d.callsign || '', grid: g4, lat: c.lat, lon: c.lon, last_seen: new Date(d.last).toISOString() }; });
      return send(res, 200, { count: stations.length, stations });
    }

    // ---------- public chat ----------
    if (p === '/chat' && req.method === 'GET') {
      const since = Number(new URL(req.url, 'http://x').searchParams.get('since')) || 0;
      const msgs = db.chat.msgs.filter((m) => !m.hidden && m.id > since).slice(-200).map((m) => ({ id: m.id, t: m.t, call: m.call, text: m.text }));
      return send(res, 200, { msgs });
    }
    if (p === '/chat/status' && req.method === 'GET') {
      const id = String(new URL(req.url, 'http://x').searchParams.get('device_id') || '');
      return send(res, 200, { sent: db.chat.counts[id] || 0, limit: CHAT_FREE_LIMIT, banned: !!db.chat.bans['d:' + id] });
    }
    if (p === '/chat/send' && req.method === 'POST') {
      const b = await readJson(req);
      const id = String(b.device_id || ''), call = String(b.callsign || '').trim().toUpperCase();
      const text = String(b.text || '').replace(/\s+/g, ' ').trim().slice(0, 280);
      if (id.length < 3 || id.length > 80) return send(res, 400, { error: 'bad device' });
      if (call.length < 3 || !CALL_RE.test(call)) return send(res, 400, { error: 'Enter your callsign in Settings first.' });
      if (!text) return send(res, 400, { error: 'Type a message first.' });
      const adm = isAdmin(b.admin_key);
      if (isReserved(call) && !adm) return send(res, 403, { error: 'reserved', message: 'That callsign is reserved for the moderator.' });
      if (!adm && (db.chat.bans['d:' + id] || db.chat.bans['c:' + call])) return send(res, 403, { error: 'You have been blocked from chat.' });
      const used = db.chat.counts[id] || 0;
      if (!adm && CHAT_FREE_LIMIT > 0 && !b.paid && used >= CHAT_FREE_LIMIT) return send(res, 402, { error: 'limit', limit: CHAT_FREE_LIMIT });
      const last = db.chat.last[id] || 0;
      if (!adm && now - last < 10000) return send(res, 429, { error: 'Wait a few seconds between messages.' });
      db.chat.last[id] = now; db.chat.counts[id] = used + 1;
      const m = { id: ++db.chat.seq, t: now, call, dev: id, text, reports: [], hidden: false };
      db.chat.msgs.push(m);
      if (db.chat.msgs.length > 2000) db.chat.msgs.splice(0, db.chat.msgs.length - 2000);
      touch();
      return send(res, 200, { ok: true, id: m.id, sent: used + 1 });
    }
    if (p === '/chat/report' && req.method === 'POST') {
      const b = await readJson(req);
      const id = String(b.device_id || ''), m = db.chat.msgs.find((x) => x.id === Number(b.id));
      if (!m || id.length < 3) return send(res, 404, { error: 'not found' });
      if (!m.reports.includes(id)) m.reports.push(id);
      if (m.reports.length >= 3) m.hidden = true; // auto-hide until you review it
      touch();
      return send(res, 200, { ok: true });
    }
    if (p === '/admin/check' && req.method === 'POST') {
      const b = await readJson(req);
      return isAdmin(b.key) ? send(res, 200, { ok: true }) : send(res, 403, { error: 'forbidden' });
    }
    if (p === '/admin/chat' && req.method === 'GET') {
      if (!ADMIN_KEY || new URL(req.url, 'http://x').searchParams.get('key') !== ADMIN_KEY) return send(res, 403, 'Forbidden', 'text/plain');
      return send(res, 200, ADMIN_HTML, 'text/html');
    }
    if (p === '/admin/chat/list' && req.method === 'POST') {
      const b = await readJson(req);
      if (!ADMIN_KEY || b.key !== ADMIN_KEY) return send(res, 403, { error: 'forbidden' });
      return send(res, 200, { msgs: db.chat.msgs.slice(-300).reverse(), bans: db.chat.bans });
    }
    if (p === '/admin/chat/action' && req.method === 'POST') {
      const b = await readJson(req);
      if (!ADMIN_KEY || b.key !== ADMIN_KEY) return send(res, 403, { error: 'forbidden' });
      const m = db.chat.msgs.find((x) => x.id === Number(b.id));
      if (b.action === 'delete' && m) db.chat.msgs = db.chat.msgs.filter((x) => x !== m);
      else if (b.action === 'hide' && m) m.hidden = true;
      else if (b.action === 'restore' && m) { m.hidden = false; m.reports = []; }
      else if ((b.action === 'ban_call' || b.action === 'ban_dev') && m && isReserved(m.call)) return send(res, 400, { error: 'cannot ban the moderator' });
      else if (b.action === 'ban_call' && m) db.chat.bans['c:' + m.call] = Date.now();
      else if (b.action === 'ban_dev' && m) db.chat.bans['d:' + m.dev] = Date.now();
      else if (b.action === 'unban') delete db.chat.bans[String(b.target || '')];
      else if (b.action === 'reset_count') delete db.chat.counts[String(b.target || '')];
      else return send(res, 400, { error: 'bad action' });
      touch();
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 400, { error: 'bad request' });
  }
}).listen(PORT, () => console.log(`SatTrakR server listening on port ${PORT}`));
