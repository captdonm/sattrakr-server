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
db.chat = Object.assign({ seq: 0, msgs: [], bans: {}, counts: {}, last: {}, log: [], logSeq: 0, blocks: {} }, db.chat || {});
// Activity log for the moderator page and app: reports, blocks (the block itself lives on the user's phone) and every moderator action, newest 500 kept.
function clog(e) { db.chat.log.push({ id: ++db.chat.logSeq, t: Date.now(), ...e }); if (db.chat.log.length > 500) db.chat.log.splice(0, db.chat.log.length - 500); }
db.acts = db.acts || []; db.actSeq = db.actSeq || 0; // activation announcements
const snip = (x) => String(x || '').slice(0, 80);
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

    // PSK Reporter proxy for the web app (browsers are not allowed to call PSK Reporter directly). Cached 2 minutes per grid square.
    if (req.method === 'GET' && p === '/psk') {
      const g4 = String(new URL(req.url, 'http://x').searchParams.get('grid') || '').trim().toUpperCase().slice(0, 4);
      if (!/^[A-R]{2}[0-9]{2}$/.test(g4)) return send(res, 400, { error: 'bad grid' });
      globalThis.__psk = globalThis.__psk || new Map();
      const hit = globalThis.__psk.get(g4);
      if (hit && now - hit.t < 120000) return send(res, 200, hit.xml, 'text/xml');
      try {
        const r = await fetch('https://retrieve.pskreporter.info/query?callsign=' + g4 + '&modify=grid&flowStartSeconds=-1800&rptlimit=400&rronly=1', { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'SatTrakR/1.0 (amateur radio satellite tracker; +https://sattrakr.netlify.app)' } });
        const xml = await r.text();
        if (!r.ok || !/<receptionReport|<receptionReports/.test(xml)) throw new Error('HTTP ' + r.status + ' ' + xml.replace(/\s+/g, ' ').slice(0, 200));
        globalThis.__psk.set(g4, { t: now, xml });
        if (globalThis.__psk.size > 200) globalThis.__psk.delete(globalThis.__psk.keys().next().value);
        return send(res, 200, xml, 'text/xml');
      } catch (e) {
        if (hit) return send(res, 200, hit.xml, 'text/xml'); // PSK Reporter busy: send the last answer we had
        return send(res, 502, { error: 'PSK Reporter unavailable', detail: String(e && e.message || e).slice(0, 300) });
      }
    }

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
      d.last = now; d.callsign = call; d.grid = grid.toUpperCase(); d.pings += 1; d.src = ['play', 'apk', 'web', 'dev'].includes(b.src) ? b.src : 'unknown';
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
        by_source_30d: ds.filter((d) => now - d.last < MAP_DAYS * day).reduce((o, d) => { const k = d.src || 'unknown'; o[k] = (o[k] || 0) + 1; return o; }, {}),
        by_source_24h: ds.filter((d) => now - d.last < day).reduce((o, d) => { const k = d.src || 'unknown'; o[k] = (o[k] || 0) + 1; return o; }, {}),
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
      if (!m.reports.includes(id)) { m.reports.push(id); clog({ type: 'report', by: String(b.callsign || '').toUpperCase().slice(0, 12) || 'someone', dev: id, mid: m.id, call: m.call, text: snip(m.text), count: m.reports.length }); }
      if (m.reports.length >= 3 && !m.hidden) { m.hidden = true; clog({ type: 'autohide', mid: m.id, call: m.call, text: snip(m.text) }); } // auto-hide until you review it
      touch();
      return send(res, 200, { ok: true });
    }
    if (p === '/chat/blocks' && req.method === 'GET') {
      const id = String(new URL(req.url, 'http://x').searchParams.get('device_id') || '');
      return send(res, 200, { blocked: Object.keys(db.chat.blocks[id] || {}) });
    }
    if (p === '/chat/block' && req.method === 'POST') {
      const b = await readJson(req);
      const id = String(b.device_id || ''), target = String(b.target || '').toUpperCase().slice(0, 12);
      if (id.length < 3 || !target) return send(res, 400, { error: 'bad request' });
      const mine = (db.chat.blocks[id] = db.chat.blocks[id] || {});
      if (b.unblock) delete mine[target]; else mine[target] = Date.now();
      if (!Object.keys(mine).length) delete db.chat.blocks[id];
      clog({ type: b.unblock ? 'unblock' : 'block', by: String(b.callsign || '').toUpperCase().slice(0, 12) || 'someone', dev: id, target });
      touch();
      return send(res, 200, { ok: true });
    }
    if (p === '/admin/chat/log' && req.method === 'POST') {
      const b = await readJson(req);
      if (!ADMIN_KEY || b.key !== ADMIN_KEY) return send(res, 403, { error: 'forbidden' });
      return send(res, 200, { log: db.chat.log.slice(-200).reverse(), bans: db.chat.bans });
    }
    if (p === '/admin/chat/undo' && req.method === 'POST') {
      const b = await readJson(req);
      if (!ADMIN_KEY || b.key !== ADMIN_KEY) return send(res, 403, { error: 'forbidden' });
      const e = db.chat.log.find((x) => x.id === Number(b.log_id));
      if (!e || !['mod', 'block', 'unblock'].includes(e.type) || e.undone) return send(res, 400, { error: 'cannot undo' });
      const m = db.chat.msgs.find((x) => x.id === e.mid);
      if (e.type === 'block') { const mine = db.chat.blocks[e.dev]; if (mine) { delete mine[e.target]; if (!Object.keys(mine).length) delete db.chat.blocks[e.dev]; } }
      else if (e.type === 'unblock') { db.chat.blocks[e.dev] = db.chat.blocks[e.dev] || {}; db.chat.blocks[e.dev][e.target] = Date.now(); }
      else if (e.action === 'ban_call' || e.action === 'ban_dev') delete db.chat.bans[e.target];
      else if (e.action === 'unban') db.chat.bans[e.target] = Date.now();
      else if (e.action === 'hide' && m) m.hidden = false;
      else if (e.action === 'restore' && m) m.hidden = true;
      else if (e.action === 'delete' && e.msg) { if (!db.chat.msgs.some((x) => x.id === e.msg.id)) { db.chat.msgs.push(e.msg); db.chat.msgs.sort((x, y) => x.id - y.id); } }
      else return send(res, 400, { error: 'cannot undo' });
      e.undone = Date.now();
      touch();
      return send(res, 200, { ok: true });
    }
    // ---------- activation announcements: "I will be working this satellite" ----------
    const ACT_TYPES = ['POTA', 'Rover', 'Home', 'Portable'];
    const cleanTxt = (x, n) => String(x || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
    if (p === '/acts/list' && req.method === 'POST') {
      const b = await readJson(req);
      const adm = isAdmin(b.admin_key), id = String(b.device_id || ''), me = String(b.callsign || '').trim().toUpperCase();
      db.acts = db.acts.filter((a) => a.when > now - 7 * 86400e3); // drop anything older than a week
      const list = db.acts.filter((a) => a.when > now - 24 * 3600e3 && !a.hidden).sort((x, y) => x.when - y.when).slice(0, 200)
        .map((a) => ({ id: a.id, call: a.call, sat: a.sat, loc: a.loc, grid: a.grid, when: a.when, type: a.type, end: a.end || a.when + 10 * 60e3, note: a.note || '', mine: adm || a.dev === id || (!!me && !isReserved(me) && a.call === me), ...(adm ? { reports: a.reports.length, hidden: a.hidden } : {}) }));
      return send(res, 200, { acts: list });
    }
    if (p === '/acts/post' && req.method === 'POST') {
      const b = await readJson(req);
      const id = String(b.device_id || ''), call = String(b.callsign || '').trim().toUpperCase(), adm = isAdmin(b.admin_key);
      if (id.length < 3 || id.length > 80) return send(res, 400, { error: 'bad device' });
      if (call.length < 3 || !CALL_RE.test(call)) return send(res, 400, { error: 'Enter your callsign first.' });
      if (isReserved(call) && !adm) return send(res, 403, { error: 'reserved', message: 'That callsign is reserved for the moderator.' });
      if (!adm && (db.chat.bans['d:' + id] || db.chat.bans['c:' + call])) return send(res, 403, { error: 'You have been blocked.' });
      const sat = cleanTxt(b.sat, 40), loc = cleanTxt(b.loc, 40), grid = String(b.grid || '').trim().toUpperCase(), type = String(b.type || '');
      const when = Date.parse(b.when);
      if (!sat) return send(res, 400, { error: 'Enter the satellite name.' });
      if (!loc) return send(res, 400, { error: 'Enter your state or country.' });
      if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(grid)) return send(res, 400, { error: 'Enter a grid square like EN82 or EN82qv.' });
      if (!ACT_TYPES.includes(type)) return send(res, 400, { error: 'Pick the type of activation.' });
      if (!Number.isFinite(when) || when < now - 2 * 3600e3 || when > now + 30 * 86400e3) return send(res, 400, { error: 'Pick a UTC date and time from now to 30 days ahead.' });
      const mine = db.acts.filter((a) => a.dev === id && a.t > now - 86400e3).length;
      if (!adm && mine >= 5) return send(res, 429, { error: 'You can post up to 5 activations a day.' });
      const a = { id: ++db.actSeq, t: now, dev: id, call, sat, loc, grid, when, type, end: (Date.parse(b.end) > when && Date.parse(b.end) <= when + 3 * 3600e3) ? Date.parse(b.end) : when + 10 * 60e3, note: cleanTxt(b.note, 140), reports: [], hidden: false };
      db.acts.push(a); if (db.acts.length > 600) db.acts.splice(0, db.acts.length - 600);
      touch();
      return send(res, 200, { ok: true, id: a.id });
    }
    if (p === '/acts/delete' && req.method === 'POST') {
      const b = await readJson(req);
      const a = db.acts.find((x) => x.id === Number(b.id)), id = String(b.device_id || ''), adm = isAdmin(b.admin_key), me = String(b.callsign || '').trim().toUpperCase();
      if (!a || (!adm && a.dev !== id && !(me && !isReserved(me) && a.call === me))) return send(res, 404, { error: 'not found' });
      db.acts = db.acts.filter((x) => x !== a);
      if (adm && a.dev !== id) clog({ type: 'mod', action: 'act_delete', call: a.call, text: a.sat + ' ' + a.grid });
      touch();
      return send(res, 200, { ok: true });
    }
    if (p === '/acts/report' && req.method === 'POST') {
      const b = await readJson(req);
      const a = db.acts.find((x) => x.id === Number(b.id)), id = String(b.device_id || '');
      if (!a || id.length < 3) return send(res, 404, { error: 'not found' });
      if (!a.reports.includes(id)) { a.reports.push(id); clog({ type: 'act_report', by: String(b.callsign || '').toUpperCase().slice(0, 12) || 'someone', dev: id, call: a.call, text: snip(a.sat + ' ' + a.grid), count: a.reports.length }); }
      if (a.reports.length >= 3) a.hidden = true;
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
      const base = m ? { type: 'mod', action: b.action, mid: m.id, call: m.call, text: snip(m.text) } : { type: 'mod', action: b.action };
      if (b.action === 'delete' && m) { clog({ ...base, msg: m }); db.chat.msgs = db.chat.msgs.filter((x) => x !== m); }
      else if (b.action === 'hide' && m) { m.hidden = true; clog(base); }
      else if (b.action === 'restore' && m) { m.hidden = false; m.reports = []; clog(base); }
      else if (b.action === 'dismiss' && m) { clog({ ...base, count: m.reports.length }); m.reports = []; }
      else if ((b.action === 'ban_call' || b.action === 'ban_dev') && m && isReserved(m.call)) return send(res, 400, { error: 'cannot ban the moderator' });
      else if (b.action === 'ban_call' && m) { db.chat.bans['c:' + m.call] = Date.now(); clog({ ...base, target: 'c:' + m.call }); }
      else if (b.action === 'ban_dev' && m) { db.chat.bans['d:' + m.dev] = Date.now(); clog({ ...base, target: 'd:' + m.dev }); }
      else if (b.action === 'unban') { const tg = String(b.target || ''); delete db.chat.bans[tg]; clog({ type: 'mod', action: 'unban', target: tg }); }
      else if (b.action === 'reset_count') { delete db.chat.counts[String(b.target || '')]; clog({ type: 'mod', action: 'reset_count', target: String(b.target || '') }); }
      else return send(res, 400, { error: 'bad action' });
      touch();
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 400, { error: 'bad request' });
  }
}).listen(PORT, () => console.log(`SatTrakR server listening on port ${PORT}`));
