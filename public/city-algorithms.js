/*
 * CityAlgorithms – the rule-based "intelligence" of UCIRP.
 * One file, used by BOTH sides: the Node.js server (require) and the browser (script tag),
 * so the duplicate check and the priority score are computed by exactly the same rules everywhere.
 * Everything here is a transparent rule. No machine-learning model is involved.
 */
(function (root, factory) { const m = factory(); if (typeof module === 'object' && module.exports) module.exports = m; else root.CityAlgorithms = m; })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const H = 36e5;
  const hav = (a, b) => { const r = Math.PI / 180, R = 6371000, p = (b.lat - a.lat) * r, l = (b.lng - a.lng) * r, h = Math.sin(p / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(l / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
  const CLOSED = ['Closed', 'Rejected', 'Merged'];
  const isOpen = i => !CLOSED.includes(i.status);

  /* ---------- duplicate detection:  S = 0.5 geo + 0.3 text + 0.2 image ---------- */
  const DUP = { geo: 0.5, text: 0.3, image: 0.2, auto: 0.80, review: 0.55, gpsNoise: 25 };
  // how far apart two reports of the same category can be and still be the same problem (metres)
  const DUP_RADIUS = {
    'Pothole / damaged road': 150, 'Broken footpath': 150, 'Fallen tree / branch': 150, 'Garbage accumulation': 200, 'Stray animal menace': 300,
    'Public toilet maintenance': 100, 'Broken streetlight': 100, 'Water leakage': 200, 'Blocked drain': 200
  };
  const radiusOf = cat => DUP_RADIUS[cat] || 150;
  const STOP = new Set('the and for with from near this that there have has are was were not but very into onto over under when after before been being its our your their them they you about also some more most just only than then which while will would could should because during since till until here where what who how why all any each few own same too can did does doing had her him his she out off per via close side'.split(' '));
  const stem = w => { if (w.length < 5) return w; w = w.replace(/(ing|ed)$/, ''); w = w.replace(/([^s])s$/, '$1'); return w.replace(/e$/, ''); };
  const tokens = t => new Set((String(t || '').toLowerCase().match(/[\p{L}\p{M}]{3,}/gu) || []).filter(w => !STOP.has(w)).map(stem));
  // 1 within GPS noise (25 m), then falls in a straight line to 0 at the category radius
  const geoSim = (d, radius) => d <= DUP.gpsNoise ? 1 : Math.max(0, 1 - (d - DUP.gpsNoise) / Math.max(1, radius - DUP.gpsNoise));
  // share of the shorter description's key words that also appear in the other one
  function textSim(a, b) { const A = tokens(a), B = tokens(b); if (!A.size || !B.size) return 0; let n = 0; A.forEach(w => { if (B.has(w)) n++; }); return n / Math.min(A.size, B.size); }
  // photos are compared by a 64-bit average hash made in the browser; unrelated photos differ in about half the bits
  function hamming(a, b) { let n = 0; for (let k = 0; k < 16; k++) { let x = parseInt(a[k], 16) ^ parseInt(b[k], 16); while (x) { n += x & 1; x >>= 1; } } return n; }
  function imageSim(ha, hb) { let best = 0; (ha || []).forEach(a => (hb || []).forEach(b => { if (a && b && a.length === 16 && b.length === 16) best = Math.max(best, Math.max(0, 1 - hamming(a, b) / 32)); })); return best; }
  const r2 = x => Math.round(x * 100) / 100;
  function dupScore(report, issue) {
    const d = hav(report, issue), geo = geoSim(d, radiusOf(issue.cat));
    const text = Math.max(textSim(report.desc, issue.desc), ...(issue.reports || []).map(r => textSim(report.desc, r.desc)));
    const image = imageSim(report.ph, issue.ph);
    const s = r2(DUP.geo * geo + DUP.text * text + DUP.image * image);
    return { id: issue.id, d: Math.round(d), geo: r2(geo), text: r2(text), image: r2(image), s, band: s >= DUP.auto ? 'auto' : s >= DUP.review ? 'review' : 'new' };
  }
  // open issues of the same category inside the category's duplicate radius, best match first
  function findDuplicates(report, issues) {
    const rad = radiusOf(report.cat);
    return issues.filter(i => isOpen(i) && i.cat === report.cat && hav(report, i) <= rad).map(i => dupScore(report, i)).sort((a, b) => b.s - a.s);
  }
  const dupNote = m => 'S ' + m.s.toFixed(2) + ' = 0.5×geo ' + m.geo.toFixed(2) + ' + 0.3×text ' + m.text.toFixed(2) + ' + 0.2×image ' + m.image.toFixed(2) + ' · ' + m.d + ' m apart';

  /* ---------- explainable priority score (1–100) ---------- */
  function score(i, w) {
    const sup = Math.min(i.support / 10, 1);
    const parts = { Severity: w.sev * i.sev, 'Public safety': w.safety * i.safety, 'Sensitive location': w.sens * i.sens, 'Citizen support': w.support * sup, Recurrence: w.recur * i.recur };
    const sum = Object.values(w).reduce((a, b) => a + b, 0) || 1;
    const computed = Math.min(100, Math.max(1, Math.round(Object.values(parts).reduce((a, b) => a + b, 0) / sum * 100)));
    const total = i.sos ? 100 : i.po ? i.po.s : computed;
    return { parts, weights: w, computed, total, override: !i.sos && i.po ? i.po : null };
  }
  const band = t => t >= 75 ? 'Critical' : t >= 55 ? 'High' : t >= 35 ? 'Medium' : 'Low';

  /* ---------- SLA state: On Track → At Risk (75% of the time used) → Breached ---------- */
  const AT_RISK = 0.75, SOS_HOURS = 4, AUTO_CLOSE_DAYS = 7;
  function slaState(w, now) {
    const start = w.t || (w.due - 72 * H), span = Math.max(1, w.due - start), used = (now - start) / span;
    return { state: now > w.due ? 'Breached' : used >= AT_RISK ? 'At Risk' : 'On Track', used: Math.max(0, used), left: w.due - now };
  }

  /* ---------- simulated diagnosis (keywords) and sensitive places (map distance) ---------- */
  const RISK = /deep|accident|live wire|spark|overflow|collapse|flood|school|child|hospital|open manhole|fallen|sewage|injur|dark/;
  function guessSev(t) { const s = String(t).toLowerCase(), hi = RISK.test(s); return { sev: hi ? .85 : .5, safety: /accident|live wire|spark|open manhole|collapse|injur|flood|child|school|fallen/.test(s) ? .85 : hi ? .6 : .3, sens: /school|hospital|college|temple|market|bus stand/.test(s) ? .9 : .2 }; }
  const CAT_RULES = [[/pothole|crater|pit\b/, 'Pothole / damaged road'], [/footpath|pavement|sidewalk/, 'Broken footpath'], [/tree|branch/, 'Fallen tree / branch'], [/garbage|waste|trash|dump|smell/, 'Garbage accumulation'], [/street ?light|lamp|dark|pole/, 'Broken streetlight'], [/leak|pipe|water supply|burst/, 'Water leakage'], [/drain|sewage|overflow|clog|manhole/, 'Blocked drain'], [/dog|cattle|cow|monkey/, 'Stray animal menace'], [/toilet|urinal/, 'Public toilet maintenance']];
  function guessCat(t) { const s = String(t).toLowerCase(), m = CAT_RULES.find(x => x[0].test(s)); return m ? m[1] : null; }
  const DEFECT = {
    'Pothole / damaged road': 'Road surface cavity (pothole)', 'Broken footpath': 'Broken or displaced paving slabs', 'Fallen tree / branch': 'Obstruction on the carriageway',
    'Garbage accumulation': 'Uncollected solid waste', 'Stray animal menace': 'Animal hazard', 'Public toilet maintenance': 'Facility out of service',
    'Broken streetlight': 'Lamp or supply failure', 'Water leakage': 'Pipe leak or burst', 'Blocked drain': 'Drain blockage or overflow'
  };
  // Demo list of schools and hospitals. Positions are approximate and for demonstration only.
  const POIS = [
    { n: 'Coimbatore Medical College Hospital', k: 'hospital', lat: 10.9955, lng: 76.9690 }, { n: 'PSG Hospitals', k: 'hospital', lat: 11.0190, lng: 77.0055 },
    { n: 'G. Kuppuswamy Naidu Memorial Hospital', k: 'hospital', lat: 11.0115, lng: 76.9795 }, { n: 'K.G. Hospital', k: 'hospital', lat: 10.9985, lng: 76.9720 },
    { n: 'Stanes School', k: 'school', lat: 11.0030, lng: 76.9740 }, { n: 'PSG College of Technology', k: 'school', lat: 11.0247, lng: 77.0028 }
  ];
  function sensitiveNear(p) { let best = null; POIS.forEach(x => { const d = hav(p, x); if (!best || d < best.d) best = { ...x, d: Math.round(d) }; }); if (!best) return { s: 0, poi: null }; return { s: best.d <= 150 ? .9 : best.d <= 300 ? .6 : 0, poi: best }; }

  /* ---------- agency routing ---------- */
  function routeAgency(dept, cat, street, desc) {
    const s = (street + ' ' + desc).toLowerCase();
    if (dept === 'roads') return /avinashi|trichy|mettupalayam|sathy|pollachi|palakkad|highway|\bnh ?\d|\bsh ?\d/.test(s) ? 'SH' : 'GCC';
    if (dept === 'light') return /transformer|live wire|power ?(line|cut|cable)|electric(ity)? ?(pole|post|line)|high tension|spark|shock/.test(s) ? 'TANGEDCO' : 'GCC';
    if (dept === 'water') return cat === 'Water leakage' || /water supply|pipeline|main line|drinking water|burst/.test(s) ? 'CMWSSB' : 'GCC';
    return 'GCC';
  }

  /* ---------- citizen-visible lifecycle ---------- */
  const STAGES = ['Submitted', 'AE Review', 'Assigned', 'In Progress', 'Resolved', 'Closed'];
  function stage(i, wos) {
    if (i.status === 'Closed') return 5; if (i.status === 'Resolved') return 4;
    if (i.status === 'In Progress' || (wos || []).some(w => ['In Progress', 'Submitted for Verification'].includes(w.status))) return 3;
    if (['Assigned', 'Escalated', 'Reopened'].includes(i.status)) return 2;
    return 1;
  }
  const TIERS = [[0, 'New Reporter'], [20, 'Active Citizen'], [50, 'Neighbourhood Guardian'], [150, 'City Champion']];
  function tier(points) { let k = 0; TIERS.forEach((t, n) => { if (points >= t[0]) k = n; }); return { name: TIERS[k][1], next: TIERS[k + 1] ? { name: TIERS[k + 1][1], at: TIERS[k + 1][0] } : null }; }

  return { H, hav, CLOSED, isOpen, DUP, DUP_RADIUS, radiusOf, tokens, geoSim, textSim, imageSim, dupScore, findDuplicates, dupNote, score, band, AT_RISK, SOS_HOURS, AUTO_CLOSE_DAYS, slaState, RISK, guessSev, guessCat, CAT_RULES, DEFECT, POIS, sensitiveNear, routeAgency, STAGES, stage, TIERS, tier };
});
