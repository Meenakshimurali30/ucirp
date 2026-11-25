'use strict';
/* Citizen controller – report, duplicate check, support, reply, confirm or dispute. */
module.exports = ctx => {
  const { R, db, CA, REF, now, bad, deny, conflict, needI, log, notify, str, num, wardOf, offFor, officersOf, supsFor, W, parsePhoto, writePhoto, localAI, matchDups, dupRef, linkReport, recurrenceOf } = ctx;
  const { CATS, WARDS, DEPTS, AGENCIES } = REF;

  function readDraft(b) {
    const d = { cat: str(b.cat, 1, 80, 'Category'), desc: str(b.desc, 10, 500, 'Description'), ward: String(b.ward || ''), street: str(b.street, 2, 120, 'Street'), landmark: str(b.landmark, 1, 120, 'Landmark'), lat: num(b.lat, -90, 90, 'Latitude'), lng: num(b.lng, -180, 180, 'Longitude'), sos: !!b.sos };
    if (!CATS[d.cat]) bad('Unknown category'); if (!WARDS[d.ward]) d.ward = wardOf(d.lat, d.lng);
    d.acc = typeof b.acc === 'number' && isFinite(b.acc) && b.acc > 0 ? Math.round(b.acc) : null; d.addr = typeof b.addr === 'string' ? b.addr.slice(0, 300) : '';
    // photo fingerprints (64-bit average hash) made in the browser, used for the image part of the duplicate score
    d.ph = Array.isArray(b.hashes) ? b.hashes.filter(h => typeof h === 'string' && /^[0-9a-f]{16}$/.test(h)).slice(0, 3) : [];
    return d;
  }
  // one to three photos; all are checked before any is stored
  function readPhotos(b) {
    const list = Array.isArray(b.photos) ? b.photos : b.photo !== undefined ? [b.photo] : [];
    if (!list.length) bad('At least one photo is required'); if (list.length > 3) bad('Attach at most three photos');
    return list.map((p, n) => parsePhoto(p, 'Photo ' + (n + 1)));
  }

  // before submitting: similar open issues inside the category's duplicate radius, each with its score
  R('POST', '/api/issues/check', ['citizen'], c => {
    const d = readDraft(c.body), ai = localAI(d, c.uid);
    return { ai, radius: CA.radiusOf(d.cat), duplicates: matchDups(d, c.uid, false).map(m => { const i = needI(m.id); return { ...m, status: i.status, street: i.street, cat: i.cat, dist: m.d, support: i.support }; }) };
  });

  // submitting:  S >= 0.80 links the report to the existing issue · 0.55–0.79 creates the issue with a suggestion for the officer · below 0.55 is a new issue
  R('POST', '/api/issues', ['citizen'], c => {
    const d = readDraft(c.body), imgs = readPhotos(c.body), S = db.S, m = matchDups(d, c.uid, true)[0];
    if (m && m.band === 'auto' && !d.sos && c.body.distinct !== true) {
      const i = needI(m.id), own = i.by.includes(c.uid);
      linkReport(i, { u: c.uid, t: now(), desc: d.desc, photos: imgs.map(writePhoto), ph: d.ph, lat: d.lat, lng: d.lng, s: m.s });
      if (!own) { i.by.push(c.uid); i.support++; }
      log(c.uid, own ? 'Repeat report auto-linked' : 'Duplicate report auto-linked', i.id, CA.dupNote(m));
      notify(offFor(i), i.id + ': another report of the same problem was linked automatically (' + i.support + ' supporters).');
      return { ok: true, linked: true, own, id: i.id, dept: i.dept, agency: i.agency, match: dupRef(m) };
    }
    const ai = localAI(d, c.uid), photos = imgs.map(writePhoto), id = 'I-' + S.nI++, dept = CATS[d.cat];
    const i = { id, cat: d.cat, dept, agency: CA.routeAgency(dept, d.cat, d.street, d.desc), ward: d.ward, street: d.street, landmark: d.landmark, desc: d.desc, sev: ai.severity, safety: ai.safety, sens: ai.sensitive, recur: recurrenceOf(d), status: 'Under Verification', by: [c.uid], support: 1, verified: false, wos: [], lat: d.lat, lng: d.lng, acc: d.acc, addr: d.addr, t: now(), sos: d.sos, photos, before: photos[0], ph: d.ph, reports: [], conf: ai.confidence, defect: ai.defect, aiWhy: ai.reason, dup: m && m.band !== 'new' ? dupRef(m) : null };
    S.issues.push(i); log(c.uid, d.sos ? 'SOS filed (fast-track, ' + CA.SOS_HOURS + '-hour SLA)' : 'Complaint filed', id);
    log('system', 'Simulated AI diagnosis: ' + i.defect + ' · severity ' + Math.round(i.sev * 100) + '% · confidence ' + i.conf + '% · routed to ' + DEPTS[dept].n + ' (' + AGENCIES[i.agency].s + ')', id, ai.reason);
    if (i.dup) log('system', 'Possible duplicate of ' + m.id + ' – sent to the officer for review', id, CA.dupNote(m));
    officersOf(i).concat(officersOf(i).length ? [] : [offFor(i)]).forEach(o => notify(o, 'New ' + (d.sos ? 'SOS ' : '') + 'issue ' + id + ' in Ward ' + i.ward + ': ' + i.cat + (i.dup ? ' (possible duplicate of ' + i.dup.id + ')' : '')));
    if (d.sos) supsFor(dept).forEach(s => notify(s, 'SOS ' + id + ' filed at ' + i.street));
    return { ok: true, id, dept, agency: i.agency, match: i.dup };
  });

  R('POST', '/api/issues/:id/support', ['citizen'], c => { const i = needI(c.p.id); if (i.by.includes(c.uid)) conflict('You already support this issue'); if (!CA.isOpen(i)) conflict('This issue is already closed'); i.by.push(c.uid); i.support++; log(c.uid, 'Supported existing issue', i.id); return { ok: true }; });
  R('POST', '/api/issues/:id/reply', ['citizen'], c => { const i = needI(c.p.id); if (!i.by.includes(c.uid)) deny('This is not your complaint'); if (i.status !== 'Needs Info') conflict('No information was requested'); const t = str(c.body.text, 5, 500, 'Reply'); i.status = 'Under Verification'; log(c.uid, 'Citizen provided information', i.id, t); notify(offFor(i), i.id + ': the citizen replied – ' + t); return { ok: true }; });
  R('POST', '/api/issues/:id/confirm', ['citizen'], c => {
    const i = needI(c.p.id), S = db.S; if (!i.by.includes(c.uid)) deny('This is not your complaint'); if (i.status !== 'Resolved') conflict('This issue is not awaiting confirmation');
    i.status = 'Closed'; i.closedAt = now(); log(c.uid, 'Citizen confirmed fix – closed', i.id); notify(offFor(i), i.id + ' was confirmed by the citizen and closed.');
    if (!S.karmaPaid[i.id + c.uid]) { S.karmaPaid[i.id + c.uid] = 1; S.karma[c.uid] = (S.karma[c.uid] || 0) + S.karmaPts; log('system', 'Karma +' + S.karmaPts, i.id); } return { ok: true };
  });
  // a dispute reopens the issue; the whole history stays on it
  R('POST', '/api/issues/:id/dispute', ['citizen'], c => {
    const i = needI(c.p.id); if (!i.by.includes(c.uid)) deny('This is not your complaint'); if (i.status !== 'Resolved') conflict('This issue is not awaiting confirmation'); const why = str(c.body.reason, 5, 500, 'Reason');
    i.status = 'Reopened'; i.reopened = (i.reopened || 0) + 1; i.wos.map(W).forEach(w => { if (w.status === 'Verified') { w.status = 'Rework Required'; w.note = 'Citizen dispute: ' + why; notify(w.crew, w.id + ' reopened after a citizen dispute: ' + why); } });
    log(c.uid, 'Citizen disputed fix – reopened', i.id, why); notify(offFor(i), i.id + ' reopened by citizen: ' + why); return { ok: true };
  });
};
