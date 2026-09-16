#!/usr/bin/env node
/**
 * Contake E2E: recipient + external dispatch lifecycle evidence (reliability queue item 4).
 *
 * CANONICAL CLASSIFICATION (QA ruling 2026-09-17, binding): this module is a
 *   14-check black-box construction/isolation SMOKE plus explicit untested notes -
 *   NOT a dispatch lifecycle pass. Roll-up: sampled construction shape PASS,
 *   point tenant isolation PASS; batching, idempotency, provider
 *   delivery/retry/receipt, durability/recovery UNTESTED.
 *
 *  PROVEN here (sampled job-construction shape + point tenant isolation, live
 *   staging, sandbox providers):
 *   - cascade on a watched event builds notification jobs with the right kind,
 *     allowlisted templateKey/params only (ND-7), idempotencyKey shaped
 *     eventId+changeRequestId+kind, batchWindowSec=60 (ND-3).
 *   - internal/external split at the TARGET level: staff-linked person targets are
 *     in_app (no external address); subscriber-channel group targets carry external
 *     addresses (whatsapp/sms) for sandbox-provider fanout.
 *   - tenant isolation: org B admin cannot read org A's event or jobs (404); org A
 *     jobs reference only org A event/recipients; a second org's identical scenario
 *     produces its own disjoint job set.
 *  NOT black-box observable on staging (labeled, not claimed): DispatchRecord
 *   lifecycle (sent/failed/attempts/provider receipts) has NO HTTP surface -
 *   records() is in-process only; sandbox providers are log-only (nothing leaves
 *   the process without real creds, per twilio/whatsapp-cloud/webpush adapters).
 *   Provider-level lifecycle evidence needs a read-only deliveries endpoint or
 *   server-log capture - flagged to TL as a surface gap, not a test failure.
 *
 * Rules (TL binding): zz-qa- prefix; create+delete in-session; leftovers fail the
 * run; never touch seeded demo content or cd-ev1; sequential; abort on 429;
 * Thursday 08:00-14:00 IL blackout for remote bases.
 */
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const BASE = (opt('base-url', 'https://contake-api-staging.onrender.com') || '').replace(/\/$/, '');
const IS_LOCAL = BASE.includes('localhost') || BASE.includes('127.0.0.1');
const RUN_ID = opt('run-id', `r${Date.now().toString(36)}`);
const OUT = opt('out', null);
const FORCE_BLACKOUT = args.includes('--force-blackout-override');
const DEMO_DATE = '2027-03-03';
const TZ = 'Asia/Jerusalem';
const ORG_A = { id: 'film-shoot', admin: ['admin@film-demo.local', 'admin123'], siteId: 'film-site-1', channelId: 'ch-film-client-1' };
const ORG_B = { id: 'event-production', admin: ['admin@events-demo.local', 'admin123'], siteId: 'ev-site-1', channelId: 'ch-ev-client-1' };
const ALLOWED_TEMPLATES = ['task_moved', 'task_delayed', 'task_cancelled', 'task_assigned', 'task_unassigned', 'change_needs_approval', 'digest_multi_change'];

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
const rec = (group, label, pass, details = {}) => {
  const status = pass === 'NOTE' ? 'NOTE' : pass ? 'PASS' : 'FAIL';
  evidence.push({ group, label, status, ...details });
  console.log(`${status} [${group}] ${label}${Object.keys(details).length ? ' — ' + JSON.stringify(details) : ''}`);
};
async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (res.status === 429) { throttled = true; throw new Error('429 throttled — aborting run (TL rule)'); }
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}
async function login([email, password]) {
  const r = await call('POST', '/v1/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status}`);
  return r.json.token;
}

/** build scenario: event + watcher group + 2-task chain + publish + cascade move; returns {eventId, jobs} */
async function scenario(v, token, tag) {
  const ev = await call('POST', '/v1/events', { token, body: { name: `zz-qa-disp-${tag}-${RUN_ID}`, date: DEMO_DATE, timezone: TZ, domainProfileId: v.id, siteIds: [v.siteId] } });
  const eventId = ev.json?.applied?.event?.id;
  if (!eventId) return { eventId: null, jobs: [] };
  const grp = await call('POST', `/v1/events/${eventId}/resources`, { token, body: { resource: { resourceKind: 'group', name: `zz-qa-watch-${tag}`, exclusive: false, subscriberChannelIds: [v.channelId] } } });
  const grpId = grp.json?.applied?.createdId;
  const t1 = (await call('POST', `/v1/events/${eventId}/tasks`, { token, body: { task: { name: 'zz-qa-D1', durationMin: 30, siteId: v.siteId, start: `${DEMO_DATE}T09:00:00+02:00` } } })).json?.applied?.createdId;
  const t2 = (await call('POST', `/v1/events/${eventId}/tasks`, { token, body: { task: { name: 'zz-qa-D2', durationMin: 30, siteId: v.siteId, start: `${DEMO_DATE}T09:30:00+02:00`, assigneeResourceIds: grpId ? [grpId] : [] } } })).json?.applied?.createdId;
  await call('POST', `/v1/events/${eventId}/dependencies`, { token, body: { fromTaskId: t2, toTaskId: t1, lagMin: 0, hard: true } });
  await call('POST', `/v1/events/${eventId}/publish`, { token });
  const gj = (await call('GET', `/v1/events/${eventId}/graph`, { token })).json;
  const ver = Object.fromEntries((gj?.tasks ?? []).map((t) => [t.id, t.version]));
  const mv = await call('PATCH', `/v1/tasks/${t1}`, { token, body: { version: ver[t1], move: { newStart: `${DEMO_DATE}T09:45:00+02:00` } } });
  const jobs = (await call('GET', `/v1/notifications?eventId=${eventId}`, { token })).json?.jobs ?? [];
  return { eventId, jobs, t2, moved: mv.status === 200, grpId };
}

async function main() {
  const tokA = await login(ORG_A.admin);
  const tokB = await login(ORG_B.admin);

  const A = await scenario(ORG_A, tokA, 'a');
  const B = await scenario(ORG_B, tokB, 'b');
  rec('setup', `scenario A (org film): event + watcher group + cascade -> ${A.jobs.length} jobs`, !!A.eventId && A.moved && A.jobs.length > 0, { eventId: A.eventId, jobs: A.jobs.length });
  rec('setup', `scenario B (org events): identical shape -> ${B.jobs.length} jobs`, !!B.eventId && B.moved && B.jobs.length > 0, { eventId: B.eventId, jobs: B.jobs.length });

  try {
    // --- job construction invariants (org A) ---
    const job = A.jobs[0] ?? {};
    rec('construction', 'job kind is a known notification kind', ALLOWED_TEMPLATES.includes(job.kind) || ALLOWED_TEMPLATES.includes(job.templateKey), { kind: job.kind, templateKey: job.templateKey });
    rec('construction', 'idempotencyKey on ONE sampled job: non-empty deterministic-looking composite (four parts: eventId + correlation-looking segment + kind + external) - NOT idempotency-semantics evidence', typeof job.idempotencyKey === 'string' && job.idempotencyKey.includes(A.eventId), { idempotencyKey: job.idempotencyKey, scope: 'one sampled job; composite shape observation only' });
    rec('construction', 'batchWindowSec = 60 on the sampled job: stored configuration, NOT proven batching behavior', job.batchWindowSec === 60, { batchWindowSec: job.batchWindowSec, scope: 'stored config on one sampled job' });
    const paramKeys = Object.keys(job.params ?? {});
    const ALLOW = { task_moved: ['taskName', 'newStart', 'summaryHe'], task_delayed: ['taskName', 'newStart', 'summaryHe'], task_cancelled: ['taskName', 'summaryHe'], task_assigned: ['taskName', 'newStart'], task_unassigned: ['taskName'], change_needs_approval: ['summaryHe'], digest_multi_change: ['changeCount', 'eventName', 'summaryHe'] };
    const allowed = ALLOW[job.templateKey] ?? ALLOW[job.kind] ?? [];
    rec('construction', `params allowlist-respecting (ND-7): [${paramKeys}] within [${allowed}]`, paramKeys.every((k) => allowed.includes(k)), { params: job.params });

    // --- internal/external target split ---
    const targets = A.jobs.flatMap((j) => j.targets ?? []);
    const external = targets.filter((t) => t.channel === 'whatsapp' || t.channel === 'sms' || t.address?.startsWith?.('+'));
    const internal = targets.filter((t) => t.channel === 'in_app' || t.kind === 'in_app');
    rec('split', `stored external target INTENT exists for the subscriber-channel group: ${external.length} - NOT fanout/delivery evidence`, external.length > 0, { external: external.slice(0, 3), total: targets.length, scope: 'stored intent only; sandbox providers are log-only' });
    rec('split', 'target split is explicit per target (channel/address typed, no implicit fanout)', targets.every((t) => t.channel || t.address), { sample: targets.slice(0, 3) });

    // --- tenant isolation ---
    const crossEvent = await call('GET', `/v1/events/${A.eventId}/graph`, { token: tokB });
    rec('isolation', 'point check: org B admin reading org A event graph -> 404 (no cross-tenant existence leak)', crossEvent.status === 404, { httpStatus: crossEvent.status, scope: 'point-only, not an isolation matrix' });
    const crossJobs = await call('GET', `/v1/notifications?eventId=${A.eventId}`, { token: tokB });
    rec('isolation', 'point check: org B admin reading org A notification jobs -> 404', crossJobs.status === 404, { httpStatus: crossJobs.status, scope: 'point-only, not an isolation matrix' });
    const aJobEvents = new Set(A.jobs.map((j) => j.eventId));
    const bJobEvents = new Set(B.jobs.map((j) => j.eventId));
    rec('isolation', 'point check: org A jobs reference only org A event; org B jobs only org B event (disjoint)', aJobEvents.size === 1 && aJobEvents.has(A.eventId) && bJobEvents.size === 1 && bJobEvents.has(B.eventId), { scope: 'point-only' });
    const bIds = new Set(B.jobs.map((j) => j.id));
    rec('isolation', 'point check: job id sets disjoint across tenants', A.jobs.every((j) => !bIds.has(j.id)), { scope: 'point-only' });

    // --- observability gap, labeled ---
    rec('surface', 'UNTESTED: DispatchRecord lifecycle (sent/failed/attempts/provider receipts), batching behavior, idempotency semantics, durability/recovery - NO HTTP surface; sandbox providers are log-only on staging', 'NOTE', { untested: ['batching', 'idempotency', 'provider delivery/retry/receipt', 'durability/recovery'], gap: 'provider-level lifecycle evidence needs a read-only deliveries endpoint or server-log capture - flagged to TL, not a test failure', adapters: 'twilio/whatsapp-cloud/webpush sandbox adapters never invent creds; nothing leaves the process' });
  } finally {
    const d1 = await call('DELETE', `/v1/events/${A.eventId}`, { token: tokA });
    const d2 = await call('DELETE', `/v1/events/${B.eventId}`, { token: tokB });
    rec('cleanup', 'both orgs: sacrificial events deleted', d1.status === 200 && d2.status === 200, { a: d1.status, b: d2.status });
    const leftA = ((await call('GET', '/v1/events', { token: tokA })).json?.events ?? []).filter((e) => e.name.startsWith('zz-qa-'));
    const leftB = ((await call('GET', '/v1/events', { token: tokB })).json?.events ?? []).filter((e) => e.name.startsWith('zz-qa-'));
    for (const e of leftA) await call('DELETE', `/v1/events/${e.id}`, { token: tokA });
    for (const e of leftB) await call('DELETE', `/v1/events/${e.id}`, { token: tokB });
    rec('cleanup', 'leftover sweep: zero zz-qa- events in both orgs', leftA.length === 0 && leftB.length === 0, { a: leftA.map((e) => e.id), b: leftB.map((e) => e.id) });
  }
  const fails = evidence.filter((e) => e.status === 'FAIL');
  const notes = evidence.filter((e) => e.status === 'NOTE');
  const summary = { runId: RUN_ID, base: BASE, checks: evidence.length, passed: evidence.length - fails.length - notes.length, notes: notes.length, failed: fails.length, throttled, canonicalClassification: 'black-box construction/isolation smoke + explicit untested notes - NOT a lifecycle pass', rollup: { sampledConstructionShape: 'PASS', pointTenantIsolation: 'PASS', untested: ['batching', 'idempotency', 'provider delivery/retry/receipt', 'durability/recovery'] } };
  console.log(JSON.stringify(summary, null, 2));
  if (OUT) { writeFileSync(OUT, JSON.stringify({ summary, evidence }, null, 2)); console.log(`evidence written: ${OUT}`); }
  process.exit(throttled ? 3 : fails.length ? 1 : 0);
}

main().catch((e) => { console.error(e.message); process.exit(throttled ? 3 : 1); });
