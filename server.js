'use strict';
// SatTrakR backend. No dependencies: needs only Node 18+.
// Endpoints (also served under /api):
//   GET  /tle                 merged keps (PE0SAT first, CelesTrak fills the gaps), plain 3-line text
//   POST /tle/refresh         {source: "pe0sat" | "celestrak" | "all"}
//   GET  /stats               counters
//   POST /stats/ping          {device_id, callsign, grid}
//   POST /stats/event         {kind, device_id}
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

// ---------- TLE cache ----------
const TLE_FILE = path.join(DATA, 'tle.json');
let tle = { pe0sat: null, celestrak: null }; // each: {t, text}
try { tle = { ...tle, ...JSON.parse(fs.readFileSync(TLE_FILE, 'utf8')) }; } catch {}
const lastTry = {};
function parseSets(text) {
  const L = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean), out = [];
  for (let i = 0; i < L.length - 1; i++) {
    if (L[i].startsWith('1 ') && L[i + 1].startsWith('2 ')) {
      out.push({ name: i > 0 && !L[i - 1].startsWith('2 ') ? L[i - 1] : '', l1: L[i], l2: L[i + 1], id: parseInt(L[i].slice(2, 7), 10) });
      i++;
    }
  }
  return out;
}
function mergedTle() {
  const m = new Map();
  for (const k of ['pe0sat', 'celestrak']) if (tle[k]) for (const s of parseSets(tle[k].text)) if (!m.has(s.id)) m.set(s.id, s);
  return [...m.values()].map((s) => `${s.name}\n${s.l1}\n${s.l2}`).join('\n') + '\n';
}
const tleUpdated = () => Math.max(0, ...['pe0sat', 'celestrak'].map((k) => (tle[k] ? tle[k].t : 0)));
async function refreshSource(key, force) {
  if (!force && Date.now() - (lastTry[key] || 0) < 60000) return 'skipped';
  lastTry[key] = Date.now();
  try {
    const r = await fetch(SOURCES[key], { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const text = await r.text();
    if (parseSets(text).length < 5) throw new Error('no TLE sets in response');
    tle[key] = { t: Date.now(), text };
    try { fs.writeFileSync(TLE_FILE, JSON.stringify(tle)); } catch {}
    return 'ok';
  } catch (e) {
    console.log(`TLE refresh ${key} failed: ${e.message}`);
    return 'failed';
  }
}
const refreshAll = async (force) => ({ pe0sat: await refreshSource('pe0sat', force), celestrak: await refreshSource('celestrak', force) });
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
      const result = s === 'pe0sat' || s === 'celestrak' ? { [s]: await refreshSource(s, false) } : await refreshAll(false);
      return send(res, 200, { ok: true, result, updated: tleUpdated() ? new Date(tleUpdated()).toISOString() : null });
    }

    if (req.method === 'POST' && p === '/stats/ping') {
      const b = await readJson(req);
      const id = String(b.device_id || ''), call = String(b.callsign || '').trim().toUpperCase(), grid = String(b.grid || '').trim();
      if (id.length < 3 || id.length > 80) return send(res, 400, { error: 'device_id must be 3-80 characters' });
      if (!CALL_RE.test(call)) return send(res, 400, { error: 'callsign: letters, numbers and / only, up to 12' });
      if (grid && !GRID_RE.test(grid)) return send(res, 400, { error: 'grid must look like EN82 or EN82ab' });
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

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 400, { error: 'bad request' });
  }
}).listen(PORT, () => console.log(`SatTrakR server listening on port ${PORT}`));
