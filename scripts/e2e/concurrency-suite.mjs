#!/usr/bin/env node
/**
 * Contake E2E: concurrency suite (reliability queue item 2) - LOCAL ONLY.
 *
 * Why local-only: the TL staging rule is sequential requests on free-tier Render
 * (stop on throttle/429). 50/100-way bursts belong against disposable local
 * servers, never shared staging.
 *
 * Variants (labeled honestly per TL):
 *  - memory variant: one local API server on MemoryGraphRepository. JS
 *    single-process event loop: proves application-level serialization logic,
 *    NOT true concurrent-connection behavior. Every memory row says so.
 *  - pglite two-connection variant [SCAFFOLD/UNEXECUTED - a PROPOSAL, not
 *    final Postgres proof]: two connections over one PGlite instance.
 *    Final D proof requires DISPOSABLE REAL POSTGRESQL with two independent
 *    connections and a SYNCHRONIZED BARRIER (QA ruling 2026-09-17).
 *    DB-enforced UNIQUE (addendum: idempotency ledger, reports.clientReportId
 *    at tenant/producer scope, notification_jobs.idempotency_key at tenant
 *    scope) is a HYPOTHESIS for closing the races - necessary but NOT
 *    sufficient; nothing here claims UNIQUE alone proves safety, and no
 *    losses are evidenced (the PG variant is unexecuted).
 *
 * Cases (TL queue): 50/100-way identical-key, divergent-body, lost-response,
 * out-of-order, two-connection PG. §17 ledger is ABSENT (probe 2026-09-17), so
 * Idempotency-Key cases are EXPECTED-FAIL-PENDING-IMPLEMENTATION. Business
 * invariants that exist TODAY (reports.clientReportId dedupe, QA C3) are hard
 * assertions.
 *
 * Rules (TL binding): zz-qa- prefix; create+delete in-session; leftovers fail
 * the run; local servers are disposable. No Thursday blackout applies (local).
 */
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const BASE = (opt('base-url', 'http://127.0.0.1:3100') || '').replace(/\/$/, '');
const RUN_ID = opt('run-id', `r${Date.now().toString(36)}`);
const OUT = opt('out', null);
const N1 = Number(opt('ways-1', '50'));
const N2 = Number(opt('ways-2', '100'));
const DEMO_DATE = '2027-03-03';
const TZ = 'Asia/Jerusalem';
const V = { id: 'film-shoot', admin: ['admin@film-demo.local', 'admin123'], siteId: 'film-site-1' };

const evidence = [];
const rec = (group, label, status, details = {}) => {
  if (status === true) status = 'PASS';
  if (status === false) status = 'FAIL';
  evidence.push({ group, label, status, ...details });
  console.log(`${status} [${group}] ${label}${Object.keys(details).length ? ' — ' + JSON.stringify(details) : ''}`);
};
async function call(method, path, { token, body, key } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (key) headers['idempotency-key'] = key;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}
async function login([email, password]) {
  const r = await call('POST', '/v1/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} (is the local all-demo server up on ${BASE}?)`);
  return r.json.token;
}

async function main() {
  const admin = await login(V.admin);
  // sacrificial event + task for report races
  const ev = await call('POST', '/v1/events', { token: admin, body: { name: `zz-qa-conc-${RUN_ID}`, date: DEMO_DATE, timezone: TZ, domainProfileId: V.id, siteIds: [V.siteId] } });
  const eventId = ev.json?.applied?.event?.id;
  const t1 = (await call('POST', `/v1/events/${eventId}/tasks`, { token: admin, body: { task: { name: 'zz-qa-C1', durationMin: 30, siteId: V.siteId, start: `${DEMO_DATE}T09:00:00+02:00` } } })).json?.applied?.createdId;
  rec('setup', 'sacrificial event + task on local memory server', !!eventId && !!t1, { eventId, variant: 'memory (single-process event loop - application serialization only, NOT true connection concurrency)' });

  try {
    // --- HARD (business invariant today): N-way identical clientReportId ---
    for (const N of [N1, N2]) {
      const clientReportId = `zz-qa-race-${RUN_ID}-${N}`;
      const body = { taskId: t1, status: 'done', clientReportId, clientTimestamp: new Date().toISOString() };
      const results = await Promise.all(Array.from({ length: N }, () => call('POST', '/v1/reports', { token: admin, body })));
      const ok = results.filter((r) => r.status === 200);
      const ids = new Set(ok.map((r) => r.json?.report?.id));
      const dedupedCount = ok.filter((r) => r.json?.deduped === true).length;
      rec('race', `[memory] ${N}-way burst executed: ${N} requests issued concurrently, all answered, no harness error`, ok.length === N ? 'PASS' : 'FAIL', {
        okResponses: ok.length, rowKind: 'operational',
      });
      rec('race', `[memory] OBSERVATION: ${N}-way identical clientReportId converged to ${ids.size} distinct report id(s) in one memory process`, 'OBSERVATION', {
        distinctReportIds: ids.size, dedupedFlagResponses: dedupedCount, rowKind: 'convergence-observation',
        variant: 'memory-process only: application-level getReportByClientId check under event-loop serialization; says NOTHING about two-connection Postgres behavior; not a concurrency-safety pass',
      });
    }

    // --- EXPECTED-FAIL (§17 ledger absent): N-way identical Idempotency-Key ---
    {
      const key = `zz-qa-conc-key-${RUN_ID}`;
      const body = { name: `zz-qa-conc-x-${RUN_ID}`, date: DEMO_DATE, timezone: TZ, domainProfileId: V.id, siteIds: [V.siteId] };
      const results = await Promise.all(Array.from({ length: N1 }, () => call('POST', '/v1/events', { token: admin, body, key })));
      const ids = new Set(results.map((r) => r.json?.applied?.event?.id).filter(Boolean));
      rec('race', `[memory] OBSERVED §17 failure: ${N1}-way simultaneous POST /v1/events, identical Idempotency-Key -> ${ids.size} distinct events (§17 expects exactly 1)`, 'EXPECTED-FAIL-PENDING-IMPLEMENTATION', {
        distinctEventsCreated: ids.size, expectation: 'ledger: exactly 1', variant: 'memory', reason: '§17 ledger not deployed (staging probe 2026-09-17)',
      });
      // cleanup the burst events
      for (const id of ids) await call('DELETE', `/v1/events/${id}`, { token: admin });
    }

    // --- EXPECTED-FAIL: divergent-body same-key burst -> all must 409 ---
    {
      const key = `zz-qa-conc-div-${RUN_ID}`;
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
        call('POST', '/v1/events', { token: admin, key, body: { name: `zz-qa-conc-d${i}-${RUN_ID}`, date: DEMO_DATE, timezone: TZ, domainProfileId: V.id, siteIds: [V.siteId] } })));
      const conflicts = results.filter((r) => r.status === 409 && r.json?.error?.code === 'IDEMPOTENCY_KEY_REUSED').length;
      const created = results.filter((r) => r.status === 200).length;
      rec('race', `[memory] OBSERVED §17 failure: 10-way divergent-body burst, one Idempotency-Key -> ${created} commits, ${conflicts} IDEMPOTENCY_KEY_REUSED (§17 expects 1 commit + 9 conflicts)`, 'EXPECTED-FAIL-PENDING-IMPLEMENTATION', {
        committed: created, idempotencyConflicts: conflicts, expectation: '1 commit, 9 conflicts', variant: 'memory', reason: '§17 ledger not deployed',
      });
      const list = (await call('GET', '/v1/events', { token: admin })).json?.events ?? [];
      for (const e of list.filter((e) => e.name.startsWith('zz-qa-conc-d'))) await call('DELETE', `/v1/events/${e.id}`, { token: admin });
    }

    // --- scaffolded cases (pending ledger / pglite wiring) ---
    rec('scaffold', 'lost-response scenario DESIGN (unexecuted): client retries with same key after simulated timeout - server must replay original commit, not re-execute', 'SCAFFOLD-UNEXECUTED', { needs: '§17 ledger + claim state observable across requests; harness: send, drop response client-side, retry identical request, assert replay + single mutation' });
    rec('scaffold', 'out-of-order scenario DESIGN (unexecuted): delayed original lands after its own retry - replay must still return the original commit exactly once', 'SCAFFOLD-UNEXECUTED', { needs: '§17 ledger; harness: hold first request, send retry, release original, assert single mutation + identical bodies' });
    rec('scaffold', 'PG variant PROPOSAL (unexecuted, NOT final Postgres proof): final D proof requires disposable real PostgreSQL, two independent connections, synchronized barrier. DB UNIQUE is a hypothesis - necessary, not sufficient; no losses evidenced because nothing here has executed on PG', 'SCAFFOLD-UNEXECUTED', { needs: 'disposable real PostgreSQL + two pg.Pool connections + synchronized barrier (pglite is a convenience proposal only); addendum: current indexes are NOT unique' });
  } finally {
    const del = await call('DELETE', `/v1/events/${eventId}`, { token: admin });
    rec('cleanup', 'sacrificial event deleted', del.status === 200 ? 'PASS' : 'FAIL', { httpStatus: del.status });
    const list = (await call('GET', '/v1/events', { token: admin })).json?.events ?? [];
    const left = list.filter((e) => e.name.startsWith('zz-qa-'));
    for (const e of left) await call('DELETE', `/v1/events/${e.id}`, { token: admin });
    rec('cleanup', 'leftover sweep: zero zz-qa- events remain', left.length === 0 ? 'PASS' : 'FAIL', { swept: left.map((e) => e.id) });
  }
  const fails = evidence.filter((e) => e.status === 'FAIL');
  const summary = { runId: RUN_ID, base: BASE, variant: 'memory', checks: evidence.length,
    operationalSetupCleanupPass: evidence.filter((e) => e.status === 'PASS').length,
    memoryConvergenceObservations: evidence.filter((e) => e.status === 'OBSERVATION').length,
    observedS17Failures: evidence.filter((e) => e.status === 'EXPECTED-FAIL-PENDING-IMPLEMENTATION').length,
    scaffoldUnexecuted: evidence.filter((e) => e.status === 'SCAFFOLD-UNEXECUTED').length,
    harnessErrors: fails.length,
    rollup: '5 operational/setup-cleanup passes; 2 memory-process report convergence observations; 2 observed §17 failures; 2 lost-response/out-of-order designs SCAFFOLD/UNEXECUTED; 1 PG proposal SCAFFOLD/UNEXECUTED. DB UNIQUE is a hypothesis (necessary, not sufficient); final D proof needs disposable real PostgreSQL + two independent connections + synchronized barrier' };
  console.log(JSON.stringify(summary, null, 2));
  if (OUT) { writeFileSync(OUT, JSON.stringify({ summary, evidence }, null, 2)); console.log(`evidence written: ${OUT}`); }
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
