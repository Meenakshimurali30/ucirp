'use strict';
/*
 * Local HTTPS – makes a self-signed certificate with Node's crypto only (hand-built ASN.1 DER).
 * Phones only allow GPS on an https address, so the server also listens on https://<LAN-IP>:8443.
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const now = () => Date.now();

function lanIPs() { const out = []; for (const l of Object.values(os.networkInterfaces())) for (const a of l || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address); return out; }
function selfSigned(ips) {
  const der = (tag, buf) => { const l = buf.length; return Buffer.concat([l < 128 ? Buffer.from([tag, l]) : l < 256 ? Buffer.from([tag, 0x81, l]) : Buffer.from([tag, 0x82, l >> 8, l & 255]), buf]); };
  const seq = (...a) => der(0x30, Buffer.concat(a)), set = (...a) => der(0x31, Buffer.concat(a));
  const oid = s => { const p = s.split('.').map(Number), b = [p[0] * 40 + p[1]]; for (const n of p.slice(2)) { const t = [n & 127]; let m = n >>> 7; while (m) { t.unshift((m & 127) | 128); m >>>= 7; } b.push(...t); } return der(6, Buffer.from(b)); };
  const int = b => der(2, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
  const utc = d => der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const name = seq(set(seq(oid('2.5.4.3'), der(0x0c, Buffer.from('UCIRP local server'))))), alg = seq(oid('1.2.840.113549.1.1.11'), der(5, Buffer.alloc(0)));
  const serial = crypto.randomBytes(8); serial[0] = (serial[0] & 0x7f) | 0x40;
  const san = seq(der(0x82, Buffer.from('localhost')), ...['127.0.0.1', ...ips].map(ip => der(0x87, Buffer.from(ip.split('.').map(Number)))));
  const ext = der(0xa3, seq(seq(oid('2.5.29.17'), der(4, san))));
  const tbs = seq(der(0xa0, int(Buffer.from([2]))), int(serial), alg, name, seq(utc(new Date(Date.now() - 86400000)), utc(new Date(Date.now() + 390 * 86400000))), name, publicKey.export({ type: 'spki', format: 'der' }), ext);
  const sig = crypto.sign('sha256', tbs, privateKey), cert = seq(tbs, alg, der(3, Buffer.concat([Buffer.from([0]), sig])));
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: '-----BEGIN CERTIFICATE-----\n' + cert.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n' };
}
function tlsOptions(DATA) {
  const f = path.join(DATA, 'tls.json'), ips = lanIPs();
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (j.ips.join() === ips.join() && now() - j.t < 300 * 86400000) return j; } catch (e) { }
  const j = { ...selfSigned(ips), ips, t: now() }; fs.writeFileSync(f, JSON.stringify(j)); return j;
}
function listen(srv, port, tries) { return new Promise(ok => { const go = n => { srv.once('error', e => { if (e.code === 'EADDRINUSE' && n < tries) go(n + 1); else { console.log('! Could not open port ' + (port + n) + ': ' + e.message); ok(0); } }); srv.listen(port + n, () => ok(port + n)); }; go(0); }); }


module.exports = { lanIPs, selfSigned, tlsOptions, listen };
