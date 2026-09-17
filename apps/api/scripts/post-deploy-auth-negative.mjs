#!/usr/bin/env node
/** Post-deploy auth black-box probe v2 (fail-closed hotfix, 2026-09-17).
 *  Cryptographic assurance against a REAL existing user - a nonexistent sub
 *  proves nothing, so the real-secret positive control is mandatory:
 *    node apps/api/scripts/post-deploy-auth-negative.mjs --base https://<host> \
 *         --secret <deployed CONTAKE_AUTH_SECRET> --user <existing userId>
 *  Checks (ALL must pass; any failure = rollback candidate):
 *   1. POSITIVE CONTROL: a token signed with the REAL deployed secret for the
 *      REAL existing user is ACCEPTED (proves the probe tests a live identity
 *      path, not a vacuum).
 *   2. The SAME userId with a token signed 'contake-dev-secret' (removed v0
 *      fallback) is REJECTED.
 *   3. The SAME userId with a token signed the local-dev constant is REJECTED.
 *   4. OTP request returns NO devCode field.
 *   5. A protected route rejects an anonymous request (401).
 *  Bounded: every fetch has an 8s timeout; --base must be https (http allowed
 *  only for localhost/127.0.0.1). The real secret is used only to mint a
 *  local HMAC and is never sent, logged, or persisted. */
import { createHmac } from 'node:crypto';

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const base = arg('base'), secret = arg('secret'), userId = arg('user');
if (!base || !secret || !userId) {
  console.error('usage: post-deploy-auth-negative.mjs --base <url> --secret <deployed-auth-secret> --user <existing-userId>');
  process.exit(2);
}
let origin;
try { origin = new URL(base); } catch { console.error(`invalid base URL: ${base}`); process.exit(2); }
const isLocal = ['localhost', '127.0.0.1'].includes(origin.hostname);
if (origin.protocol !== 'https:' && !isLocal) { console.error('base URL must be https (http allowed only for localhost)'); process.exit(2); }
if (!['https:', 'http:'].includes(origin.protocol)) { console.error('base URL must be http(s)'); process.exit(2); }

const mint = (key) => {
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
};
const get = async (path, token) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    return await fetch(`${origin.origin}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: ctrl.signal });
  } finally { clearTimeout(t); }
};
let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`); if (!ok) failures += 1; };

const positive = await get('/v1/events', mint(secret)).catch(e => ({ status: `ERR ${e.name}` }));
check('POSITIVE CONTROL: real secret + real user accepted', positive.status === 200, `status ${positive.status}`);
if (positive.status !== 200) { console.error('positive control failed - remaining checks would prove nothing; aborting'); process.exit(2); }

for (const [name, key] of [['old-fallback', 'contake-dev-secret'], ['local-dev-constant', 'contake-local-dev-secret-NOT-DEPLOYABLE']]) {
  const res = await get('/v1/events', mint(key)).catch(e => ({ status: `ERR ${e.name}` }));
  check(`same user, forged ${name} token rejected`, res.status === 401, `status ${res.status}`);
}

const otp = await fetch(`${origin.origin}/v1/auth/otp/request`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '+15550199999' }),
  signal: AbortSignal.timeout(8000),
});
const body = await otp.json().catch(() => ({}));
check('otp/request exposes NO devCode', otp.status === 200 && body.devCode === undefined, `status ${otp.status}, keys: ${Object.keys(body).join(',')}`);

const anon = await get('/v1/events').catch(e => ({ status: `ERR ${e.name}` }));
check('protected route rejects anonymous', anon.status === 401, `status ${anon.status}`);

process.exit(failures ? 1 : 0);
