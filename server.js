'use strict';
/*
 * UCIRP – Urban Complaint Intelligence & Resolution Platform
 * Zero-dependency Node.js server: REST API + JSON file storage + live updates (SSE).
 * Run:  node server.js      (or double-click start.bat on Windows)
 *
 * Modules
 *   lib/auth-service.js          AuthService    – password hashing, JWT, login throttling
 *   lib/city-store.js            CityStore      – reference data, demo data, data/db.json
 *   public/city-algorithms.js    CityAlgorithms – duplicate score, priority score, SLA state, routing (shared with the browser)
 *   controllers/*.js             REST endpoints – auth, shared reads, citizen, authority
 *   lib/local-https.js           self-signed HTTPS so phones can use GPS
 * This file wires them together: workflow helpers, per-role views of the data, HTTP plumbing.
 */
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const CA = require('./public/city-algorithms.js');
const Auth = require('./lib/auth-service.js');
const { CityStore, REF, DEMO_PASSWORD, wardOf } = require('./lib/city-store.js');
const TLS = require('./lib/local-https.js');

const ROOT = __dirname, PUB = path.join(ROOT, 'public');
const DATA = process.env.UCIRP_DATA || path.join(ROOT, 'data');
const PORT = +process.env.PORT || 8080, SPORT = +process.env.HTTPS_PORT || 8443;
const H = 36e5, now = () => Date.now();
const { DEPTS, AGENCIES, DEPT_AGENCIES, WARDS, CATS } = REF;
const DONE_WO = ['Verified', 'Completed', 'Cancelled'];

const store = new CityStore(DATA), UP = store.up;
let db = null;

/* ------------------------------------------------------------------ domain helpers */
class E extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = m => { throw new E(400, m); }, deny = m => { throw new E(403, m); }, conflict = m => { throw new E(409, m); };
const I = id => db.S.issues.find(i => i.id === id), W = id => db.S.wos.find(w => w.id === id);
const needI = id => I(id) || (() => { throw new E(404, 'Issue ' + id + ' not found'); })();
const needW = id => W(id) || (() => { throw new E(404, 'Work order ' + id + ' not found'); })();
// every state change, override and merge goes through log(): this is the audit trail
const log = (a, act, ref, note = '') => { db.S.audit.unshift({ t: now(), a, act, ref, note }); if (db.S.audit.length > 5000) db.S.audit.length = 5000; };
const notify = (u, m) => { if (!u || !db.users[u]) return; db.S.notes.unshift({ u, m, t: now(), read: false, ch: 'in-app' }); if (db.S.notes.length > 5000) db.S.notes.length = 5000; };
const fmt = t => new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const str = (v, min, max, name) => { if (typeof v !== 'string') bad(name + ' is required'); v = v.trim(); if (v.length < min) bad(min <= 1 ? name + ' is required' : name + ' must be at least ' + min + ' characters'); if (v.length > max) bad(name + ' must be at most ' + max + ' characters'); return v; };
const num = (v, min, max, name) => { if (typeof v !== 'number' || !isFinite(v) || v < min || v > max) bad(name + ' must be a number between ' + min + ' and ' + max); return v; };

const officersOf = i => Object.keys(db.users).filter(k => db.users[k].role === 'officer' && db.users[k].ward === i.ward && db.users[k].depts.includes(i.dept));
const offFor = i => officersOf(i)[0] || Object.keys(db.users).find(k => db.users[k].role === 'officer' && db.users[k].ward === i.ward) || 'o1';
const supsFor = dept => Object.keys(db.users).filter(k => db.users[k].role === 'supervisor' && db.users[k].depts.includes(dept));
const isOfficerOf = (u, i) => u.role === 'officer' && u.ward === i.ward && u.depts.includes(i.dept);
// who may review / override / reassign a work order
const managesWO = (u, w) => { const i = I(w.issue); return (u.role === 'supervisor' && u.depts.includes(w.dept)) || (u.role === 'officer' && u.ward === i.ward && (u.depts.includes(w.dept) || u.depts.includes(i.dept))); };
const deptSla = d => (db.S.deptSla && db.S.deptSla[d]) || DEPTS[d].sla;
const score = i => CA.score(i, db.S.weights);

function recalc(i) {
  const ws = i.wos.map(W).filter(w => w.status !== 'Cancelled'); if (!ws.length) return;
  if (ws.every(w => ['Verified', 'Completed'].includes(w.status))) { if (!['Resolved', 'Closed'].includes(i.status)) { i.status = 'Resolved'; i.resolvedAt = now(); log('system', 'Issue resolved – awaiting citizen confirmation', i.id, 'Auto-closes in ' + CA.AUTO_CLOSE_DAYS + ' days if there is no reply'); i.by.forEach(c => notify(c, i.id + ': repair verified. Please confirm the fix.')); } }
  else if (ws.some(w => w.status === 'In Progress')) i.status = 'In Progress';
  else if (i.status !== 'Reopened' && i.status !== 'Escalated') i.status = 'Assigned';
}
// runs at start-up and every 30 seconds: At Risk at 75% of the SLA time, escalation on breach, auto-close after 7 silent days
function checkSLA() {
  let ch = false; const t = now();
  db.S.wos.forEach(w => {
    if (DONE_WO.includes(w.status)) return; const i = I(w.issue); if (!i) return; const s = CA.slaState(w, t);
    if (s.state === 'Breached' && !w.esc) { w.esc = true; i.status = 'Escalated'; log('system', 'SLA breach – auto escalated', w.id, 'Due ' + fmt(w.due)); [offFor(i), ...supsFor(w.dept), w.crew].forEach(u => notify(u, w.id + ' breached its SLA and was escalated.')); ch = true; }
    else if (s.state === 'At Risk' && !w.risk) { w.risk = true; log('system', 'SLA at risk – 75% of the time used', w.id, 'Due ' + fmt(w.due)); [offFor(i), w.crew].forEach(u => notify(u, w.id + ' is At Risk: 75% of its SLA time is used.')); ch = true; }
  });
  db.S.issues.forEach(i => {
    if (i.status !== 'Resolved' || !i.resolvedAt || t - i.resolvedAt < CA.AUTO_CLOSE_DAYS * 24 * H) return;
    i.status = 'Closed'; i.autoClosed = true; i.closedAt = t; log('system', 'Auto-closed – no citizen response in ' + CA.AUTO_CLOSE_DAYS + ' days', i.id, 'Flagged: closed without confirmation');
    i.by.forEach(u => notify(u, i.id + ' was closed automatically because nobody confirmed or disputed the repair in ' + CA.AUTO_CLOSE_DAYS + ' days.')); notify(offFor(i), i.id + ' auto-closed without citizen confirmation.'); ch = true;
  });
  for (const k of Object.keys(db.revoked)) if (db.revoked[k] * 1000 < t) { delete db.revoked[k]; ch = true; }
  if (ch) { store.save(); changed(); }
}

/* ---- duplicates: scoring lives in CityAlgorithms, linking and merging here ---- */
const matchDups = (d, uid, includeOwn) => CA.findDuplicates(d, db.S.issues).filter(m => includeOwn || !I(m.id).by.includes(uid));
const dupRef = m => ({ id: m.id, s: m.s, geo: m.geo, text: m.text, image: m.image, d: m.d });
function linkReport(i, r) { i.reports = (i.reports || []).concat([r]); i.ph = (i.ph || []).concat(r.ph || []).slice(0, 12); }
function mergeIssues(src, dst, uid, why) {
  if (src.id === dst.id) bad('Choose a different issue');
  if (!CA.isOpen(src) || !CA.isOpen(dst)) conflict('Both issues must be open to merge them');
  if (src.wos.length) conflict(src.id + ' already has work orders. Merge the other issue into it instead.');
  const add = src.by.filter(u => !dst.by.includes(u)); dst.by.push(...add); dst.support += Math.max(0, src.support - (src.by.length - add.length));
  linkReport(dst, { u: src.by[0], t: src.t, desc: src.desc, photos: src.photos || [], ph: src.ph || [], lat: src.lat, lng: src.lng, from: src.id, s: src.dup && src.dup.id === dst.id ? src.dup.s : null });
  (src.reports || []).forEach(r => linkReport(dst, r));
  dst.sev = Math.max(dst.sev, src.sev); dst.safety = Math.max(dst.safety, src.safety); dst.sens = Math.max(dst.sens, src.sens);
  if (dst.dup && dst.dup.id === src.id) dst.dup = null;
  db.S.issues.forEach(x => { if (x.dup && x.dup.id === src.id) x.dup.id = dst.id; });
  src.status = 'Merged'; src.mergedInto = dst.id; src.dup = null;
  log(uid, 'Merged duplicate into ' + dst.id, src.id, why); log(uid, 'Merged in duplicate ' + src.id, dst.id, why);
  src.by.forEach(u => notify(u, src.id + ' was merged into ' + dst.id + ' because both describe the same problem. Track ' + dst.id + ' from now on.'));
  return { ok: true, merged: src.id, into: dst.id };
}
function recurrenceOf(d) { const n = db.S.issues.filter(i => i.cat === d.cat && CA.hav(i, d) < 200 && now() - i.t < 180 * 24 * H).length; return Math.min(1, n * .5); }

/* ---- simulated CivicFix AI: a transparent rule engine, no live model ---- */
function localAI(d, uid) {
  const g = CA.guessSev(d.desc), near = CA.sensitiveNear(d), s = d.desc.toLowerCase(), hits = (s.match(/deep|accident|live wire|spark|overflow|collapse|flood|school|child|hospital|open manhole|fallen|sewage|injur|dark|leak|burst|smell|week/g) || []).length, dups = matchDups(d, uid, false), pc = CA.guessCat(d.desc);
  return {
    simulated: true, category: d.cat, defect: CA.DEFECT[d.cat] || d.cat, suggested: pc && pc !== d.cat ? pc : null, severity: d.sos ? 1 : g.sev, safety: g.safety, sensitive: Math.max(g.sens, near.s),
    poi: near.s ? near.poi.n + ' is ' + near.poi.d + ' m away' : null, confidence: Math.min(92, 58 + hits * 8 + (d.desc.length > 60 ? 6 : 0)),
    reason: 'Description keywords and location were scored by the built-in rules' + (hits ? ' (' + hits + ' risk term' + (hits > 1 ? 's' : '') + ' found)' : '') + (near.s ? '; ' + near.poi.n + ' is ' + near.poi.d + ' m away' : '') + (dups.length ? '; ' + dups.length + ' similar open issue(s) nearby.' : '.'), duplicates: dups.map(m => m.id)
  };
}
const REPAIR = {
  'Pothole / damaged road': 'Barricade the lane, cut the pothole edges square, fill with hot/cold mix in layers and compact. Photograph the finished surface.',
  'Broken footpath': 'Cordon the stretch, remove broken slabs, relay on a compacted bed and level the joints.',
  'Fallen tree / branch': 'Cordon the area, check for snapped cables with TANGEDCO before cutting, then cut and clear the debris.',
  'Garbage accumulation': 'Clear the heap with a compactor trip, disinfect with bleaching powder, and check the bin and collection schedule.',
  'Stray animal menace': 'Coordinate with the animal birth control team, capture humanely and record the location for follow-up.',
  'Public toilet maintenance': 'Deep clean, restore water supply and lighting, repair fittings and record the caretaker roster.',
  'Broken streetlight': 'Isolate the supply, replace the lamp/driver and fuse, test after dusk and note the pole number.',
  'Water leakage': 'Isolate the valve, excavate and repair or replace the damaged section, pressure test, then backfill for road reinstatement.',
  'Blocked drain': 'Open the nearest manholes, clear silt with a jetting or desilting machine, and confirm free flow downstream.'
};
function ruleBrief(i) {
  const sc = score(i).total;
  return { summary: `${i.cat} reported at ${i.street} (${i.landmark}). ${i.support} citizen(s) support it, priority is ${sc}/100 (${CA.band(sc)}) and it is ${i.status}.`, tamil: `${i.street} பகுதியில் "${i.cat}" புகார் பதிவாகியுள்ளது. ${i.support} பேர் ஆதரித்துள்ளனர். முன்னுரிமை ${sc}/100. தற்போதைய நிலை: ${i.status}.`, risk: i.sos ? 'Filed as an SOS: treat as an immediate public-safety hazard.' : i.safety > .6 ? 'Elevated public-safety risk based on the safety score.' : 'Moderate risk based on the safety score.', repair: REPAIR[i.cat] || 'Inspect the site, make the area safe, then repair and photograph the result.', update: 'Your report is being handled by ' + DEPTS[i.dept].n + ' (' + AGENCIES[i.agency].s + '). Current status: ' + i.status + '.', src: 'Simulated CivicFix AI: generated by the built-in rule engine on ' + fmt(now()) + ', not by a live AI model. Review before acting.' };
}
function analytics() {
  const cl = [], all = db.S.issues.filter(i => i.status !== 'Merged');
  all.slice().sort((a, b) => a.t - b.t).forEach(i => { const c = cl.find(c => c.cat === i.cat && CA.hav(c, i) < 250); if (c) c.items.push(i); else cl.push({ cat: i.cat, lat: i.lat, lng: i.lng, street: i.street, ward: i.ward, items: [i] }); });
  const recurrence = cl.map(c => ({ cat: c.cat, street: c.street, ward: c.ward, lat: c.lat, lng: c.lng, count: c.items.length, open: c.items.filter(CA.isOpen).length, flagged: c.items.some(i => i.recur >= .5), last: Math.max(...c.items.map(i => i.t)), ids: c.items.map(i => i.id) })).filter(c => c.count > 1 || c.flagged).sort((a, b) => b.count - a.count || b.last - a.last);
  const byAgency = {}; all.forEach(i => { const a = byAgency[i.agency] = byAgency[i.agency] || { total: 0, open: 0 }; a.total++; if (CA.isOpen(i) && i.status !== 'Resolved') a.open++; });
  const sla = { 'On Track': 0, 'At Risk': 0, Breached: 0 }; db.S.wos.forEach(w => { if (!DONE_WO.includes(w.status)) sla[CA.slaState(w, now()).state]++; });
  const dup = { linked: db.S.issues.reduce((a, i) => a + (i.reports || []).length, 0), merged: db.S.issues.filter(i => i.status === 'Merged').length, pending: db.S.issues.filter(i => i.dup && CA.isOpen(i)).length, autoClosed: db.S.issues.filter(i => i.autoClosed).length };
  return { recurrence, byAgency, sla, dup };
}

/* ------------------------------------------------------------------ photos */
function parsePhoto(dataUrl, name) {
  if (typeof dataUrl !== 'string') bad(name + ' is required');
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl); if (!m) bad(name + ' must be a JPEG, PNG or WebP image');
  const buf = Buffer.from(m[2], 'base64'); if (buf.length < 4) bad(name + ' is empty'); if (buf.length > 4 * 1024 * 1024) bad(name + ' is too large (max 4 MB)');
  const ok = m[1] === 'jpeg' ? buf[0] === 0xFF && buf[1] === 0xD8 : m[1] === 'png' ? buf[0] === 0x89 && buf[1] === 0x50 : buf.slice(0, 4).toString() === 'RIFF';
  if (!ok) bad(name + ' is not a valid image file');
  return { buf, ext: m[1] === 'jpeg' ? 'jpg' : m[1] };
}
function writePhoto(p) { const f = crypto.randomBytes(12).toString('hex') + '.' + p.ext; fs.writeFileSync(path.join(UP, f), p.buf); return '/uploads/' + f; }
const savePhoto = (dataUrl, name) => writePhoto(parsePhoto(dataUrl, name));

/* ------------------------------------------------------------------ live location + SSE */
const live = {};            // crewId -> {lat,lng,acc,spd,hdg,t}   (memory only)
const clients = new Set();  // {res, uid}
const activeCrew = k => db.S.wos.some(w => w.crew === k && ['Accepted', 'In Progress'].includes(w.status));
const canSeeLive = (uid, crew) => { const u = db.users[uid]; return !!u && (u.role !== 'citizen' || activeCrew(crew)); };
function send(c, ev, data) { try { c.res.write('event: ' + ev + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (e) { clients.delete(c); } }
let chT = null; function changed() { if (!chT) chT = setTimeout(() => { chT = null; clients.forEach(c => send(c, 'change', { t: now() })); }, 60); }
setInterval(() => clients.forEach(c => { try { c.res.write(': ping\n\n'); } catch (e) { clients.delete(c); } }), 25000).unref();
setInterval(() => { for (const k of Object.keys(live)) if (now() - live[k].t > 10 * 60000) { delete live[k]; clients.forEach(c => send(c, 'loc', { u: k, gone: true })); } }, 60000).unref();

/* ------------------------------------------------------------------ what each role is allowed to see */
const pubUser = k => { const u = db.users[k]; return { n: u.n, role: u.role, depts: u.depts, ward: u.ward, dept: u.dept }; };
function stateFor(uid) {
  const S = db.S, u = uid && db.users[uid], depts = {}; Object.keys(DEPTS).forEach(k => depts[k] = { n: DEPTS[k].n, sla: deptSla(k) });
  const ref = { depts, agencies: AGENCIES, deptAgencies: DEPT_AGENCIES, wards: WARDS, cats: CATS };
  const demo = Object.keys(db.users).filter(k => db.users[k].seed).map(k => ({ id: k, n: db.users[k].n, role: db.users[k].role }));
  if (!u) return { me: null, ...ref, demo, users: {}, live: {}, S: { weights: S.weights, karmaPts: S.karmaPts, karma: 0, audit: [], notes: [], issues: S.issues.filter(i => i.status !== 'Merged').map(i => ({ id: i.id, cat: i.cat, dept: i.dept, agency: i.agency, ward: i.ward, street: i.street, status: i.status, support: i.support, sev: i.sev, safety: i.safety, sens: i.sens, recur: i.recur, sos: i.sos, po: i.po ? { s: i.po.s } : undefined, lat: i.lat, lng: i.lng, t: i.t, by: [], wos: [] })), wos: S.wos.map(w => ({ id: w.id, status: w.status, t: w.t, due: w.due, dept: w.dept })) } };
  const staff = u.role !== 'citizen', users = {};
  Object.keys(db.users).forEach(k => { if (staff || db.users[k].role !== 'citizen' || k === uid) users[k] = pubUser(k); });
  const lv = {}; Object.keys(live).forEach(k => { if (canSeeLive(uid, k)) lv[k] = { u: k, ...live[k] }; });
  const out = { me: uid, ...ref, demo, users, live: lv, S: { weights: S.weights, karmaPts: S.karmaPts, karma: S.karma[uid] || 0, notes: S.notes.filter(n => n.u === uid).slice(0, 200) } };
  if (staff) { out.S.issues = S.issues; out.S.wos = S.wos; out.S.audit = S.audit.slice(0, 1500); }
  else {
    // citizens never see who else reported or supported an issue
    out.S.issues = S.issues.map(i => ({ ...i, by: i.by.includes(uid) ? [uid] : [], reports: (i.reports || []).map(r => ({ ...r, u: r.u === uid ? uid : 'Citizen' })) })); out.S.wos = S.wos;
    out.S.audit = S.audit.filter(a => /^(I-|WO-)/.test(a.ref)).slice(0, 1500).map(a => (a.a === 'system' || a.a === uid || (db.users[a.a] && db.users[a.a].role !== 'citizen')) ? a : { ...a, a: 'Citizen' });
  }
  if (u.role === 'admin') out.S.analytics = analytics();
  return out;
}

/* ------------------------------------------------------------------ routes (registered by the controllers) */
const routes = [];
const R = (method, pattern, roles, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), roles, fn });
function claimsOf(req) { const c = Auth.verify(Auth.tokenFrom(req), db.secret); return c && !db.revoked[c.jti] && db.users[c.sub] ? c : null; }

/* ------------------------------------------------------------------ http plumbing */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json' };
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https://nominatim.openstreetmap.org; frame-ancestors 'none'";
function json(res, status, obj) { const b = JSON.stringify(obj); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(b); }
// request size limit: 3 photos of up to 4 MB each, base64-encoded
function readBody(req) { return new Promise((ok, no) => { let n = 0; const ch = []; req.on('data', d => { n += d.length; if (n > 18 * 1024 * 1024) { no(new E(413, 'Request is too large')); req.destroy(); } else ch.push(d); }); req.on('end', () => ok(Buffer.concat(ch).toString('utf8'))); req.on('error', no); }); }
// only files inside public/ and data/uploads/ can ever be served
function serveFile(res, base, rel) {
  const f = path.normalize(path.join(base, rel)); if (!f.startsWith(base + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, buf) => { if (e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); } res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': base === UP || rel.includes('vendor') ? 'public, max-age=86400' : 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP, 'Referrer-Policy': 'same-origin' }); res.end(buf); });
}
async function handle(req, res) {
  let url; try { url = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
  let p; try { p = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (!p.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (p.startsWith('/uploads/')) return serveFile(res, UP, p.slice(9));
    return serveFile(res, PUB, p === '/' ? 'index.html' : p.slice(1));
  }
  const claims = claimsOf(req), uid = claims ? claims.sub : null;
  if (p === '/api/events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.write('retry: 3000\n\n');
    const c = { res, uid }; clients.add(c); req.on('close', () => clients.delete(c)); return;
  }
  try {
    const cand = routes.filter(r => r.re.test(p)); if (!cand.length) throw new E(404, 'Unknown API endpoint');
    const r = cand.find(r => r.method === req.method); if (!r) throw new E(405, 'Method not allowed');
    let body = {};
    if (req.method !== 'GET') {
      if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw new E(415, 'Send JSON (Content-Type: application/json)');
      const raw = await readBody(req); try { body = raw ? JSON.parse(raw) : {}; } catch (e) { throw new E(400, 'Body is not valid JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new E(400, 'Body must be a JSON object');
    }
    // route guard: the role inside the verified token decides what is allowed
    const u = uid ? { id: uid, ...db.users[uid] } : null;
    if (r.roles) { if (!u) throw new E(401, 'Sign in first'); if (!r.roles.includes(u.role)) throw new E(403, 'Your role (' + u.role + ') is not allowed to do this'); }
    const out = r.fn({ req, res, body, uid, u, claims, p: r.re.exec(p).groups || {}, ip: req.socket.remoteAddress || '' });
    if (req.method !== 'GET' && !(out && out.noSave)) { await store.flush(); changed(); } // written to the database before the reply, so nothing is lost if the window is closed
    if (out && out.noSave) delete out.noSave;
    json(res, 200, out);
  } catch (e) {
    if (e instanceof E) return json(res, e.status, { error: e.message });
    console.error(e); json(res, 500, { error: 'Server error' });
  }
}

async function main() {
  db = await store.load();
  const ctx = { R, db, store, CA, Auth, REF, H, now, E, bad, deny, conflict, I, W, needI, needW, log, notify, fmt, str, num, wardOf, officersOf, offFor, supsFor, isOfficerOf, managesWO, deptSla, score, recalc, checkSLA, matchDups, dupRef, linkReport, mergeIssues, recurrenceOf, localAI, ruleBrief, analytics, parsePhoto, writePhoto, savePhoto, live, clients, send, canSeeLive, stateFor, DONE_WO };
  ['auth', 'shared', 'citizen', 'authority'].forEach(n => require('./controllers/' + n + '.js')(ctx));
  checkSLA(); setInterval(checkSLA, 30000).unref();
  const hp = await TLS.listen(http.createServer(handle), PORT, process.env.PORT ? 0 : 10);
  let sp = 0; if (process.env.UCIRP_NO_HTTPS !== '1') { try { const t = TLS.tlsOptions(DATA); sp = await TLS.listen(https.createServer({ key: t.key, cert: t.cert }, handle), SPORT, process.env.HTTPS_PORT ? 0 : 10); } catch (e) { console.log('! HTTPS could not start: ' + e.message); } }
  if (!hp && !sp) { console.log('The server could not start.'); process.exit(1); }
  const ips = TLS.lanIPs();
  console.log('\n  UCIRP is running. Keep this window open.\n');
  if (hp && process.env.UCIRP_OPEN === '1' && process.platform === 'win32') require('child_process').exec('start "" http://localhost:' + hp);
  if (hp) console.log('  On this computer:       http://localhost:' + hp);
  if (sp && ips.length) { console.log('  On a phone (same Wi-Fi): ' + ips.map(i => 'https://' + i + ':' + sp).join('   or   ')); console.log('     The phone shows a certificate warning once: tap Advanced > Proceed.\n     Phones need this https address for GPS to work.'); }
  console.log('\n  Demo logins: c1 (citizen), o1 (ward officer), w1 (field engineer), s1 (supervisor), a1 (admin)\n  Password for all demo logins: ' + DEMO_PASSWORD + '\n  Data is saved in: ' + DATA + '\n  Press Ctrl+C to stop.\n');
}
const bye = () => store.close().catch(() => { }).then(() => process.exit(0));
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
main().catch(e => { console.error('\nCould not start: ' + e.message); process.exit(1); });