'use strict';
/* Authority controller – ward officer, field engineer (crew), department supervisor and administrator actions. */
module.exports = ctx => {
  const { R, db, store, CA, REF, H, now, bad, deny, conflict, I, W, needI, needW, log, notify, str, num, offFor, supsFor, isOfficerOf, managesWO, score, recalc, checkSLA, mergeIssues, savePhoto, live, clients, send, canSeeLive, DONE_WO } = ctx;
  const { DEPTS, AGENCIES, DEPT_AGENCIES, AGENCY_DEPT } = REF;

  /* ---------------- ward officer: verification, duplicates, overrides, routing ---------------- */
  const pending = i => ['Under Verification', 'Needs Info'].includes(i.status) && !i.verified;
  function officerIssue(c) { const i = needI(c.p.id); if (!isOfficerOf(c.u, i)) deny('This issue is outside your ward or department'); return i; }
  R('POST', '/api/issues/:id/verify', ['officer'], c => { const i = officerIssue(c); if (!pending(i)) conflict('This issue is not awaiting verification'); i.verified = true; i.status = 'Under Verification'; log(c.uid, 'Verified issue', i.id); i.by.forEach(u => notify(u, i.id + ' verified by the ward officer.')); return { ok: true }; });
  R('POST', '/api/issues/:id/reject', ['officer'], c => { const i = officerIssue(c); if (!pending(i)) conflict('Only unverified issues can be rejected'); const why = str(c.body.reason, 5, 500, 'Reason'); i.status = 'Rejected'; i.dup = null; log(c.uid, 'Rejected issue', i.id, why); i.by.forEach(u => notify(u, i.id + ' rejected: ' + why)); return { ok: true }; });
  R('POST', '/api/issues/:id/info', ['officer'], c => { const i = officerIssue(c); if (!pending(i)) conflict('Only unverified issues can be sent back for information'); const why = str(c.body.reason, 5, 500, 'Question'); i.status = 'Needs Info'; i.infoQ = why; log(c.uid, 'Requested info', i.id, why); notify(i.by[0], i.id + ': more information needed – ' + why); return { ok: true }; });

  // duplicate suggestion (score 0.55–0.79): accept merges this issue into the suggested one, reject keeps both and records why
  R('POST', '/api/issues/:id/duplicate', ['officer'], c => {
    const i = officerIssue(c); if (!i.dup) conflict('There is no duplicate suggestion on this issue');
    if (c.body.accept === true) { const t = I(i.dup.id); if (!t || !CA.isOpen(t)) conflict('The suggested issue ' + i.dup.id + ' is no longer open. Reject the suggestion instead.'); return mergeIssues(i, t, c.uid, 'Accepted duplicate suggestion (S ' + i.dup.s.toFixed(2) + ')'); }
    const why = str(c.body.reason, 5, 300, 'Reason'), other = i.dup.id; i.dupNo = (i.dupNo || []).concat(other); i.dup = null;
    log(c.uid, 'Duplicate suggestion rejected', i.id, 'Not the same problem as ' + other + ': ' + why); return { ok: true };
  });
  // manual merge: the officer overrides the system when it missed a duplicate
  R('POST', '/api/issues/:id/merge', ['officer'], c => {
    const i = officerIssue(c), t = needI(String(c.body.into || '')), why = str(c.body.reason, 5, 300, 'Reason');
    if (t.ward !== i.ward) bad('Issues can only be merged inside the same ward');
    return mergeIssues(i, t, c.uid, 'Officer merge: ' + why);
  });
  // priority override: the computed score stays visible next to the officer's value
  R('POST', '/api/issues/:id/priority', ['officer'], c => {
    const i = officerIssue(c); if (!CA.isOpen(i)) conflict('This issue is closed'); if (i.sos) conflict('SOS issues are always scored 100');
    if (c.body.clear === true) { if (!i.po) conflict('There is no override on this issue'); delete i.po; log(c.uid, 'Priority override removed', i.id, 'Back to the computed score ' + score(i).computed); return { ok: true }; }
    const s = Math.round(num(c.body.score, 1, 100, 'Priority score')), why = str(c.body.reason, 5, 300, 'Override reason'), was = score(i).computed;
    i.po = { s, by: c.uid, why, t: now(), was }; log(c.uid, 'Priority override: ' + was + ' → ' + s, i.id, why); return { ok: true };
  });
  R('POST', '/api/issues/:id/route', ['officer'], c => {
    const i = officerIssue(c), dept = String(c.body.dept || i.dept); if (!DEPTS[dept]) bad('Unknown department'); if (i.wos.length) conflict('Routing cannot change after work orders exist');
    const agency = c.body.agency && DEPT_AGENCIES[dept].includes(c.body.agency) ? c.body.agency : dept === i.dept ? i.agency : CA.routeAgency(dept, i.cat, i.street, i.desc);
    if (c.body.agency && !DEPT_AGENCIES[dept].includes(c.body.agency)) bad(AGENCIES[c.body.agency] ? AGENCIES[c.body.agency].s + ' does not handle ' + DEPTS[dept].n : 'Unknown agency');
    if (dept === i.dept && agency === i.agency) return { ok: true }; const moved = dept !== i.dept; i.dept = dept; i.agency = agency;
    log(c.uid, 'Routing override → ' + DEPTS[dept].n + ' (' + AGENCIES[agency].s + ')', i.id); if (moved) notify(offFor(i), i.id + ' was routed to your department.'); return { ok: true };
  });

  /* ---------------- assignment: creating a work order starts the SLA timer ---------------- */
  R('POST', '/api/issues/:id/work-orders', ['officer'], c => {
    const i = officerIssue(c), b = c.body, S = db.S; if (!i.verified) conflict('Verify the issue first'); if (!CA.isOpen(i)) conflict('This issue is closed');
    const dept = String(b.dept || i.dept); if (!DEPTS[dept]) bad('Unknown department');
    const crew = db.users[b.crew]; if (!crew || crew.role !== 'crew' || crew.dept !== dept) bad('Choose a field engineer from ' + DEPTS[dept].n);
    let hrs = num(b.hours, 1, 720, 'SLA target (hours)'); const instr = str(b.instr, 4, 500, 'Repair instructions');
    if (i.sos) hrs = Math.min(hrs, CA.SOS_HOURS); // Emergency SOS: never more than 4 hours
    let dep = null; if (b.dep) { const d = W(b.dep); if (!d || d.issue !== i.id) bad('The prerequisite must be a work order of this issue'); dep = d.id; }
    const second = b.joint === true ? 'GCC' : b.joint ? String(b.joint) : null; if (second && !AGENCIES[second]) bad('Unknown second agency');
    const firstAgency = dept === i.dept ? i.agency : CA.routeAgency(dept, i.cat, i.street, i.desc); if (second && second === firstAgency) bad('The second agency must be different from the first');
    const mk = (dept, cid, dep, ins, agency) => { const w = { id: 'WO-' + S.nW++, issue: i.id, dept, agency, crew: cid, status: 'Assigned', instr: ins, t: now(), due: now() + hrs * H, hrs, dep }; S.wos.push(w); i.wos.push(w.id); log(c.uid, 'Created work order – SLA timer started (' + hrs + ' h)', w.id, DEPTS[dept].n + ' · ' + AGENCIES[agency].s + ' → ' + db.users[cid].n + (dep ? ' · depends on ' + dep : '')); notify(cid, 'New work order ' + w.id + ' for ' + i.id + ' at ' + i.street); return w; };
    const a = mk(dept, b.crew, dep, instr, firstAgency), made = [a.id];
    if (second) { // joint dispatch: a linked work order for the second agency
      const d2 = AGENCY_DEPT[second], rc = Object.keys(db.users).find(k => db.users[k].role === 'crew' && db.users[k].dept === d2), after = d2 === 'roads' && dept !== 'roads';
      if (!rc) bad('No field engineer is available for ' + AGENCIES[second].s);
      made.push(mk(d2, rc, after ? a.id : null, after ? 'Reinstate road surface after ' + DEPTS[dept].n + ' repair' : 'Joint dispatch with ' + AGENCIES[firstAgency].s + ': ' + instr, second).id);
      i.agency2 = second; log(c.uid, 'Joint dispatch to a second agency', i.id, AGENCIES[firstAgency].s + ' + ' + AGENCIES[second].s);
    }
    if (['Under Verification', 'Needs Info'].includes(i.status)) i.status = 'Assigned'; else recalc(i);
    i.by.forEach(u => notify(u, i.id + ': a field engineer has been assigned.')); return { ok: true, created: made, hours: hrs };
  });

  /* ---------------- field engineer: accept → start → (blocker) → submit with evidence ---------------- */
  function crewWO(c) { const w = needW(c.p.id); if (w.crew !== c.uid) deny('This is not your work order'); return w; }
  const actDone = (c, w, note) => { log(c.uid, 'Work order → ' + w.status, w.id, note || ''); recalc(I(w.issue)); return { ok: true, status: w.status }; };
  R('POST', '/api/work-orders/:id/accept', ['crew'], c => { const w = crewWO(c); if (!['Assigned', 'Rework Required'].includes(w.status)) conflict('This work order cannot be accepted in status ' + w.status); w.status = 'Accepted'; return actDone(c, w); });
  R('POST', '/api/work-orders/:id/start', ['crew'], c => {
    const w = crewWO(c); if (!['Accepted', 'Blocked'].includes(w.status)) conflict('Accept the assignment first'); const d = w.dep && W(w.dep);
    if (d && !['Verified', 'Completed'].includes(d.status) && !w.override) conflict('Prerequisite ' + w.dep + ' is not verified yet'); w.status = 'In Progress'; w.blocker = null; w.started = w.started || now();
    I(w.issue).by.forEach(u => notify(u, w.issue + ': the field engineer has started the repair.')); return actDone(c, w);
  });
  // a progress note appears in the issue's tracking timeline
  R('POST', '/api/work-orders/:id/progress', ['crew'], c => { const w = crewWO(c), note = str(c.body.note, 4, 300, 'Progress note'); if (!['Accepted', 'In Progress', 'Blocked'].includes(w.status)) conflict('Progress can only be added to active work'); w.progress = (w.progress || []).concat([{ t: now(), note }]).slice(-50); log(c.uid, 'Progress update', w.id, note); I(w.issue).by.forEach(u => notify(u, w.issue + ' progress: ' + note)); return { ok: true }; });
  R('POST', '/api/work-orders/:id/block', ['crew'], c => { const w = crewWO(c), why = str(c.body.reason, 4, 300, 'Blocker'); if (!['Accepted', 'In Progress'].includes(w.status)) conflict('Only accepted or in-progress work can be blocked'); w.status = 'Blocked'; w.blocker = why; [offFor(I(w.issue)), ...supsFor(w.dept)].forEach(u => notify(u, w.id + ' blocked: ' + why)); return actDone(c, w, why); });
  // no after-repair photo and note, no resolution
  R('POST', '/api/work-orders/:id/submit', ['crew'], c => {
    const w = crewWO(c), i = I(w.issue); if (w.status !== 'In Progress') conflict('Start work first'); const why = str(c.body.remarks, 4, 500, 'Resolution note');
    if (!c.body.photo) bad('After-repair photo is required'); const img = savePhoto(c.body.photo, 'After-repair photo');
    const p = c.body.loc && typeof c.body.loc.lat === 'number' && typeof c.body.loc.lng === 'number' ? c.body.loc : live[c.uid] && now() - live[c.uid].t < 3 * 60000 ? live[c.uid] : null;
    w.subDist = p ? Math.round(CA.hav(p, i)) : null; w.subAcc = p && p.acc ? Math.round(p.acc) : null;
    w.status = 'Submitted for Verification'; w.after = 'photo'; w.afterImg = img; w.remarks = why; w.submitted = now();
    [offFor(i), ...supsFor(w.dept)].forEach(u => notify(u, w.id + ' submitted for verification')); return actDone(c, w, why + (w.subDist != null ? ' · GPS: ' + w.subDist + ' m from the reported spot' : ' · no GPS fix at submission'));
  });

  /* ---------------- officer / supervisor: review, override, reassign ---------------- */
  function managedWO(c) { const w = needW(c.p.id); if (!managesWO(c.u, w)) deny('This work order is outside your ward or department'); return w; }
  R('POST', '/api/work-orders/:id/review', ['officer', 'supervisor'], c => {
    const w = managedWO(c), i = I(w.issue), ok = c.body.approve === true; if (w.status !== 'Submitted for Verification') conflict('Nothing to review on this work order');
    const why = ok ? '' : str(c.body.reason, 5, 500, 'Reason for returning'); w.status = ok ? 'Verified' : 'Rework Required'; if (!ok) w.note = why;
    log(c.uid, ok ? 'Verified evidence' : 'Returned for correction', w.id, why); notify(w.crew, w.id + (ok ? ' verified' : ' returned: ' + why));
    if (ok) { w.done = now(); i.after = w.after; i.afterImg = w.afterImg; i.remarks = w.remarks; i.wos.map(W).forEach(x => { if (x.dep === w.id && x.status !== 'Cancelled') notify(x.crew, x.id + ': prerequisite ' + w.id + ' is verified. You can start.'); }); }
    recalc(i); return { ok: true, status: w.status };
  });
  R('POST', '/api/work-orders/:id/override', ['officer', 'supervisor'], c => { const w = managedWO(c), why = str(c.body.reason, 5, 300, 'Override reason'); if (!w.dep) conflict('This work order has no prerequisite'); if (DONE_WO.includes(w.status)) conflict('Work order already finished'); w.override = true; log(c.uid, 'Dependency override', w.id, why); notify(w.crew, w.id + ': dependency overridden. You can start.'); return { ok: true }; });
  R('POST', '/api/work-orders/:id/reassign', ['officer', 'supervisor'], c => {
    const w = managedWO(c), n = db.users[c.body.crew]; if (!n || n.role !== 'crew' || n.dept !== w.dept) bad('The field engineer must belong to the same department'); if (DONE_WO.includes(w.status)) conflict('Work order already finished');
    const old = w.crew; if (old === c.body.crew) return { ok: true }; w.crew = c.body.crew; if (['Accepted', 'In Progress'].includes(w.status)) w.status = 'Assigned';
    log(c.uid, 'Reassigned work order', w.id, db.users[old].n + ' → ' + n.n); notify(w.crew, 'You were assigned ' + w.id); notify(old, w.id + ' was reassigned'); recalc(I(w.issue)); return { ok: true };
  });

  /* ---------------- live field-engineer location ---------------- */
  R('POST', '/api/location', ['crew'], c => {
    const b = c.body, p = { lat: num(b.lat, -90, 90, 'Latitude'), lng: num(b.lng, -180, 180, 'Longitude'), acc: typeof b.acc === 'number' && isFinite(b.acc) ? Math.round(b.acc) : null, spd: typeof b.spd === 'number' && isFinite(b.spd) ? b.spd : null, hdg: typeof b.hdg === 'number' && isFinite(b.hdg) ? b.hdg : null, t: now() };
    live[c.uid] = p;
    if (!p.acc || p.acc <= 100) db.S.wos.forEach(w => { if (w.crew === c.uid && ['Accepted', 'In Progress'].includes(w.status)) { const tr = w.trail = w.trail || [], l = tr[tr.length - 1]; if (!l || CA.hav({ lat: l[0], lng: l[1] }, p) > 12) { tr.push([+p.lat.toFixed(6), +p.lng.toFixed(6), p.t]); if (tr.length > 600) tr.splice(0, tr.length - 600); store.save(); } } });
    clients.forEach(k => { if (k.uid && canSeeLive(k.uid, c.uid)) send(k, 'loc', { u: c.uid, ...p }); });
    return { ok: true, noSave: true };
  });
  R('POST', '/api/location/stop', ['crew'], c => { delete live[c.uid]; clients.forEach(k => send(k, 'loc', { u: c.uid, gone: true })); return { ok: true, noSave: true }; });

  /* ---------------- administrator: priority weights, department settings, demo reset ---------------- */
  R('PUT', '/api/config/weights', ['admin'], c => { const w = {}; for (const k of ['sev', 'safety', 'sens', 'support', 'recur']) w[k] = num(c.body[k], 0, 50, k + ' weight'); if (!Object.values(w).some(v => v > 0)) bad('At least one weight must be above zero'); db.S.weights = w; log(c.uid, 'Priority weights changed', 'CONFIG', JSON.stringify(w)); return { ok: true }; });
  R('PUT', '/api/config/departments', ['admin'], c => { const s = {}; for (const k of Object.keys(DEPTS)) s[k] = Math.round(num(c.body[k], 1, 720, DEPTS[k].n + ' SLA hours')); db.S.deptSla = s; log(c.uid, 'Department SLA settings changed', 'CONFIG', JSON.stringify(s)); return { ok: true }; });
  R('POST', '/api/admin/reset', ['admin'], c => { if (c.body.confirm !== 'RESET') bad('Send {"confirm":"RESET"} to reset'); store.reset(); for (const k of Object.keys(live)) delete live[k]; log(c.uid, 'Demo data reset', 'CONFIG'); checkSLA(); return { ok: true }; });
};
