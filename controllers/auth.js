'use strict';
/* Auth controller – sign in, citizen registration, sign out. Issues a JWT (see lib/auth-service.js). */
module.exports = ctx => {
  const { R, db, Auth, E, bad, conflict, str, log, live } = ctx;
  const throttle = ip => { if (Auth.throttled(ip)) throw new E(429, 'Too many failed attempts. Wait five minutes and try again.'); };
  function issueToken(c, uid) { const token = Auth.sign({ sub: uid, role: db.users[uid].role }, db.secret); c.res.setHeader('Set-Cookie', Auth.cookie(token)); return token; }

  R('POST', '/api/auth/login', null, c => {
    throttle(c.ip); const login = str(c.body.login, 1, 60, 'Login').toLowerCase(), pw = str(c.body.password, 1, 200, 'Password');
    const uid = Object.keys(db.users).find(k => db.users[k].login === login);
    if (!uid || !Auth.checkPw(db.users[uid], pw)) { Auth.failed(c.ip); throw new E(401, 'Wrong login or password.'); }
    const token = issueToken(c, uid); log(uid, 'Signed in', 'AUTH'); return { ok: true, me: uid, role: db.users[uid].role, token };
  });
  R('POST', '/api/auth/register', null, c => {
    throttle(c.ip); const name = str(c.body.name, 2, 40, 'Name'), phone = str(c.body.phone, 10, 10, 'Mobile number'), pw = str(c.body.password, 6, 200, 'Password');
    if (!/^[\p{L}\p{M} .-]+$/u.test(name)) bad('Name can only contain letters, spaces, dots and hyphens');
    if (!/^[6-9]\d{9}$/.test(phone)) bad('Enter a valid 10-digit Indian mobile number');
    if (Object.values(db.users).some(u => u.login === phone)) { Auth.failed(c.ip); conflict('This mobile number is already registered. Sign in instead.'); }
    const uid = 'c' + db.nU++; db.users[uid] = Auth.mkUser({ n: name + ' (Citizen)', role: 'citizen' }, phone, pw, false);
    const token = issueToken(c, uid); log(uid, 'Citizen registered', 'AUTH'); return { ok: true, me: uid, role: 'citizen', token };
  });
  // a signed-out token is remembered until it would have expired, so it cannot be reused
  R('POST', '/api/auth/logout', null, c => { if (c.claims) db.revoked[c.claims.jti] = c.claims.exp; if (c.uid) delete live[c.uid]; c.res.setHeader('Set-Cookie', Auth.cookie('')); return { ok: true }; });
};
