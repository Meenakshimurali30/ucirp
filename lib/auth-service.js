'use strict';
/*
 * AuthService – passwords, JSON Web Tokens (RFC 7519, HS256) and login throttling.
 * Written with Node's built-in crypto only, so there is nothing to install.
 */
const crypto = require('crypto');

const TOKEN_DAYS = 14;
const b64 = v => Buffer.from(v).toString('base64url');

/* ---- passwords: scrypt with a random salt per user ---- */
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
function mkUser(base, login, pw, seed) { const salt = crypto.randomBytes(12).toString('hex'); return { ...base, login, salt, hash: hashPw(pw, salt), seed: !!seed }; }
function checkPw(user, pw) { return !!user && crypto.timingSafeEqual(Buffer.from(hashPw(pw, user.salt)), Buffer.from(user.hash)); }

/* ---- JWT ---- */
const newSecret = () => crypto.randomBytes(48).toString('hex');
const mac = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('base64url');
function sign(claims, secret, days = TOKEN_DAYS) {
  const iat = Math.floor(Date.now() / 1000);
  const body = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) + '.' + b64(JSON.stringify({ ...claims, jti: crypto.randomBytes(9).toString('base64url'), iat, exp: iat + days * 86400 }));
  return body + '.' + mac(body, secret);
}
// returns the claims, or null if the token is malformed, forged, expired or uses another algorithm
function verify(token, secret) {
  if (typeof token !== 'string' || token.length > 2000) return null;
  const p = token.split('.'); if (p.length !== 3) return null;
  try {
    const head = JSON.parse(Buffer.from(p[0], 'base64url').toString('utf8')); if (head.alg !== 'HS256' || head.typ !== 'JWT') return null;
    const want = Buffer.from(mac(p[0] + '.' + p[1], secret)), got = Buffer.from(p[2]);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    const c = JSON.parse(Buffer.from(p[1], 'base64url').toString('utf8'));
    if (!c || typeof c.sub !== 'string' || typeof c.exp !== 'number' || c.exp * 1000 < Date.now()) return null;
    return c;
  } catch (e) { return null; }
}
// the token travels in an HttpOnly cookie (browser) or an "Authorization: Bearer" header (API clients)
function tokenFrom(req) {
  const h = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || ''); if (h) return h[1];
  const c = /(?:^|;\s*)token=([A-Za-z0-9_\-.]+)/.exec(req.headers.cookie || ''); return c ? c[1] : null;
}
const cookie = token => 'token=' + token + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + (token ? TOKEN_DAYS * 86400 : 0);

/* ---- login throttling: 10 failures per address in 5 minutes ---- */
const fails = new Map();
function throttled(ip) { const f = fails.get(ip); return !!f && f.n >= 10 && Date.now() - f.t < 5 * 60000; }
function failed(ip) { const f = fails.get(ip); if (!f || Date.now() - f.t > 5 * 60000) fails.set(ip, { n: 1, t: Date.now() }); else f.n++; }

module.exports = { TOKEN_DAYS, hashPw, mkUser, checkPw, newSecret, sign, verify, tokenFrom, cookie, throttled, failed };
