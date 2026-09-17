#!/usr/bin/env node
/** Post-deploy NEGATIVE black-box probe (fail-closed hotfix 2026-09-17).
 *  Run AFTER a deploy against the deployed base URL:
 *    node scripts/post-deploy-auth-negative.mjs https://<deployed-host>
 *  Every check MUST pass on a correctly deployed build; any failure means the
 *  deploy is fail-OPEN and must be rolled back.
 *  Checks:
 *   1. OTP request returns NO devCode field (CONTAKE_DEV_OTP unset/prod).
 *   2. A protected route rejects an unauthenticated request (401).
 *   3. A token signed with the OLD hardcoded fallback 'contake-dev-secret'
 *      is rejected (proves the fallback is gone).
 *   4. A token signed with the local-dev constant is rejected. */
import { createHmac } from 'node:crypto';

const base = process.argv[2];
if (!base) { console.error('usage: post-deploy-auth-negative.mjs <base-url>'); process.exit(2); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const mint = (secret) => {
  const payload = Buffer.from(JSON.stringify({ sub: 'u-nope', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
};

const otp = await fetch(`${base}/v1/auth/otp/request`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '+15550199999' }),
});
check('otp/request reachable', otp.status === 200, `status ${otp.status}`);
const body = await otp.json().catch(() => ({}));
check('otp/request exposes NO devCode', body.devCode === undefined, `keys: ${Object.keys(body).join(',')}`);

const unauth = await fetch(`${base}/v1/events`);
check('protected route rejects anonymous', unauth.status === 401, `status ${unauth.status}`);

for (const [name, secret] of [['old-fallback', 'contake-dev-secret'], ['local-dev-constant', 'contake-local-dev-secret-NOT-DEPLOYABLE']]) {
  const res = await fetch(`${base}/v1/events`, { headers: { authorization: `Bearer ${mint(secret)}` } });
  check(`forged ${name} token rejected`, res.status === 401, `status ${res.status}`);
}

process.exit(failures ? 1 : 0);
