'use strict';
// End-to-end API tests for every UCIRP workflow.  Run:  npm test   (or: node --test test/workflow.test.js)
// A private server is started on a spare port with a temporary data folder, so real data is never touched.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const PORT = 18000 + Math.floor(Math.random() * 2000), BASE = 'http://127.0.0.1:' + PORT;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ucirp-test-'));
const JPEG = 'data:image/jpeg;base64,/9j/2Q==';
let proc;
function start() {
  return new Promise((ok, no) => {
    proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), UCIRP_DATA: DATA, UCIRP_NO_HTTPS: '1' } });
    let out = ''; proc.stdout.on('data', d => { out += d; if (out.includes('is running')) ok(); }); proc.stderr.on('data', d => process.stderr.write(d));
    proc.on('exit', c => no(new Error('server exited ' + c + '\n' + out))); setTimeout(() => no(new Error('server start timeout')), 15000);
  });
}
const stop = () => new Promise(ok => { if (!proc || proc.exitCode !== null) return ok(); proc.removeAllListeners('exit'); proc.on('exit', ok); proc.kill(); });
// a tiny HTTP client with its own cookie (one per signed-in person)
function client() {
  let cookie = '';
  const call = async (method, url, body, raw) => {
    const r = await fetch(BASE + url, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': raw ? 'text/plain' : 'application/json' } : {}) }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let j = null; try { j = await r.json(); } catch (e) { } return { s: r.status, j };
  };
  return { get: u => call('GET', u), post: (u, b) => call('POST', u, b || {}), put: (u, b) => call('PUT', u, b), raw: (u, b, ct) => call('POST', u, b, true), login: async (login, password = 'demo123') => { const r = await call('POST', '/api/auth/login', { login, password }); assert.equal(r.s, 200, 'login ' + login); return r; } };
}
const who = {}; const as = async k => who[k] || (who[k] = await (async () => { const c = client(); await c.login(k); return c; })());
const issue = async (c, id) => (await c.get('/api/state')).j.S.issues.find(i => i.id === id);
const wo = async (c, id) => (await c.get('/api/state')).j.S.wos.find(w => w.id === id);
const ok = (r, m) => assert.equal(r.s, 200, (m || '') + ' → ' + r.s + ' ' + JSON.stringify(r.j));
const is = (r, code, m) => assert.equal(r.s, code, (m || '') + ' → ' + r.s + ' ' + JSON.stringify(r.j));
const report = (over = {}) => ({ cat: 'Pothole / damaged road', desc: 'Deep pothole near the school gate, bikes are skidding.', ward: '45', street: 'Cross Cut Road, Gandhipuram', landmark: 'Opp. bus stand gate 2', lat: 11.0170, lng: 76.9670, acc: 8, photo: JPEG, ...over });

before(start);
after(async () => { await stop(); fs.rmSync(DATA, { recursive: true, force: true }); });

let A, B; // issue ids: A = normal complaint, B = SOS water leak with a joint work order
let newCitizen;

test('public visitors get only a sanitised view', async () => {
  const r = await client().get('/api/state'); ok(r); assert.equal(r.j.me, null);
  assert.ok(r.j.S.issues.length >= 6); assert.equal(r.j.S.issues[0].desc, undefined); assert.deepEqual(r.j.S.issues[0].by, []); assert.equal(r.j.S.audit.length, 0);
  assert.equal(r.j.demo.some(d => d.hash || d.salt), false);
});

test('unauthenticated and malformed requests are rejected', async () => {
  const c = client();
  is(await c.post('/api/issues', report()), 401, 'report without login');
  is(await c.get('/api/audit'), 401); is(await c.get('/api/issues'), 401);
  is(await c.raw('/api/auth/login', 'login=c1'), 415, 'non-JSON body');
  is(await c.post('/api/auth/login', { login: 'c1', password: 'wrong' }), 401, 'wrong password');
  is(await c.post('/api/auth/login', { login: 'c1' }), 400, 'missing password');
  is(await c.get('/api/nope'), 404);
  const t = await fetch(BASE + '/..%2Fserver.js'); assert.notEqual(t.status, 200, 'path traversal must not serve server.js');
  const d = await fetch(BASE + '/../data/db.json'); assert.notEqual((await d.text()).includes('"hash"'), true);
});

test('seeded SLA breach was auto-escalated with notifications', async () => {
  const o2 = await as('o2'), i = await issue(o2, 'I-1002'); assert.equal(i.status, 'Escalated');
  const st = (await o2.get('/api/state')).j.S; assert.ok(st.notes.some(n => /WO-2002 breached/.test(n.m))); assert.ok(st.audit.some(a => /SLA breach/.test(a.act) && a.ref === 'WO-2002'));
});

test('citizen registration is validated', async () => {
  const c = client();
  is(await c.post('/api/auth/register', { name: 'Anu', phone: '12345', password: 'secret1' }), 400, 'bad phone');
  is(await c.post('/api/auth/register', { name: '<b>x</b>', phone: '9876543210', password: 'secret1' }), 400, 'bad name');
  is(await c.post('/api/auth/register', { name: 'Anu K', phone: '9876543210', password: '123' }), 400, 'short password');
  ok(await c.post('/api/auth/register', { name: 'Anu K', phone: '9876543210', password: 'secret1' }), 'register');
  is(await client().post('/api/auth/register', { name: 'Anu K', phone: '9876543210', password: 'secret1' }), 409, 'duplicate phone');
  const s = (await c.get('/api/state')).j; assert.equal(s.users[s.me].role, 'citizen'); newCitizen = c;
  const again = client(); ok(await again.post('/api/auth/login', { login: '9876543210', password: 'secret1' }), 'login with mobile number');
});

test('citizen reports a complaint with photo and GPS; inputs are validated', async () => {
  const c1 = await as('c1');
  is(await c1.post('/api/issues', report({ desc: 'short' })), 400, 'short description');
  is(await c1.post('/api/issues', report({ photo: undefined })), 400, 'photo is mandatory');
  is(await c1.post('/api/issues', report({ photo: 'data:image/jpeg;base64,AAAA' })), 400, 'fake image');
  is(await c1.post('/api/issues', report({ cat: 'Aliens' })), 400, 'unknown category');
  is(await c1.post('/api/issues', report({ lat: 'x' })), 400, 'bad latitude');
  is(await c1.post('/api/issues', report({ landmark: '' })), 400, 'landmark is mandatory');
  is(await c1.post('/api/issues', report({ photo: undefined, photos: [JPEG, JPEG, JPEG, JPEG] })), 400, 'at most three photos');
  is(await c1.post('/api/issues', report({ photo: undefined, photos: [JPEG, 'data:image/jpeg;base64,AAAA'] })), 400, 'every photo is checked');
  const r = await c1.post('/api/issues', report()); ok(r, 'file complaint'); A = r.j.id; assert.equal(r.j.dept, 'roads'); assert.equal(r.j.agency, 'GCC');
  const i = await issue(c1, A); assert.equal(i.status, 'Under Verification'); assert.match(i.before, /^\/uploads\/[a-f0-9]+\.jpg$/); assert.equal(i.acc, 8); assert.ok(i.sens >= .9, 'school raises sensitivity');
  const img = await fetch(BASE + i.before); assert.equal(img.status, 200);
  const full = await c1.get('/api/issues/' + A); ok(full); assert.ok(full.j.priority.total > 0 && full.j.priority.total <= 100); assert.equal(Object.keys(full.j.priority.parts).length, 5, 'explainable priority has 5 parts');
  assert.ok((await (await as('o1')).get('/api/state')).j.S.notes.some(n => n.m.includes(A)), 'ward officer notified');
});

test('agency routing: GCC, State Highways, TANGEDCO and CMWSSB', async () => {
  const c1 = await as('c1');
  const h = await c1.post('/api/issues', report({ street: 'Avinashi Road flyover', lat: 11.0262, lng: 77.0100, ward: '30', desc: 'Large crater on the Avinashi road carriageway near the flyover.' })); ok(h); assert.equal(h.j.agency, 'SH');
  const e = await c1.post('/api/issues', report({ cat: 'Broken streetlight', street: 'Bharathi Park Road', lat: 11.0240, lng: 76.9450, desc: 'Live wire hanging from the electric pole and sparks at night.' })); ok(e); assert.equal(e.j.agency, 'TANGEDCO');
  const w = await c1.post('/api/issues', report({ cat: 'Water leakage', street: 'DB Road', lat: 11.0060, lng: 76.9530, desc: 'Drinking water pipeline burst, water flowing for two days.' })); ok(w); assert.equal(w.j.agency, 'CMWSSB');
});

test('duplicate detection offers support instead of a second report', async () => {
  const c2 = await as('c2'), d = report({ lat: 11.0171, lng: 76.9671, desc: 'Big pothole close to the school gate, very risky for bikes.' }); delete d.photo;
  const r = await c2.post('/api/issues/check', d); ok(r); assert.ok(r.j.duplicates.some(x => x.id === A), 'finds the nearby report'); assert.equal(r.j.ai.simulated, true);
  ok(await c2.post(`/api/issues/${A}/support`), 'support'); is(await c2.post(`/api/issues/${A}/support`), 409, 'cannot support twice');
  assert.equal((await issue(c2, A)).support, 2);
  const mine = await (await as('c1')).post('/api/issues/check', d); assert.equal(mine.j.duplicates.some(x => x.id === A), false, 'own report is not offered as a duplicate');
});

test('SOS is fast-tracked to the top priority', async () => {
  const c2 = await as('c2'), r = await c2.post('/api/issues', report({ cat: 'Water leakage', sos: true, street: 'Sastri Road, Ram Nagar', lat: 11.0125, lng: 76.9640, desc: 'Water main burst and the road is flooding quickly.' })); ok(r); B = r.j.id;
  const full = await c2.get('/api/issues/' + B); assert.equal(full.j.priority.total, 100); assert.equal(full.j.sos, true);
  assert.ok((await (await as('s2')).get('/api/state')).j.S.notes.some(n => n.m.includes('SOS ' + B)), 'supervisor alerted');
});

test('only the right ward officer can verify; info request and reply work', async () => {
  const o1 = await as('o1'), c1 = await as('c1');
  is(await (await as('o2')).post(`/api/issues/${A}/verify`), 403, 'officer of another ward');
  is(await (await as('o4')).post(`/api/issues/${A}/verify`), 403, 'officer of another department');
  is(await c1.post(`/api/issues/${A}/verify`), 403, 'citizen'); is(await (await as('w1')).post(`/api/issues/${A}/verify`), 403, 'crew');
  is(await o1.post(`/api/issues/${A}/work-orders`, { crew: 'w1', hours: 24, instr: 'Fill the pothole' }), 409, 'work order before verification');
  is(await o1.post(`/api/issues/${A}/info`, { reason: 'x' }), 400, 'reason too short');
  ok(await o1.post(`/api/issues/${A}/info`, { reason: 'Which side of the road is it on?' })); assert.equal((await issue(o1, A)).status, 'Needs Info');
  is(await (await as('c2')).post(`/api/issues/${A}/reply`, { text: 'whatever it is' }), 200, 'supporter may reply');
  is(await c1.post(`/api/issues/${A}/reply`, { text: 'Left side towards the bus stand.' }), 409, 'already answered');
  assert.equal((await issue(o1, A)).status, 'Under Verification');
  is(await o1.post(`/api/issues/${A}/route`, { dept: 'roads', agency: 'CMWSSB' }), 400, 'agency that does not handle roads');
  ok(await o1.post(`/api/issues/${A}/route`, { dept: 'roads', agency: 'SH' })); assert.equal((await issue(o1, A)).agency, 'SH');
  ok(await o1.post(`/api/issues/${A}/route`, { dept: 'roads', agency: 'GCC' }));
  ok(await o1.post(`/api/issues/${A}/verify`), 'verify'); is(await o1.post(`/api/issues/${A}/verify`), 409, 'verify twice');
  is(await o1.post(`/api/issues/${A}/reject`, { reason: 'Changed my mind' }), 409, 'cannot reject after verification');
});

let WA; // work order of issue A
test('work order creation is validated and notifies the crew', async () => {
  const o1 = await as('o1');
  is(await o1.post(`/api/issues/${A}/work-orders`, { crew: 'w2', hours: 24, instr: 'Fill the pothole' }), 400, 'crew from the wrong department');
  is(await o1.post(`/api/issues/${A}/work-orders`, { crew: 'w1', hours: 0, instr: 'Fill the pothole' }), 400, 'bad SLA');
  is(await o1.post(`/api/issues/${A}/work-orders`, { crew: 'w1', hours: 24, instr: '' }), 400, 'no instructions');
  is(await (await as('s1')).post(`/api/issues/${A}/work-orders`, { crew: 'w1', hours: 24, instr: 'Fill the pothole' }), 403, 'supervisor cannot create');
  const r = await o1.post(`/api/issues/${A}/work-orders`, { crew: 'w1', hours: 24, instr: 'Cut, fill and compact the pothole' }); ok(r); WA = r.j.created[0];
  assert.equal((await issue(o1, A)).status, 'Assigned'); assert.ok((await (await as('w1')).get('/api/state')).j.S.notes.some(n => n.m.includes(WA)));
});

test('crew workflow: accept → live GPS → start → blocker → mandatory after-photo and remarks', async () => {
  const w1 = await as('w1'), c1 = await as('c1');
  is(await (await as('w2')).post(`/api/work-orders/${WA}/accept`), 403, 'another crew');
  is(await w1.post(`/api/work-orders/${WA}/start`), 409, 'start before accept');
  ok(await w1.post(`/api/work-orders/${WA}/accept`));
  is(await c1.post('/api/location', { lat: 11, lng: 76.9 }), 403, 'citizens cannot post crew locations');
  is(await w1.post('/api/location', { lat: 999, lng: 76.9 }), 400, 'invalid coordinates');
  ok(await w1.post('/api/location', { lat: 11.0300, lng: 76.9700, acc: 9 })); ok(await w1.post('/api/location', { lat: 11.0250, lng: 76.9690, acc: 7 }));
  const lv = (await c1.get('/api/live')).j; assert.ok(lv.w1 && Math.abs(lv.w1.lat - 11.025) < 1e-6, 'citizen sees the crew approaching');
  assert.equal((await wo(w1, WA)).trail.length, 2, 'route trail recorded');
  ok(await w1.post(`/api/work-orders/${WA}/start`)); assert.equal((await issue(c1, A)).status, 'In Progress');
  ok(await w1.post(`/api/work-orders/${WA}/progress`, { note: 'Edges cut, waiting for the mix' })); assert.ok((await c1.get('/api/state')).j.S.audit.some(a => a.act === 'Progress update' && a.ref === WA), 'progress appears in the citizen timeline');
  is(await w1.post(`/api/work-orders/${WA}/block`, { reason: '' }), 400);
  ok(await w1.post(`/api/work-orders/${WA}/block`, { reason: 'Road roller not available' })); assert.equal((await wo(w1, WA)).status, 'Blocked');
  ok(await w1.post(`/api/work-orders/${WA}/start`), 'resume after blocker');
  is(await w1.post(`/api/work-orders/${WA}/submit`, { remarks: 'Filled and compacted' }), 400, 'after-photo is mandatory');
  is(await w1.post(`/api/work-orders/${WA}/submit`, { photo: JPEG, remarks: '' }), 400, 'remarks are mandatory');
  ok(await w1.post(`/api/work-orders/${WA}/submit`, { photo: JPEG, remarks: 'Filled and compacted', loc: { lat: 11.01705, lng: 76.96702, acc: 6 } }));
  const w = await wo(w1, WA); assert.equal(w.status, 'Submitted for Verification'); assert.ok(w.subDist < 20, 'GPS check distance stored: ' + w.subDist); assert.match(w.afterImg, /^\/uploads\//);
  assert.equal((await c1.get('/api/live')).j.w1, undefined, 'tracking hidden from citizens once the job is no longer active');
});

test('evidence review: return for correction, then approve → Resolved', async () => {
  const o1 = await as('o1'), w1 = await as('w1');
  is(await (await as('c1')).post(`/api/work-orders/${WA}/review`, { approve: true }), 403, 'citizen');
  is(await (await as('s2')).post(`/api/work-orders/${WA}/review`, { approve: true }), 403, 'supervisor of other departments');
  is(await (await as('o2')).post(`/api/work-orders/${WA}/review`, { approve: true }), 403, 'officer of another ward');
  is(await o1.post(`/api/work-orders/${WA}/review`, { approve: false }), 400, 'return needs a reason');
  ok(await o1.post(`/api/work-orders/${WA}/review`, { approve: false, reason: 'Photo does not show the patch' })); assert.equal((await wo(o1, WA)).status, 'Rework Required');
  ok(await w1.post('/api/location/stop'), 'crew switches live location off');
  ok(await w1.post(`/api/work-orders/${WA}/accept`)); ok(await w1.post(`/api/work-orders/${WA}/start`)); ok(await w1.post(`/api/work-orders/${WA}/submit`, { photo: JPEG, remarks: 'Re-done with a clear photo' }));
  assert.equal((await wo(o1, WA)).subDist, null, 'no GPS fix is recorded honestly');
  ok(await (await as('s1')).post(`/api/work-orders/${WA}/review`, { approve: true }), 'department supervisor approves'); is(await o1.post(`/api/work-orders/${WA}/review`, { approve: true }), 409, 'already reviewed');
  const i = await issue(o1, A); assert.equal(i.status, 'Resolved'); assert.match(i.afterImg, /^\/uploads\//);
  assert.ok((await (await as('c1')).get('/api/state')).j.S.notes.some(n => n.m.includes(A + ': repair verified')));
});

test('citizen disputes → reopened → redo → confirms → closed with Civic Karma (paid once)', async () => {
  const c1 = await as('c1'), w1 = await as('w1'), o1 = await as('o1');
  is(await newCitizen.post(`/api/issues/${A}/confirm`), 403, 'someone else’s complaint');
  is(await o1.post(`/api/issues/${A}/confirm`), 403, 'officers cannot confirm for citizens');
  is(await c1.post(`/api/issues/${A}/dispute`, { reason: '' }), 400);
  ok(await c1.post(`/api/issues/${A}/dispute`, { reason: 'The patch has already sunk' })); assert.equal((await issue(c1, A)).status, 'Reopened'); assert.equal((await wo(c1, WA)).status, 'Rework Required');
  is(await c1.post(`/api/issues/${A}/confirm`), 409, 'cannot confirm while reopened');
  ok(await w1.post(`/api/work-orders/${WA}/accept`)); ok(await w1.post(`/api/work-orders/${WA}/start`)); ok(await w1.post(`/api/work-orders/${WA}/submit`, { photo: JPEG, remarks: 'Relaid properly' })); ok(await o1.post(`/api/work-orders/${WA}/review`, { approve: true }));
  const k0 = (await c1.get('/api/state')).j.S.karma;
  ok(await c1.post(`/api/issues/${A}/confirm`)); assert.equal((await issue(c1, A)).status, 'Closed'); assert.equal((await c1.get('/api/state')).j.S.karma, k0 + 10);
  is(await c1.post(`/api/issues/${A}/confirm`), 409, 'confirm twice'); is(await (await as('c2')).post(`/api/issues/${A}/support`), 409, 'closed issue');
});

test('linked departmental work orders: dependency blocks, override and reassign', async () => {
  const o1 = await as('o1'), w1 = await as('w1'), w2 = await as('w2');
  ok(await o1.post(`/api/issues/${B}/verify`));
  const r = await o1.post(`/api/issues/${B}/work-orders`, { crew: 'w2', hours: 48, instr: 'Isolate valve and repair the main', joint: 'GCC' }); ok(r); assert.equal(r.j.created.length, 2, 'water + dependent roads work order'); assert.equal(r.j.hours, 4, 'SOS is capped at a 4-hour SLA');
  { const w = await wo(o1, r.j.created[0]); assert.ok(w.due - w.t <= 4 * 36e5 + 5, 'SOS deadline is 4 hours after assignment'); assert.equal((await issue(o1, B)).agency2, 'GCC', 'joint dispatch recorded'); assert.equal((await wo(o1, r.j.created[1])).agency, 'GCC'); }
  const [wWater, wRoad] = r.j.created; assert.equal((await wo(o1, wRoad)).dep, wWater); assert.equal((await wo(o1, wRoad)).dept, 'roads');
  ok(await w1.post(`/api/work-orders/${wRoad}/accept`)); is(await w1.post(`/api/work-orders/${wRoad}/start`), 409, 'blocked by the unverified water repair');
  is(await w1.post(`/api/work-orders/${wRoad}/override`, { reason: 'I want to start now' }), 403, 'crew cannot override');
  is(await (await as('s1')).post(`/api/work-orders/${wRoad}/override`, { reason: 'ok' }), 400, 'override needs a reason');
  is(await (await as('s2')).post(`/api/work-orders/${wRoad}/reassign`, { crew: 'w1' }), 403, 'supervisor of other departments');
  is(await o1.post(`/api/work-orders/${wWater}/reassign`, { crew: 'w1' }), 400, 'crew of another department');
  ok(await w2.post(`/api/work-orders/${wWater}/accept`)); ok(await w2.post(`/api/work-orders/${wWater}/start`)); ok(await w2.post(`/api/work-orders/${wWater}/submit`, { photo: JPEG, remarks: 'Main repaired and pressure tested' }));
  assert.notEqual((await issue(o1, B)).status, 'Resolved');
  ok(await (await as('s2')).post(`/api/work-orders/${wWater}/review`, { approve: true })); assert.notEqual((await issue(o1, B)).status, 'Resolved', 'not resolved until every linked work order is verified');
  ok(await w1.post(`/api/work-orders/${wRoad}/start`), 'dependency satisfied'); ok(await w1.post(`/api/work-orders/${wRoad}/submit`, { photo: JPEG, remarks: 'Road surface reinstated' })); ok(await o1.post(`/api/work-orders/${wRoad}/review`, { approve: true }));
  assert.equal((await issue(o1, B)).status, 'Resolved');
  // override on the seeded dependent work order WO-2002 (ward 63)
  ok(await (await as('s1')).post('/api/work-orders/WO-2002/override', { reason: 'Temporary surface needed for traffic' })); ok(await w1.post('/api/work-orders/WO-2002/accept')); ok(await w1.post('/api/work-orders/WO-2002/start'), 'start after override');
});

test('rejection, briefing, admin settings, analytics and privacy', async () => {
  const c1 = await as('c1'), o1 = await as('o1'), a1 = await as('a1');
  const r = await c1.post('/api/issues', report({ cat: 'Broken footpath', street: 'Nehru Street', lat: 11.0190, lng: 76.9600, desc: 'Test report that should be rejected by the officer.' })); ok(r);
  is(await o1.post(`/api/issues/${r.j.id}/reject`, { reason: 'no' }), 400); ok(await o1.post(`/api/issues/${r.j.id}/reject`, { reason: 'Not a civic issue' })); assert.equal((await issue(o1, r.j.id)).status, 'Rejected');
  const b = await o1.post(`/api/issues/${A}/briefing`); ok(b); assert.match(b.j.briefing.src, /Simulated/); assert.ok(b.j.briefing.tamil.length > 10);
  is(await o1.put('/api/config/weights', { sev: 30, safety: 25, sens: 15, support: 15, recur: 15 }), 403, 'only admin changes weights');
  is(await a1.put('/api/config/weights', { sev: 99, safety: 25, sens: 15, support: 15, recur: 15 }), 400);
  ok(await a1.put('/api/config/weights', { sev: 40, safety: 25, sens: 15, support: 10, recur: 10 })); assert.equal((await a1.get('/api/state')).j.S.weights.sev, 40);
  const an = await a1.get('/api/analytics'); ok(an); assert.ok(Array.isArray(an.j.recurrence) && an.j.recurrence.length > 0); assert.ok(an.j.byAgency.GCC.total > 0); is(await o1.get('/api/analytics'), 403);
  is(await c1.get('/api/audit'), 403, 'citizens cannot read the audit log'); ok(await o1.get('/api/audit'));
  const cs = (await c1.get('/api/state')).j; assert.ok(cs.S.issues.every(i => i.by.every(u => u === 'c1')), 'other citizens are hidden'); assert.equal(cs.users.c2, undefined); assert.ok(cs.S.audit.every(a => a.a !== 'c2'));
  assert.equal(JSON.stringify(cs).includes('"hash"'), false, 'password hashes never leave the server');
  is(await o1.post('/api/admin/reset', { confirm: 'RESET' }), 403);
});


test('JWT: signed role token, bearer header, forgery and sign-out revocation', async () => {
  const r = await client().post('/api/auth/login', { login: 'o3', password: 'demo123' }); ok(r); const tok = r.j.token, parts = tok.split('.'); assert.equal(parts.length, 3);
  const head = JSON.parse(Buffer.from(parts[0], 'base64url')), body = JSON.parse(Buffer.from(parts[1], 'base64url')); assert.equal(head.alg, 'HS256'); assert.equal(body.sub, 'o3'); assert.equal(body.role, 'officer'); assert.ok(body.exp > body.iat);
  const bearer = t => fetch(BASE + '/api/issues', { headers: { Authorization: 'Bearer ' + t } }).then(x => x.status);
  assert.equal(await bearer(tok), 200, 'bearer token accepted');
  const forged = parts[0] + '.' + Buffer.from(JSON.stringify({ ...body, sub: 'a1', role: 'admin' })).toString('base64url') + '.' + parts[2]; assert.equal(await bearer(forged), 401, 'changed payload is rejected');
  const none = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url') + '.' + parts[1] + '.'; assert.equal(await bearer(none), 401, 'unsigned token is rejected');
  assert.equal((await fetch(BASE + '/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
  assert.equal(await bearer(tok), 401, 'token is revoked after sign-out');
});

test('SLA states: On Track, At Risk after 75% of the time, Breached', async () => {
  const s2 = await as('s2'), s1 = await as('s1'), o1 = await as('o1');
  assert.equal((await s2.get('/api/work-orders')).j.find(w => w.id === 'WO-2001').sla, 'At Risk', 'seeded order has used 83% of its time');
  assert.equal((await s1.get('/api/work-orders')).j.find(w => w.id === 'WO-2002').sla, 'Breached');
  const st = (await s2.get('/api/state')).j.S; assert.ok(st.audit.some(a => /SLA at risk/.test(a.act) && a.ref === 'WO-2001'), 'At Risk is in the audit log');
  assert.ok((await (await as('w2')).get('/api/state')).j.S.notes.some(n => /WO-2001 is At Risk/.test(n.m)), 'field engineer is warned');
  assert.ok((await o1.get('/api/work-orders')).j.some(w => w.sla === 'On Track'), 'a fresh work order is On Track');
});

let D1;
test('duplicate score S = 0.5 geo + 0.3 text + 0.2 image: auto-link, officer suggestion, new issue', async () => {
  const c1 = await as('c1'), c2 = await as('c2'), o1 = await as('o1'), HASH = 'ffff0000ffff0000';
  const base = { lat: 11.0100, lng: 76.9580, street: 'DB Road, RS Puram', landmark: 'In front of the bakery', desc: 'Large pothole in front of the bakery, cars are braking hard.', photo: undefined, photos: [JPEG, JPEG, JPEG], hashes: [HASH] };
  const r1 = await c1.post('/api/issues', report(base)); ok(r1); D1 = r1.j.id; assert.equal(r1.j.match, null, 'nothing similar yet'); assert.equal((await issue(c1, D1)).photos.length, 3, 'three photos stored');
  const n0 = (await o1.get('/api/state')).j.S.issues.length;
  // same spot, same words, same photo  ->  S >= 0.80  ->  linked automatically, no new issue
  const r2 = await c2.post('/api/issues', report({ ...base, lat: 11.01005, photos: [JPEG], desc: 'Large pothole in front of the bakery, cars braking hard' })); ok(r2);
  assert.equal(r2.j.linked, true); assert.equal(r2.j.id, D1); assert.ok(r2.j.match.s >= 0.8, 'S=' + r2.j.match.s); assert.equal((await o1.get('/api/state')).j.S.issues.length, n0, 'no second issue was created');
  let d1 = await issue(o1, D1); assert.equal(d1.support, 2); assert.equal(d1.reports.length, 1); assert.ok((await o1.get('/api/state')).j.S.audit.some(a => /auto-linked/.test(a.act) && a.ref === D1));
  // 40 m away, partly similar words, no photo match  ->  0.55-0.79  ->  new issue with a suggestion for the officer
  const r3 = await newCitizen.post('/api/issues', report({ ...base, lat: 11.01036, photos: [JPEG], hashes: [], desc: 'Pothole by the bakery is getting bigger' })); ok(r3);
  assert.equal(r3.j.linked, undefined); assert.equal(r3.j.match.id, D1); assert.ok(r3.j.match.s >= 0.55 && r3.j.match.s < 0.8, 'S=' + r3.j.match.s); const D2 = r3.j.id; assert.equal((await issue(o1, D2)).dup.id, D1);
  // far away  ->  below 0.55  ->  plain new issue
  const r4 = await c2.post('/api/issues', report({ ...base, lat: 11.0150, lng: 76.9520, photos: [JPEG], hashes: [] })); ok(r4); assert.equal(r4.j.match, null);
  // the citizen insists it is different: never linked silently, the officer decides
  const r5 = await c2.post('/api/issues', report({ ...base, lat: 11.01002, photos: [JPEG], distinct: true })); ok(r5); assert.equal(r5.j.linked, undefined); const D3 = r5.j.id; assert.ok((await issue(o1, D3)).dup.s >= 0.8);
  // officer: reject one suggestion (reason is mandatory and logged), accept the other (merge)
  is(await (await as('o2')).post('/api/issues/' + D2 + '/duplicate', { accept: true }), 403, 'officer of another ward');
  is(await c1.post('/api/issues/' + D2 + '/duplicate', { accept: true }), 403, 'citizens cannot merge');
  is(await o1.post('/api/issues/' + D3 + '/duplicate', { accept: false }), 400, 'rejecting needs a reason');
  ok(await o1.post('/api/issues/' + D3 + '/duplicate', { accept: false, reason: 'Second pothole on the other lane' })); assert.equal((await issue(o1, D3)).dup, null);
  is(await o1.post('/api/issues/' + D3 + '/duplicate', { accept: true }), 409, 'no suggestion left');
  ok(await o1.post('/api/issues/' + D2 + '/duplicate', { accept: true }));
  const d2 = await issue(o1, D2); assert.equal(d2.status, 'Merged'); assert.equal(d2.mergedInto, D1); d1 = await issue(o1, D1); assert.equal(d1.support, 3); assert.equal(d1.reports.length, 2);
  // manual merge = officer override of the system decision
  is(await o1.post('/api/issues/' + D3 + '/merge', { into: D1 }), 400, 'merge needs a reason'); is(await o1.post('/api/issues/' + D3 + '/merge', { into: D3, reason: 'same issue' }), 400);
  ok(await o1.post('/api/issues/' + D3 + '/merge', { into: D1, reason: 'Site visit: same pothole' })); is(await o1.post('/api/issues/' + D3 + '/merge', { into: D1, reason: 'again please' }), 409, 'already merged');
  const audit = (await o1.get('/api/audit')).j; for (const a of ['Duplicate suggestion rejected', 'Merged duplicate into ' + D1, 'Merged in duplicate ' + D2]) assert.ok(audit.some(x => x.act === a), 'audit has: ' + a);
  // privacy: a citizen never learns who else reported
  const mine = (await c1.get('/api/state')).j.S.issues.find(i => i.id === D1); assert.ok(mine.reports.every(x => x.u === 'c1' || x.u === 'Citizen')); assert.deepEqual(mine.by, ['c1']);
  assert.ok((await newCitizen.get('/api/state')).j.S.notes.some(n => n.m.includes('merged into ' + D1)), 'reporter is told about the merge');
});

test('officer priority override is explainable and logged; department SLA settings', async () => {
  const o1 = await as('o1'), a1 = await as('a1');
  const before = (await o1.get('/api/issues/' + D1)).j; assert.ok(before.priority.total >= 1 && before.priority.total <= 100); assert.ok(['Critical', 'High', 'Medium', 'Low'].includes(before.band)); assert.equal(before.stage, 'AE Review');
  is(await o1.post('/api/issues/' + D1 + '/priority', { score: 95 }), 400, 'override needs a reason'); is(await o1.post('/api/issues/' + D1 + '/priority', { score: 500, reason: 'too high' }), 400);
  is(await (await as('c1')).post('/api/issues/' + D1 + '/priority', { score: 95, reason: 'please hurry' }), 403);
  ok(await o1.post('/api/issues/' + D1 + '/priority', { score: 95, reason: 'Ambulance route to the hospital' }));
  const over = (await o1.get('/api/issues/' + D1)).j; assert.equal(over.priority.total, 95); assert.equal(over.priority.computed, before.priority.total); assert.equal(over.band, 'Critical');
  ok(await o1.post('/api/issues/' + D1 + '/priority', { clear: true })); assert.equal((await o1.get('/api/issues/' + D1)).j.priority.total, before.priority.total);
  assert.ok((await o1.get('/api/audit')).j.some(a => /^Priority override: /.test(a.act) && a.ref === D1));
  is(await o1.put('/api/config/departments', { roads: 60, health: 48, light: 48, water: 72 }), 403); is(await a1.put('/api/config/departments', { roads: 0, health: 48, light: 48, water: 72 }), 400);
  ok(await a1.put('/api/config/departments', { roads: 60, health: 48, light: 48, water: 72 })); assert.equal((await a1.get('/api/state')).j.depts.roads.sla, 60);
  const an = (await a1.get('/api/analytics')).j; assert.ok(an.dup.linked >= 2 && an.dup.merged >= 2); assert.ok(an.sla.Breached >= 1);
});

test('data, sign-in and photos persist across a server restart; silent repairs auto-close after 7 days', async () => {
  const c1 = await as('c1'), img = (await issue(c1, A)).afterImg; assert.equal((await issue(c1, 'I-1004')).status, 'Resolved'); const k0 = (await c1.get('/api/state')).j.S.karma; await stop();
  // pretend the citizen has not answered for 8 days
  { const f = path.join(DATA, 'db.json'), d = JSON.parse(fs.readFileSync(f, 'utf8')); d.S.issues.find(i => i.id === 'I-1004').resolvedAt = Date.now() - 8 * 24 * 36e5; fs.writeFileSync(f, JSON.stringify(d)); }
  await start();
  { const x = await issue(c1, 'I-1004'); assert.equal(x.status, 'Closed', 'auto-closed after 7 silent days'); assert.equal(x.autoClosed, true, 'flagged as closed without confirmation'); const st = (await c1.get('/api/state')).j.S; assert.ok(st.audit.some(a => /Auto-closed/.test(a.act) && a.ref === 'I-1004')); assert.equal(st.karma, k0, 'no karma for an auto-close'); }
  const i = await issue(c1, A); assert.equal(i.status, 'Closed', 'issue state persisted and session still valid'); assert.equal((await fetch(BASE + img)).status, 200);
  assert.ok(JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8')).S.audit.length > 30);
  ok(await c1.post('/api/auth/logout')); is(await c1.get('/api/issues'), 401, 'signed out');
});

test('admin can reset the demo data', async () => {
  const a1 = await as('a1'); is(await a1.post('/api/admin/reset', {}), 400); ok(await a1.post('/api/admin/reset', { confirm: 'RESET' }));
  const s = (await a1.get('/api/state')).j.S; assert.equal(s.issues.length, 7); assert.equal(s.wos.length, 3);
});
