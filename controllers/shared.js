'use strict';
/* Shared controller – read endpoints used by every role. What comes back is already filtered for the caller's role. */
module.exports = ctx => {
  const { R, db, W, needI, log, score, stateFor, analytics, ruleBrief, managesWO, CA, now } = ctx;
  const ALL = ['citizen', 'officer', 'supervisor', 'crew', 'admin'];
  const withSla = w => ({ ...w, sla: CA.slaState(w, now()).state });

  R('GET', '/api/state', null, c => stateFor(c.uid));
  R('GET', '/api/issues', ALL, c => stateFor(c.uid).S.issues.map(i => { const s = score(i); return { ...i, priority: s, band: CA.band(s.total) }; }));
  R('GET', '/api/issues/:id', ALL, c => { needI(c.p.id); const i = stateFor(c.uid).S.issues.find(i => i.id === c.p.id), s = score(i), ws = i.wos.map(W); return { ...i, priority: s, band: CA.band(s.total), stage: CA.STAGES[CA.stage(i, ws)], workOrders: ws.map(withSla) }; });
  R('GET', '/api/work-orders', ['officer', 'supervisor', 'crew', 'admin'], c => db.S.wos.filter(w => c.u.role === 'crew' ? w.crew === c.uid : c.u.role === 'admin' ? true : managesWO(c.u, w)).map(withSla));
  R('GET', '/api/audit', ['officer', 'supervisor', 'admin'], c => db.S.audit);
  R('GET', '/api/notifications', ALL, c => db.S.notes.filter(n => n.u === c.uid));
  R('POST', '/api/notifications/read', ALL, c => { db.S.notes.forEach(n => { if (n.u === c.uid) n.read = true; }); return { ok: true }; });
  R('GET', '/api/analytics', ['admin'], c => analytics());
  R('GET', '/api/live', ALL, c => stateFor(c.uid).live);
  R('POST', '/api/issues/:id/briefing', ALL, c => { const i = needI(c.p.id); i.ai = ruleBrief(i); log(c.uid, 'Simulated AI briefing generated', i.id); return { ok: true, briefing: i.ai }; });
};
