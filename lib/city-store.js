'use strict';
/*
 * CityStore – reference data, demo seed data and JSON-file persistence (data/db.json).
 * The API never touches the file directly. Set MONGODB_URI to keep the data in MongoDB instead of data/db.json
 * (MONGODB_DB picks the database name, default 'ucirp'). Without MONGODB_URI the JSON file is used, as before.
 */
const fs = require('fs'), path = require('path');
const CA = require('../public/city-algorithms.js');
const Auth = require('./auth-service.js');
const H = 36e5;

/* ------------------------------------------------------------------ reference data */
const DEPTS = {
  roads: { n: 'Works & Roads', sla: 72 },
  health: { n: 'Public Health & Sanitation', sla: 48 },
  light: { n: 'Street Lighting & Electrical', sla: 48 },
  water: { n: 'Water Supply & Drainage', sla: 72 }
};
// Agency names follow the PRD (FR05). For a Coimbatore deployment the equivalents would be
// CCMC (corporation) and TWAD Board (water): change the two display names here, nothing else.
const AGENCIES = {
  GCC: { s: 'GCC', n: 'City Corporation (GCC)' },
  CMWSSB: { s: 'CMWSSB', n: 'Metro Water Supply and Sewerage Board (CMWSSB)' },
  TANGEDCO: { s: 'TANGEDCO', n: 'TANGEDCO (electricity distribution)' },
  SH: { s: 'State Highways', n: 'Tamil Nadu State Highways Department' }
};
const DEPT_AGENCIES = { roads: ['GCC', 'SH'], health: ['GCC'], light: ['GCC', 'TANGEDCO'], water: ['GCC', 'CMWSSB'] };
// the department whose crew does the work when an agency is added as the second agency (joint dispatch)
const AGENCY_DEPT = { GCC: 'roads', SH: 'roads', TANGEDCO: 'light', CMWSSB: 'water' };
const WARDS = {
  '45': { n: 'Gandhipuram – RS Puram', la: 11.0140, lo: 76.9620 },
  '63': { n: 'Ukkadam – Town Hall', la: 10.9900, lo: 76.9640 },
  '30': { n: 'Peelamedu – Singanallur', la: 11.0150, lo: 77.0150 }
};
const CATS = {
  'Pothole / damaged road': 'roads', 'Broken footpath': 'roads', 'Fallen tree / branch': 'roads',
  'Garbage accumulation': 'health', 'Stray animal menace': 'health', 'Public toilet maintenance': 'health',
  'Broken streetlight': 'light', 'Water leakage': 'water', 'Blocked drain': 'water'
};
const SEED_USERS = {
  c1: { n: 'Priya S. (Citizen)', role: 'citizen' }, c2: { n: 'Rajesh M. (Citizen)', role: 'citizen' },
  o1: { n: 'Meena R. (Ward 45 Officer – Roads, Water, Lights)', role: 'officer', depts: ['roads', 'water', 'light'], ward: '45' },
  o4: { n: 'Anitha P. (Ward 45 Officer – Sanitation)', role: 'officer', depts: ['health'], ward: '45' },
  o2: { n: 'Ramesh V. (Ward 63 Officer – All departments)', role: 'officer', depts: ['roads', 'health', 'light', 'water'], ward: '63' },
  o3: { n: 'Divya S. (Ward 30 Officer – All departments)', role: 'officer', depts: ['roads', 'health', 'light', 'water'], ward: '30' },
  w1: { n: 'Karthik (Roads field engineer)', role: 'crew', dept: 'roads' }, w2: { n: 'Suresh (Water field engineer)', role: 'crew', dept: 'water' },
  w3: { n: 'Murugan (Sanitation field engineer)', role: 'crew', dept: 'health' }, w4: { n: 'Selvam (Electrical field engineer)', role: 'crew', dept: 'light' },
  s1: { n: 'Arun K. (Roads & Lights Supervisor)', role: 'supervisor', depts: ['roads', 'light'] },
  s2: { n: 'Kavitha (Water & Sanitation Supervisor)', role: 'supervisor', depts: ['water', 'health'] },
  a1: { n: 'Lakshmi (City Administrator)', role: 'admin' }
};
const DEMO_PASSWORD = 'demo123';
const wardOf = (la, lo) => Object.keys(WARDS).map(k => ({ k, d: (WARDS[k].la - la) ** 2 + (WARDS[k].lo - lo) ** 2 })).sort((a, b) => a.d - b.d)[0].k;
const defaultSla = () => { const o = {}; Object.keys(DEPTS).forEach(k => o[k] = DEPTS[k].sla); return o; };

/* ------------------------------------------------------------------ synthetic demo data */
function seedState() {
  const t = Date.now();
  const S = {
    weights: { sev: 30, safety: 25, sens: 15, support: 15, recur: 15 }, deptSla: defaultSla(), karmaPts: 10, karma: { c1: 40, c2: 10 }, karmaPaid: {}, audit: [], notes: [], nI: 1008, nW: 2003,
    issues: [
      { id: 'I-1001', cat: 'Pothole / damaged road', dept: 'roads', street: 'Avinashi Road near Hopes College', landmark: 'Opp. Hopes College signal', desc: 'Deep pothole on the left lane, two-wheelers swerving into traffic.', sev: .8, safety: .8, sens: .5, recur: 0, status: 'Under Verification', by: ['c1'], support: 3, verified: false, wos: [], lat: 11.0262, lng: 76.9998, t: t - 20 * H },
      { id: 'I-1002', cat: 'Water leakage', dept: 'water', street: 'Trichy Road, Ramanathapuram', landmark: 'Pole TR-2231', desc: 'Pipe leaking and the road surface has caved in.', sev: .7, safety: .5, sens: .4, recur: .5, status: 'Assigned', by: ['c1'], support: 5, verified: true, wos: ['WO-2001', 'WO-2002'], lat: 10.9992, lng: 76.9880, t: t - 64 * H, agency2: 'SH' },
      { id: 'I-1003', cat: 'Garbage accumulation', dept: 'health', street: 'Ukkadam Bus Stand, Pollachi Road side', landmark: 'Near the lake bund', desc: 'Garbage not cleared for a week, bad smell near the bus stand.', sev: .5, safety: .3, sens: .4, recur: .8, status: 'Under Verification', by: ['c2'], support: 2, verified: false, wos: [], lat: 10.9882, lng: 76.9626, t: t - 50 * H },
      { id: 'I-1004', cat: 'Broken streetlight', dept: 'light', street: 'Race Course Road', landmark: 'Pole RC-88, near girls school', desc: 'Streetlight out near the school, road is dark after 6 pm.', sev: .6, safety: .6, sens: .9, recur: 0, status: 'Resolved', by: ['c1'], support: 1, verified: true, wos: ['WO-2000'], lat: 11.0003, lng: 76.9742, t: t - 70 * H, resolvedAt: t - 10 * H, after: 'after_light.jpg', remarks: 'Replaced faulty lamp and fuse.' },
      { id: 'I-1005', cat: 'Blocked drain', dept: 'water', street: 'Cross Cut Road, Gandhipuram', landmark: 'Near the textile showroom', desc: 'Drain is clogged and sewage overflows onto the road when it rains.', sev: .7, safety: .5, sens: .3, recur: .5, status: 'Under Verification', by: ['c2'], support: 4, verified: false, wos: [], lat: 11.0166, lng: 76.9668, t: t - 12 * H },
      { id: 'I-1006', cat: 'Broken footpath', dept: 'roads', street: 'TV Samy Road, RS Puram', landmark: 'Opp. the park entrance', desc: 'Footpath slabs are broken, pedestrians are forced onto the road.', sev: .5, safety: .5, sens: .3, recur: 0, status: 'Under Verification', by: ['c1'], support: 1, verified: false, wos: [], lat: 11.0072, lng: 76.9502, t: t - 6 * H },
      // a second report of the I-1005 drain, 40 m away: scores in the 0.55–0.79 band, so it waits for the officer to accept or reject
      { id: 'I-1007', cat: 'Blocked drain', dept: 'water', street: 'Cross Cut Road, Gandhipuram', landmark: 'In front of the showroom parking', desc: 'Sewage overflowing from a clogged drain on the road near the showroom.', sev: .7, safety: .5, sens: .3, recur: .5, status: 'Under Verification', by: ['c1'], support: 1, verified: false, wos: [], lat: 11.0168, lng: 76.9671, t: t - 3 * H }],
    wos: [
      { id: 'WO-2000', issue: 'I-1004', dept: 'light', agency: 'GCC', crew: 'w4', status: 'Verified', instr: 'Replace lamp', t: t - 58 * H, due: t - 10 * H, dep: null, after: 'after_light.jpg', remarks: 'Replaced faulty lamp and fuse.' },
      // 83% of its SLA time is used: shown as At Risk
      { id: 'WO-2001', issue: 'I-1002', dept: 'water', agency: 'CMWSSB', crew: 'w2', status: 'Assigned', instr: 'Isolate valve and repair leaking main', t: t - 60 * H, due: t + 12 * H, dep: null },
      // past its deadline: shown as Breached and escalated when the server starts
      { id: 'WO-2002', issue: 'I-1002', dept: 'roads', agency: 'SH', crew: 'w1', status: 'Assigned', instr: 'Reinstate road surface after pipe repair', t: t - 60 * H, due: t - 2 * H, dep: 'WO-2001' }]
  };
  S.issues.forEach(i => { i.ward = wardOf(i.lat, i.lng); i.agency = CA.routeAgency(i.dept, i.cat, i.street, i.desc); i.photos = []; i.ph = []; i.reports = []; i.defect = CA.DEFECT[i.cat]; });
  const d = S.issues[6], m = CA.dupScore(d, S.issues[4]); d.dup = { id: m.id, s: m.s, geo: m.geo, text: m.text, image: m.image, d: m.d };
  S.audit.push({ t: d.t, a: 'system', act: 'Possible duplicate of ' + m.id + ' – sent to the officer for review', ref: d.id, note: CA.dupNote(m) });
  return S;
}

/* ------------------------------------------------------------------ persistence */
class CityStore {
  constructor(dir) {
    this.dir = dir; this.up = path.join(dir, 'uploads'); this.file = path.join(dir, 'db.json'); this.db = null; this.timer = null;
    this.uri = process.env.MONGODB_URI || ''; this.client = null; this.col = null; this.writing = Promise.resolve();
  }
  readFile() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) {
      if (fs.existsSync(this.file)) { const bak = this.file + '.corrupt-' + Date.now(); fs.copyFileSync(this.file, bak); console.log('! data/db.json could not be read. A copy was kept at ' + bak + (this.uri ? '.' : ' and fresh demo data was loaded.')); }
      return null;
    }
  }
  async load() {
    fs.mkdirSync(this.up, { recursive: true });
    let db = null;
    if (this.uri) {
      const { MongoClient } = require('mongodb');
      this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 8000 });
      await this.client.connect();   // throws here if the URI, password or network access is wrong
      this.col = this.client.db(process.env.MONGODB_DB || 'ucirp').collection('app_state');
      const doc = await this.col.findOne({ _id: 'main' });
      if (doc) { delete doc._id; db = doc; }
      else { db = this.readFile(); if (db && db.S && db.users) console.log('  Imported existing data/db.json into MongoDB.'); }
      console.log('  Connected to MongoDB (database "' + this.col.dbName + '").');
    } else db = this.readFile();
    if (!db || !db.S || !db.users) {
      db = { v: 2, users: {}, nU: 3, secret: Auth.newSecret(), revoked: {}, S: seedState() };
      for (const k of Object.keys(SEED_USERS)) db.users[k] = Auth.mkUser(SEED_USERS[k], k, DEMO_PASSWORD, true);
      this.db = db; await this.flush();
    } else { this.db = db; if (this.migrate()) await this.flush(); }
    return this.db;
  }
  // bring a data file written by an earlier version of the app up to date
  migrate() {
    const db = this.db, S = db.S; let ch = false;
    if (!db.secret) { db.secret = Auth.newSecret(); ch = true; }
    if (!db.revoked) { db.revoked = {}; ch = true; }
    if (db.sessions) { delete db.sessions; ch = true; }
    if (!S.deptSla) { S.deptSla = defaultSla(); ch = true; }
    const old = { CCMC: 'GCC', TWAD: 'CMWSSB' };
    S.issues.concat(S.wos).forEach(x => { if (old[x.agency]) { x.agency = old[x.agency]; ch = true; } });
    S.issues.forEach(i => {
      if (!i.photos) { i.photos = i.before ? [i.before] : []; ch = true; }
      if (!i.reports) { i.reports = []; ch = true; } if (!i.ph) { i.ph = []; ch = true; }
      if (i.status === 'Resolved' && !i.resolvedAt) { i.resolvedAt = Date.now(); ch = true; }
    });
    S.wos.forEach(w => { if (!w.t) { w.t = Math.min(Date.now(), w.due - 72 * H); ch = true; } });
    if (db.v !== 2) { db.v = 2; ch = true; }
    return ch;
  }
  // MongoDB: the whole state is one document, replaced in order (writes are chained so they never overlap).
  // File: write to a temporary file and rename it, so a crash can never leave half a file behind.
  flush() {
    clearTimeout(this.timer); this.timer = null;
    if (this.col) {
      this.writing = this.writing.then(() => this.col.replaceOne({ _id: 'main' }, { ...this.db, _id: 'main' }, { upsert: true }))
        .catch(e => { console.error('! MongoDB write failed:', e.message); throw e; });
      return this.writing;
    }
    const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.db)); fs.renameSync(tmp, this.file);
    return Promise.resolve();
  }
  save() { if (!this.timer) this.timer = setTimeout(() => this.flush().catch(() => { }), 150); }
  async close() { if (this.timer) await this.flush(); await this.writing.catch(() => { }); if (this.client) await this.client.close(); }
  get pending() { return !!this.timer; }
  reset() { this.db.S = seedState(); }
}

module.exports = { CityStore, REF: { DEPTS, AGENCIES, DEPT_AGENCIES, AGENCY_DEPT, WARDS, CATS }, SEED_USERS, DEMO_PASSWORD, wardOf, seedState };