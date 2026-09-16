#!/usr/bin/env node
/**
 * Contake E2E: v1.19 addendum §17 UNIFORM IDEMPOTENCY - route inventory + claim/replay/409.
 *
 * Contract (addendum §17, TL contract decision 2026-09-17, relayed via parent):
 *   every effectful route accepts and honors Idempotency-Key (16-128 printable ASCII);
 *   scope (org_id, actor_id, method, route_template, key); same key + same request hash
 *   => exact replay of original status/body with zero new mutation/audit/notification/
 *   realtime frame; same key + different hash => 409 IDEMPOTENCY_KEY_REUSED; concurrent
 *   in-progress => bounded wait then replay, else 409 IDEMPOTENCY_IN_PROGRESS + Retry-After.
 *   Exclusions: safe reads, /v1/domino/compute (dry-run), /v1/auth/whitelist-check.
 *   Auth side-effect routes (OTP request/verify, login, refresh) EXCLUDED pending
 *   security-specific policy (TL+security).
 *
 * DEPLOYMENT STATUS (live probe, 2026-09-17 ~00:49 IDT, contake-api-staging):
 *   POST /v1/events with Idempotency-Key, same key + same body, twice ->
 *     TWO distinct events (evt_mu4mvazv_97, evt_mu4mvb75_98): no claim, no replay.
 *   Same key + divergent body -> third event (evt_mu4mvber_99), no 409.
 *   All three probe events deleted (200) in the same session.
 *   => §17 ledger is NOT deployed on staging. All idempotency cases below are labeled
 *   PENDING-IMPLEMENTATION (default --expect pending). Flip to --expect implemented
 *   only when backend lands the ledger; the same suite then becomes the hard gate.
 *
 * Hard assertion today: the ROUTE INVENTORY. Every effectful route in
 * apps/api/src/app.ts must appear in MANIFEST with an explicit §17 classification
 * (in-scope or excluded + reason). A new effectful route without a §17 decision
 * fails the run.
 *
 * Existing business invariants (§17 last line, remain): reports.clientReportId dedupe,
 * notify ack re-ack 200, push endpoint ownership, whitelist phone serialization.
 * These are NOT §17 ledger semantics (report dedupe returns a DIFFERENT body
 * {report,deduped:true} on repeat, which fails exact-replay) and are recorded as such.
 *
 * Rules (TL binding): zz-qa- prefix; create+delete in-session; leftovers fail the run;
 * never touch seeded demo content or cd-ev1; sequential; abort on 429; Thursday
 * 08:00-14:00 IL blackout for remote bases. Whitelist-family routes have NO delete
 * route -> cannot be fully cleaned -> LOCAL-ONLY (memory server, disposable).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const BASE = (opt('base-url', 'https://contake-api-staging.onrender.com') || '').replace(/\/$/, '');
const IS_LOCAL = BASE.includes('localhost') || BASE.includes('127.0.0.1');
const RUN_ID = opt('run-id', `r${Date.now().toString(36)}`);
const OUT = opt('out', null);
const EXPECT = opt('expect', 'pending'); // pending | implemented
const INVENTORY_ONLY = args.includes('--inventory-only');
const FORCE_BLACKOUT = args.includes('--force-blackout-override');
const APP_TS = opt('app-ts', new URL('../../apps/api/src/app.ts', import.meta.url).pathname);
const DEMO_DATE = '2027-03-03';
const TZ = 'Asia/Jerusalem';
const V = { id: 'film-shoot', admin: ['admin@film-demo.local', 'admin123'], fm: ['fm@film-demo.local', 'fm12345'], siteId: 'film-site-1', channelId: 'ch-film-client-1' };

// ---------- §17 route manifest (30 effectful routes, classified) ----------
const MANIFEST = [
  ['POST', '/v1/auth/login', 'ex', 'auth side-effect, pending security policy (§17)'],
  ['POST', '/v1/auth/refresh', 'ex', 'auth side-effect, pending security policy (§17)'],
  ['POST', '/v1/auth/otp/request', 'ex', 'auth side-effect, pending security policy (§17)'],
  ['POST', '/v1/auth/otp/verify', 'ex', 'auth side-effect, pending security policy (§17)'],
  ['POST', '/v1/auth/whitelist-check', 'ex', 'explicit §17 exclusion'],
  ['POST', '/v1/domino/compute', 'ex', 'dry-run, explicit §17 exclusion'],
  ['POST', '/v1/auth/whitelist-register', 'in', 'unauthenticated auth route; HMAC-scoped ledger per §17'],
  ['POST', '/v1/whitelist', 'in', 'ledger required'],
  ['POST', '/v1/whitelist/:phone/approve', 'in', 'ledger required'],
  ['POST', '/v1/whitelist/:phone/reject', 'in', 'ledger required'],
  ['POST', '/v1/push/subscriptions', 'in', 'ledger required'],
  ['DELETE', '/v1/push/subscriptions', 'in', 'ledger required'],
  ['POST', '/v1/events', 'in', 'ledger required'],
  ['POST', '/v1/events/:id/duplicate', 'in', 'ledger required'],
  ['PATCH', '/v1/events/:id', 'in', 'ledger required'],
  ['DELETE', '/v1/events/:id', 'in', 'ledger required'],
  ['POST', '/v1/events/:id/publish', 'in', 'ledger required'],
  ['POST', '/v1/events/:id/tasks', 'in', 'ledger required'],
  ['PATCH', '/v1/tasks/:id', 'in', 'ledger required'],
  ['DELETE', '/v1/tasks/:id', 'in', 'ledger required'],
  ['POST', '/v1/events/:id/resources', 'in', 'ledger required'],
  ['PATCH', '/v1/resources/:id', 'in', 'ledger required'],
  ['DELETE', '/v1/resources/:id', 'in', 'ledger required'],
  ['POST', '/v1/events/:id/dependencies', 'in', 'ledger required'],
  ['DELETE', '/v1/dependencies/:id', 'in', 'ledger required'],
  ['POST', '/v1/changes/:id/approve', 'in', 'ledger required'],
  ['POST', '/v1/changes/:id/reject', 'in', 'ledger required'],
  ['POST', '/v1/reports', 'in', 'ledger required (clientReportId dedupe remains an additional invariant)'],
  ['POST', '/v1/reports/:id/resolve', 'in', 'ledger required'],
  ['POST', '/v1/notify-jobs/:id/ack', 'in', 'ledger required (re-ack 200 remains an additional invariant)'],
];
const WHITELIST_LOCAL = new Set(['POST /v1/auth/whitelist-register', 'POST /v1/whitelist', 'POST /v1/whitelist/:phone/approve', 'POST /v1/whitelist/:phone/reject']);

function jerusalemNow() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t)?.value;
  return { weekday: g('weekday'), hour: Number(g('hour')), minute: Number(g('minute')) };
}
if (!IS_LOCAL && !FORCE_BLACKOUT) {
  const j = jerusalemNow();
  if (j.weekday === 'Thu' && j.hour >= 8 && j.hour < 14) { console.error('REFUSED: Thursday blackout 08:00-14:00 IL'); process.exit(2); }
}

const evidence = [];
let throttled = false;
const rec = (group, label, status, details = {}) => {
  evidence.push({ group, label, status, ...details });
  console.log(`${status} [${group}] ${label}${Object.keys(details).length ? ' — ' + JSON.stringify(details) : ''}`);
};
const verdict = (ok, pendingReason) =>
  EXPECT === 'implemented' ? (ok ? 'PASS' : 'FAIL') : (ok ? 'PASS-UNEXPECTED' : 'PENDING-IMPLEMENTATION');

async function call(method, path, { token, body, key } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (key) headers['idempotency-key'] = key;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (res.status === 429) { throttled = true; throw new Error('429 throttled — aborting run (TL rule)'); }
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}
const same = (a, b) => a.status === b.status && JSON.stringify(a.json) === JSON.stringify(b.json);
async function login(email, password) {
  const r = await call('POST', '/v1/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status}`);
  return r.json.token;
}

// ---------- part 1: route inventory assertion (hard, passes today) ----------
function inventoryCheck() {
  const src = readFileSync(APP_TS, 'utf8');
  const code = new Set();
  for (const m of src.matchAll(/app\.(post|patch|put|delete)\('([^']+)'/g)) code.add(`${m[1].toUpperCase()} ${m[2]}`);
  const manifest = new Set(MANIFEST.map(([m, p]) => `${m} ${p}`));
  const missing = [...code].filter((r) => !manifest.has(r));
  const stale = [...manifest].filter((r) => !code.has(r));
  rec('inventory', `app.ts effectful routes: ${code.size}; manifest: ${manifest.size}`, missing.length === 0 && stale.length === 0 ? 'PASS' : 'FAIL',
    missing.length || stale.length ? { missingFromManifest: missing, staleInManifest: stale } : { aligned: true });
  return missing.length === 0 && stale.length === 0;
}

// ---------- part 2: claim / replay / 409 ----------
let keyN = 0;
const KEY = () => `zz-qa-idem-${RUN_ID}-${String(++keyN).padStart(3, '0')}`;
const PENDING = '§17 ledger not deployed (live probe 2026-09-17: no claim/replay/409 on POST /v1/events)';

/** claim/replay/409 for one route. make(i): i=0 claim, i=1 replay (identical request), i=2 divergent (same key). */
async function triple(group, label, make, { divergentNote } = {}) {
  const k = KEY();
  const a0 = await make(0);
  const r1 = await call(a0.method, a0.path, { ...a0, key: k });
  if (r1.status >= 500) { rec(group, `${label} claim`, 'FAIL', { httpStatus: r1.status, note: 'claim itself 5xx — harness or server bug, not a §17 result' }); return { r1 }; }
  const a1 = await make(1);
  const r2 = await call(a1.method, a1.path, { ...a1, key: k });
  const replayOk = same(r1, r2);
  const a2 = await make(2);
  const r3 = await call(a2.method, a2.path, { ...a2, key: k });
  const conflictOk = r3.status === 409 && r3.json?.error?.code === 'IDEMPOTENCY_KEY_REUSED';
  rec(group, `${label} replay`, verdict(replayOk, PENDING), { r1: r1.status, r2: r2.status, bodiesEqual: JSON.stringify(r1.json) === JSON.stringify(r2.json), ...(EXPECT === 'pending' ? { reason: PENDING } : {}) });
  rec(group, `${label} divergent-409${divergentNote ? ` (${divergentNote})` : ''}`, verdict(conflictOk, PENDING), { httpStatus: r3.status, code: r3.json?.error?.code, ...(EXPECT === 'pending' ? { reason: PENDING } : {}) });
  return { r1, r2, r3 };
}

async function main() {
  const invOk = inventoryCheck();
  if (INVENTORY_ONLY) return finish(invOk);
  const admin = await login(...V.admin);
  const fm = await login(...V.fm);
  const ctx = {};
  const g = async () => {
    const j = (await call('GET', `/v1/events/${ctx.eventId}/graph`, { token: admin })).json;
    return {
      event: j?.event,
      tasks: Object.fromEntries((j?.tasks ?? []).map((t) => [t.id, t.version])),
      resources: Object.fromEntries((j?.resources ?? []).map((r) => [r.id, r.version])),
    };
  };

  // --- sacrificial scenario ---
  const ev = await call('POST', '/v1/events', { token: admin, body: { name: `zz-qa-idem-${RUN_ID}`, date: DEMO_DATE, timezone: TZ, domainProfileId: V.id, siteIds: [V.siteId] } });
  ctx.eventId = ev.json?.applied?.event?.id;
  if (!ctx.eventId) { rec('setup', 'event.create', 'FAIL', { status: ev.status }); return finish(false); }
  const mkTask = async (n, start, assignees) => (await call('POST', `/v1/events/${ctx.eventId}/tasks`, { token: admin, body: { task: { name: `zz-qa-${n}`, durationMin: 30, siteId: V.siteId, start, assigneeResourceIds: assignees ?? [] } } })).json?.applied?.createdId;
  const mkRes = async (n, kind = 'group') => (await call('POST', `/v1/events/${ctx.eventId}/resources`, { token: admin, body: { resource: kind === 'group' ? { resourceKind: kind, name: `zz-qa-${n}`, exclusive: false, subscriberChannelIds: [V.channelId] } : { resourceKind: kind, name: `zz-qa-${n}`, exclusive: true } } })).json?.applied?.createdId;
  ctx.r1 = await mkRes('G1');
  ctx.t1 = await mkTask('I1', `${DEMO_DATE}T09:00:00+02:00`);
  ctx.t2 = await mkTask('I2', `${DEMO_DATE}T09:30:00+02:00`, [ctx.r1]); // watcher group on downstream task -> cascade impact generates notify jobs
  const mkDep = async (from, to) => (await call('POST', `/v1/events/${ctx.eventId}/dependencies`, { token: admin, body: { fromTaskId: from, toTaskId: to, lagMin: 0 } })).json?.applied?.createdId;
  ctx.d1 = await mkDep(ctx.t2, ctx.t1); // t2 depends on t1
  rec('setup', 'sacrificial event + 2 tasks + group + dep', ctx.t1 && ctx.t2 && ctx.r1 && ctx.d1 ? 'PASS' : 'FAIL', { eventId: ctx.eventId });

  // notify job for ack case: publish, then move t1 -> cascade moves t2 (watcher group impacted)
  await call('POST', `/v1/events/${ctx.eventId}/publish`, { token: admin });
  const gv0 = await g();
  const mv0 = await call('PATCH', `/v1/tasks/${ctx.t1}`, { token: admin, body: { version: gv0.tasks[ctx.t1], move: { newStart: `${DEMO_DATE}T09:45:00+02:00` } } });
  rec('setup', 'cascade move applied (t2 moved)', mv0.status === 200 && (mv0.json?.applied?.domino?.movedTasks ?? []).some((m) => m.taskId === ctx.t2) ? 'PASS' : 'FAIL', { httpStatus: mv0.status });
  const jobs = (await call('GET', `/v1/notifications?eventId=${ctx.eventId}`, { token: admin })).json?.jobs ?? [];
  ctx.jobId = jobs[0]?.id;
  rec('setup', `notify jobs present for ack case: ${jobs.length}`, jobs.length > 0 ? 'PASS' : 'FAIL', {});
  // CRs for approve/reject (FM out-of-scope propose -> pending CR)
  const mkCR = async (n) => (await call('POST', `/v1/events/${ctx.eventId}/tasks`, { token: fm, body: { task: { name: `zz-qa-cr-${n}`, durationMin: 15, siteId: V.siteId, start: `${DEMO_DATE}T12:00:00+02:00` } } })).json?.changeRequest?.id;
  ctx.cr1 = await mkCR(1); ctx.cr2 = await mkCR(2); ctx.cr3 = await mkCR(3); ctx.cr4 = await mkCR(4);
  rec('setup', 'CRs for approve/reject cases', ctx.cr1 && ctx.cr2 && ctx.cr3 && ctx.cr4 ? 'PASS' : 'FAIL', { cr1: ctx.cr1 });

  try {
    // POST /v1/events (the live-probe route)
    const evBody = (tag) => ({ name: `zz-qa-idem-x${tag}-${RUN_ID}`, date: DEMO_DATE, timezone: TZ, domainProfileId: V.id, siteIds: [V.siteId] });
    await triple('events', 'POST /v1/events', async (i) => ({ method: 'POST', path: '/v1/events', token: admin, body: evBody(i === 2 ? 'div' : 'x') }));
    // sweep any events the absent ledger let through (they carry zz-qa-idem-x* names)
    for (const e of ((await call('GET', '/v1/events', { token: admin })).json?.events ?? []).filter((e) => e.name.startsWith('zz-qa-idem-x') || e.name.startsWith('zz-qa-idem-dup'))) {
      await call('DELETE', `/v1/events/${e.id}`, { token: admin });
    }
    // POST /v1/events/:id/duplicate (body.date distinguishes divergent)
    await triple('events', 'POST /v1/events/:id/duplicate', async (i) => ({ method: 'POST', path: `/v1/events/${ctx.eventId}/duplicate`, token: admin, body: { date: i === 2 ? '2027-03-05' : '2027-03-04', name: `zz-qa-idem-dup-${RUN_ID}` } }));
    for (const e of ((await call('GET', '/v1/events', { token: admin })).json?.events ?? []).filter((e) => e.name.startsWith('zz-qa-idem-dup'))) {
      await call('DELETE', `/v1/events/${e.id}`, { token: admin });
    }
    // PATCH /v1/events/:id
    await triple('events', 'PATCH /v1/events/:id', async (i) => ({ method: 'PATCH', path: `/v1/events/${ctx.eventId}`, token: admin, body: { version: (await g()).event.version, patch: { name: i === 2 ? 'zz-qa-idem-div' : 'zz-qa-idem-p' } } }));
    // DELETE /v1/events/:id (scratch events; divergent = same key, other id)
    {
      const mk = async (t) => (await call('POST', '/v1/events', { token: admin, body: evBody(t) })).json?.applied?.event?.id;
      const e1 = await mk('dela'); const e2 = await mk('delb');
      await triple('events', 'DELETE /v1/events/:id', async (i) => ({ method: 'DELETE', path: `/v1/events/${i === 2 ? e2 : e1}`, token: admin }), { divergentNote: 'same key, other event id' });
      await call('DELETE', `/v1/events/${e1}`, { token: admin });
      await call('DELETE', `/v1/events/${e2}`, { token: admin });
    }
    // POST /v1/events/:id/publish (divergent = same key, other id)
    {
      const p1 = (await call('POST', '/v1/events', { token: admin, body: evBody('pub') })).json?.applied?.event?.id;
      await triple('events', 'POST /v1/events/:id/publish', async (i) => ({ method: 'POST', path: `/v1/events/${i === 2 ? ctx.eventId : p1}/publish`, token: admin }), { divergentNote: 'same key, other event id' });
      await call('DELETE', `/v1/events/${p1}`, { token: admin });
    }
    // tasks
    await triple('tasks', 'POST /v1/events/:id/tasks', async (i) => ({ method: 'POST', path: `/v1/events/${ctx.eventId}/tasks`, token: admin, body: { task: { name: `zz-qa-idem-t${i === 2 ? 'd' : 'x'}`, durationMin: 15, siteId: V.siteId, start: `${DEMO_DATE}T13:00:00+02:00` } } }));
    await triple('tasks', 'PATCH /v1/tasks/:id', async (i) => ({ method: 'PATCH', path: `/v1/tasks/${ctx.t2}`, token: admin, body: { version: (await g()).tasks[ctx.t2], move: { newStart: i === 2 ? `${DEMO_DATE}T14:30:00+02:00` : `${DEMO_DATE}T14:00:00+02:00` } } }));
    {
      const s1 = await mkTask('DEL', `${DEMO_DATE}T15:00:00+02:00`); const s2 = await mkTask('DEL2', `${DEMO_DATE}T15:30:00+02:00`);
      await triple('tasks', 'DELETE /v1/tasks/:id', async (i) => ({ method: 'DELETE', path: `/v1/tasks/${i === 2 ? s2 : s1}`, token: admin }), { divergentNote: 'same key, other task id' });
    }
    // resources
    await triple('resources', 'POST /v1/events/:id/resources', async (i) => ({ method: 'POST', path: `/v1/events/${ctx.eventId}/resources`, token: admin, body: { resource: { resourceKind: 'gear', name: `zz-qa-idem-r${i === 2 ? 'd' : 'x'}`, exclusive: true } } }));
    await triple('resources', 'PATCH /v1/resources/:id', async (i) => ({ method: 'PATCH', path: `/v1/resources/${ctx.r1}`, token: admin, body: { version: (await g()).resources[ctx.r1], patch: { name: i === 2 ? 'zz-qa-idem-rdiv' : 'zz-qa-idem-rp' } } }));
    {
      const s1 = await mkRes('RDEL', 'gear'); const s2 = await mkRes('RDEL2', 'gear');
      await triple('resources', 'DELETE /v1/resources/:id', async (i) => ({ method: 'DELETE', path: `/v1/resources/${i === 2 ? s2 : s1}`, token: admin }), { divergentNote: 'same key, other resource id' });
    }
    // dependencies (fresh scratch tasks to avoid a cycle with d1)
    {
      const a = await mkTask('DEPA', `${DEMO_DATE}T16:00:00+02:00`); const b = await mkTask('DEPB', `${DEMO_DATE}T16:30:00+02:00`);
      await triple('dependencies', 'POST /v1/events/:id/dependencies', async (i) => ({ method: 'POST', path: `/v1/events/${ctx.eventId}/dependencies`, token: admin, body: { fromTaskId: b, toTaskId: a, lagMin: i === 2 ? 30 : 15 } }));
      const s1 = await mkDep(b, a); // b depends on a (second edge, harmless)
      await triple('dependencies', 'DELETE /v1/dependencies/:id', async (i) => ({ method: 'DELETE', path: `/v1/dependencies/${i === 2 ? ctx.d1 : s1}`, token: admin }), { divergentNote: 'same key, other dependency id' });
    }
    // changes approve/reject (CRs from setup; divergent = same key, other CR)
    await triple('changes', 'POST /v1/changes/:id/approve', async (i) => ({ method: 'POST', path: `/v1/changes/${i === 2 ? ctx.cr2 : ctx.cr1}/approve`, token: admin }), { divergentNote: 'same key, other CR id' });
    await triple('changes', 'POST /v1/changes/:id/reject', async (i) => ({ method: 'POST', path: `/v1/changes/${i === 2 ? ctx.cr4 : ctx.cr3}/reject`, token: admin, body: { reasonHe: i === 2 ? 'zz-qa-div' : 'zz-qa' } }), { divergentNote: 'same key, other CR id' });
    // reports (admin creates; clientReportId business dedupe coexists with §17)
    {
      const body = { taskId: ctx.t1, status: 'done', clientReportId: `zz-qa-cr-${RUN_ID}`, clientTimestamp: new Date().toISOString() };
      const { r1, r2 } = await triple('reports', 'POST /v1/reports', async (i) => ({ method: 'POST', path: '/v1/reports', token: admin, body: i === 2 ? { ...body, clientReportId: `zz-qa-cr2-${RUN_ID}`, status: 'blocked' } : body }));
      if (r2?.json?.deduped === true) rec('reports', 'note: replay hit clientReportId business dedupe (body differs -> not §17 exact replay)', 'PASS', { invariant: 'clientReportId dedupe remains per §17' });
      const repId = r1?.json?.report?.id;
      if (repId) await triple('reports', 'POST /v1/reports/:id/resolve', async (i) => ({ method: 'POST', path: `/v1/reports/${repId}/resolve`, token: admin, body: i === 2 ? { note: 'zz-qa-div' } : undefined }));
    }
    // notify-jobs ack (business re-ack 200 exists independent of the ledger)
    if (ctx.jobId) {
      await triple('notify', 'POST /v1/notify-jobs/:id/ack', async (i) => ({ method: 'POST', path: `/v1/notify-jobs/${i === 2 ? 'nj_zz_qa_nonexistent' : ctx.jobId}/ack`, token: admin }), { divergentNote: 'same key, other job id' });
    }
    // push subscriptions (cleanup: delete both endpoints)
    {
      const ep = (n) => `https://push.example.invalid/zz-qa-${RUN_ID}-${n}`;
      const sub = (n) => ({ endpoint: ep(n), keys: { p256dh: 'zz-qa-p256dh', auth: 'zz-qa-auth' }, deviceClass: 'qa' });
      await triple('push', 'POST /v1/push/subscriptions', async (i) => ({ method: 'POST', path: '/v1/push/subscriptions', token: admin, body: sub(i === 2 ? 'b' : 'a') }));
      await triple('push', 'DELETE /v1/push/subscriptions', async (i) => ({ method: 'DELETE', path: '/v1/push/subscriptions', token: admin, body: { endpoint: ep(i === 2 ? 'b' : 'a') } }));
      await call('DELETE', '/v1/push/subscriptions', { token: admin, body: { endpoint: ep('a') } });
      await call('DELETE', '/v1/push/subscriptions', { token: admin, body: { endpoint: ep('b') } });
    }
    // whitelist family — LOCAL-ONLY (no delete route; cannot clean on shared staging)
    for (const [route, mk] of [
      ['POST /v1/whitelist', (phone) => ({ method: 'POST', path: '/v1/whitelist', token: admin, body: { phone } })],
      ['POST /v1/auth/whitelist-register', (phone) => ({ method: 'POST', path: '/v1/auth/whitelist-register', body: { phone, displayName: 'zz-qa', requestedRole: 'focus_worker' } })],
    ]) {
      if (!IS_LOCAL) { rec('whitelist', `${route} claim/replay/409`, 'SKIP', { reason: 'local-only: no delete route — whitelist rows cannot be cleaned on shared staging' }); continue; }
      await triple('whitelist', route, async (i) => mk(`+97250088${i === 2 ? '12' : '11'}${RUN_ID.slice(-2)}`));
    }
    for (const action of ['approve', 'reject']) {
      const route = `POST /v1/whitelist/:phone/${action}`;
      if (!IS_LOCAL) { rec('whitelist', `${route} claim/replay/409`, 'SKIP', { reason: 'local-only: no delete route — whitelist rows cannot be cleaned on shared staging' }); continue; }
      const p1 = `+97250088${action === 'approve' ? '13' : '14'}${RUN_ID.slice(-2)}`;
      const p2 = `+97250088${action === 'approve' ? '15' : '16'}${RUN_ID.slice(-2)}`;
      await call('POST', '/v1/whitelist', { token: admin, body: { phone: p1 } });
      await call('POST', '/v1/whitelist', { token: admin, body: { phone: p2 } });
      await triple('whitelist', route, async (i) => ({ method: 'POST', path: `/v1/whitelist/${i === 2 ? p2 : p1}/${action}`, token: admin }), { divergentNote: 'same key, other phone' });
    }
  } finally {
    const del = await call('DELETE', `/v1/events/${ctx.eventId}`, { token: admin });
    rec('cleanup', 'event deleted', del.status === 200 ? 'PASS' : 'FAIL', { httpStatus: del.status });
    const crs = await call('GET', `/v1/changes?eventId=${ctx.eventId}`, { token: admin });
    rec('cleanup', 'no CR rows survive event delete', crs.status !== 200 || (crs.json?.changeRequests ?? []).length === 0 ? 'PASS' : 'FAIL', { httpStatus: crs.status });
    const list = (await call('GET', '/v1/events', { token: admin })).json?.events ?? [];
    const left = list.filter((e) => e.name.startsWith('zz-qa-'));
    for (const e of left) await call('DELETE', `/v1/events/${e.id}`, { token: admin });
    rec('cleanup', 'leftover sweep: zero zz-qa- events remain', left.length === 0 ? 'PASS' : 'FAIL', { swept: left.map((e) => e.id) });
  }
  return finish(invOk);
}

function finish(invOk) {
  const hardFails = evidence.filter((e) => e.status === 'FAIL');
  const pending = evidence.filter((e) => e.status === 'PENDING-IMPLEMENTATION');
  const passed = evidence.filter((e) => e.status === 'PASS' || e.status === 'PASS-UNEXPECTED');
  const skipped = evidence.filter((e) => e.status === 'SKIP');
  const summary = { runId: RUN_ID, base: BASE, expect: EXPECT, checks: evidence.length, hardPass: passed.length, pendingImplementation: pending.length, skipped: skipped.length, failed: hardFails.length, inventoryAligned: invOk, throttled };
  console.log(JSON.stringify(summary, null, 2));
  if (OUT) { writeFileSync(OUT, JSON.stringify({ summary, evidence }, null, 2)); console.log(`evidence written: ${OUT}`); }
  process.exit(throttled ? 3 : hardFails.length > 0 || !invOk ? 1 : 0);
}

main().catch((e) => { console.error(e.message); process.exit(throttled ? 3 : 1); });
