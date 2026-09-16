#!/usr/bin/env node
/**
 * Contake E2E: six-vertical domino regression harness (staging evidence).
 *
 * Laws served: 06 (multi-vertical regression protection), 02/10 (evidence, not code),
 * 04/18 (duplicate / out-of-order first pass), 03 (tenant isolation spot probe).
 *
 * TL binding rules (2026-09-17):
 *  - every artifact prefixed zz-qa-; created and fully deleted in the same session;
 *  - leftovers fail the run and are reported;
 *  - seeded demo content and cd-ev1 are never touched (we create our own events);
 *  - API runs only (no demo FE); sequential; abort on 429/throttle;
 *  - default Thursday blackout 08:00-14:00 Asia/Jerusalem for remote bases.
 *
 * Zero-dependency (Node >= 22, global fetch). Usage:
 *   node scripts/e2e/vertical-domino.mjs [--base-url URL] [--vertical ID]
 *        [--include-camp] [--run-id ID] [--out FILE] [--force-blackout-override]
 */
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

const BASE = (opt('base-url', 'https://contake-api-staging.onrender.com') || '').replace(/\/$/, '');
const RUN_ID = opt('run-id', `r${Date.now().toString(36)}`);
const OUT = opt('out', null);
const ONLY = opt('vertical', null);
const INCLUDE_CAMP = has('include-camp');
const FORCE_BLACKOUT = has('force-blackout-override');
const DEMO_DATE = '2027-03-03'; // far-future sacrificial day; never collides with demo content
const TZ = 'Asia/Jerusalem';

const SIX = [
  { id: 'film-shoot',       email: 'admin@film-demo.local',   password: 'admin123', siteId: 'film-site-1', channelId: 'ch-film-client-1' },
  { id: 'event-production', email: 'admin@events-demo.local', password: 'admin123', siteId: 'ev-site-1', channelId: 'ch-ev-client-1' },
  { id: 'conference',       email: 'admin@conf-demo.local',   password: 'admin123', siteId: 'conf-site-1', channelId: 'ch-conf-part-1' },
  { id: 'logistics',        email: 'admin@log-demo.local',    password: 'admin123', siteId: 'log-site-1', channelId: 'ch-log-client-1' },
  { id: 'after-school',     email: 'admin@after-demo.local',  password: 'admin123', siteId: 'as-site-1', channelId: 'ch-as-parent-1' },
  { id: 'education',        email: 'admin@edu-demo.local',    password: 'admin123', siteId: 'edu-site-1', channelId: 'ch-edu-parent-1' },
];
const CAMP = { id: 'camp', email: 'dana@oranim-camp.local', password: 'camp-admin-1', siteId: 'cd-site-1', channelId: 'cd-ch-a-1' };

// ---- blackout guard (TL default: Thursday 08:00-14:00 IL, remote bases only) ----
function jerusalemNow() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { weekday: get('weekday'), hour: Number(get('hour')), minute: Number(get('minute')) };
}
if (!BASE.includes('localhost') && !BASE.includes('127.0.0.1') && !FORCE_BLACKOUT) {
  const j = jerusalemNow();
  if (j.weekday === 'Thu' && j.hour >= 8 && j.hour < 14) {
    console.error(`REFUSED: Thursday blackout 08:00-14:00 ${TZ} in effect (now ${j.hour}:${String(j.minute).padStart(2, '0')} IL). TL default until demo hours confirmed. Override only with --force-blackout-override.`);
    process.exit(2);
  }
}

// ---- evidence sink ----
const evidence = [];
const rec = (vertical, check, pass, detail) => {
  const row = { at: new Date().toISOString(), vertical, check, pass: !!pass, detail };
  evidence.push(row);
  console.log(`${pass ? 'PASS' : 'FAIL'} [${vertical}] ${check}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}` : ''}`);
};
let throttled = false;

// ---- http helpers ----
async function call(method, path, { token, body, timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      signal: ctrl.signal,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'user-agent': `contake-e2e-vertical-domino/${RUN_ID}`,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 429) { throttled = true; throw new Error('THROTTLED_429'); }
    let json = null;
    try { json = await res.json(); } catch { /* non-json */ }
    return { status: res.status, json };
  } finally { clearTimeout(t); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(v) {
  const r = await call('POST', '/v1/auth/login', { body: { email: v.email, password: v.password } });
  if (r.status !== 200 || !r.json?.token) throw new Error(`login failed for ${v.email}: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  return r.json.token;
}

async function runVertical(v, crossTenantTokenById) {
  const tag = v.id;
  let eventId = null;
  let leftover = false;
  const createdNames = [];
  try {
    // 1. create sacrificial event
    const name = `zz-qa-domino-${v.id}-${RUN_ID}`;
    const ev = await call('POST', '/v1/events', { token: v.token, body: { name, date: DEMO_DATE, timezone: TZ, domainProfileId: v.id, siteIds: [v.siteId] } });
    eventId = ev.json?.applied?.event?.id ?? null;
    rec(tag, 'event.create applied (admin allow, no CR)', ev.status === 200 && !!eventId, { status: ev.status, eventId });
    if (!eventId) return;
    createdNames.push(name);

    // 2. watcher group resource (external notify fanout on cascade), then
    //    three-task chain A->B->C with hard lag-0 edges (B depends on A, C on B)
    const grp = await call('POST', `/v1/events/${eventId}/resources`, { token: v.token, body: { resource: { resourceKind: 'group', name: 'zz-qa-watchers', exclusive: false, subscriberChannelIds: [v.channelId] } } });
    const grpId = grp.json?.applied?.createdId ?? null;
    rec(tag, 'resource.create watcher group applied', grp.status === 200 && !!grpId, { status: grp.status, grpId });
    const mk = (n, start, assignees) => call('POST', `/v1/events/${eventId}/tasks`, { token: v.token, body: { task: { name: `zz-qa-${n}`, durationMin: 30, siteId: v.siteId, start, assigneeResourceIds: assignees ?? [] } } });
    const tA = await mk('A', `${DEMO_DATE}T09:00:00+02:00`);
    const tB = await mk('B', `${DEMO_DATE}T09:30:00+02:00`, grpId ? [grpId] : []);
    const tC = await mk('C', `${DEMO_DATE}T10:00:00+02:00`, grpId ? [grpId] : []);
    const ids = [tA.json?.applied?.createdId, tB.json?.applied?.createdId, tC.json?.applied?.createdId];
    rec(tag, 'task.create x3 applied with createdIds', ids.every(Boolean), { ids });
    if (!ids.every(Boolean)) return;
    const [idA, idB, idC] = ids;

    const d1 = await call('POST', `/v1/events/${eventId}/dependencies`, { token: v.token, body: { fromTaskId: idB, toTaskId: idA, lagMin: 0, hard: true } });
    const d2 = await call('POST', `/v1/events/${eventId}/dependencies`, { token: v.token, body: { fromTaskId: idC, toTaskId: idB, lagMin: 0, hard: true } });
    rec(tag, 'dependency.create B depends-on A, C depends-on B (hard, lag 0)', d1.status === 200 && d2.status === 200 && !d1.json?.changeRequest && !d2.json?.changeRequest, { s1: d1.status, s2: d2.status });

    const pub = await call('POST', `/v1/events/${eventId}/publish`, { token: v.token });
    rec(tag, 'event.publish applied', pub.status === 200 && !pub.json?.changeRequest, { status: pub.status });

    // graph snapshot for versions + starts
    const g0 = await call('GET', `/v1/events/${eventId}/graph`, { token: v.token });
    const tasks0 = Object.fromEntries((g0.json?.tasks ?? []).map((t) => [t.id, t]));
    rec(tag, 'graph readable, chain present', !!tasks0[idA] && !!tasks0[idB] && !!tasks0[idC], { status: g0.status });
    const versionA = tasks0[idA]?.version;

    // 3. domino dry-run: move A +45m
    const newStart = `${DEMO_DATE}T09:45:00+02:00`;
    const dry = await call('POST', '/v1/domino/compute', { token: v.token, body: { eventId, change: { type: 'task.move', taskId: idA, newStart } } });
    const dryMoved = new Set((dry.json?.movedTasks ?? []).map((m) => m.taskId));
    rec(tag, 'domino.compute dry-run previews B and C moving', dry.status === 200 && dry.json?.ok === true && dryMoved.has(idB) && dryMoved.has(idC), { ok: dry.json?.ok, moved: [...dryMoved] });

    // 4. apply the move
    const mv = await call('PATCH', `/v1/tasks/${idA}`, { token: v.token, body: { version: versionA, move: { newStart } } });
    const movedApplied = new Set((mv.json?.applied?.domino?.movedTasks ?? []).map((m) => m.taskId));
    rec(tag, 'task.move applied by admin, cascade B+C', mv.status === 200 && movedApplied.has(idB) && movedApplied.has(idC), { status: mv.status, moved: [...movedApplied] });

    const g1 = await call('GET', `/v1/events/${eventId}/graph`, { token: v.token });
    const tasks1 = Object.fromEntries((g1.json?.tasks ?? []).map((t) => [t.id, t]));
    const shiftMin = (a, b) => (Date.parse(b) - Date.parse(a)) / 60000;
    rec(tag, 'B start shifted +45m on graph', shiftMin(tasks0[idB]?.start, tasks1[idB]?.start) === 45, { before: tasks0[idB]?.start, after: tasks1[idB]?.start });
    rec(tag, 'C start shifted +45m on graph', shiftMin(tasks0[idC]?.start, tasks1[idC]?.start) === 45, { before: tasks0[idC]?.start, after: tasks1[idC]?.start });

    // 5. law 04/18 first pass: duplicate retry with stale version must not double-apply
    const dup = await call('PATCH', `/v1/tasks/${idA}`, { token: v.token, body: { version: versionA, move: { newStart } } });
    rec(tag, 'duplicate move retry rejected (VERSION_CONFLICT 409), no double-apply', dup.status === 409 && dup.json?.error?.code === 'VERSION_CONFLICT', { status: dup.status, code: dup.json?.error?.code });
    const g2 = await call('GET', `/v1/events/${eventId}/graph`, { token: v.token });
    const tasks2 = Object.fromEntries((g2.json?.tasks ?? []).map((t) => [t.id, t]));
    rec(tag, 'graph unchanged after duplicate retry', tasks2[idB]?.start === tasks1[idB]?.start && tasks2[idC]?.start === tasks1[idC]?.start, { b: tasks2[idB]?.start, c: tasks2[idC]?.start });

    // 6. notifications + audit evidence
    const nj = await call('GET', `/v1/notifications?eventId=${eventId}`, { token: v.token });
    const jobs = nj.json?.jobs ?? [];
    const movedJob = jobs.find((j) => j.kind === 'task_moved');
    rec(tag, 'notification jobs recorded for domino cascade (task_moved, external fanout)', nj.status === 200 && !!movedJob, { count: jobs.length, kinds: [...new Set(jobs.map((j) => j.kind))], external: jobs.map((j) => j.external) });
    const au = await call('GET', `/v1/audit?eventId=${eventId}`, { token: v.token });
    const actions = new Set((au.json?.audit ?? []).map((e) => e.action));
    const need = ['event.create', 'resource.create', 'task.create', 'dependency.create', 'event.publish', 'task.move'];
    rec(tag, 'audit covers full lifecycle', need.every((a) => actions.has(a)), { missing: need.filter((a) => !actions.has(a)) });

    // 7. law 03: cross-tenant probe (next vertical's admin must not see this graph)
    const cross = crossTenantTokenById[v.id];
    if (cross) {
      const cg = await call('GET', `/v1/events/${eventId}/graph`, { token: cross });
      rec(tag, 'cross-tenant graph read denied (404)', cg.status === 404, { status: cg.status });
      const cm = await call('PATCH', `/v1/tasks/${idA}`, { token: cross, body: { version: 99, move: { newStart } } });
      rec(tag, 'cross-tenant mutation denied (404/403)', cm.status === 404 || cm.status === 403, { status: cm.status });
    }
  } catch (e) {
    if (throttled) { rec(tag, 'ABORTED: 429 throttle - stopping run per TL rule', false, String(e)); throw e; }
    rec(tag, 'unexpected error', false, String(e));
  } finally {
    // cleanup: always attempt full deletion in the same session
    if (eventId) {
      try {
        const del = await call('DELETE', `/v1/events/${eventId}`, { token: v.token });
        rec(tag, 'cleanup: sacrificial event deleted', del.status === 200, { status: del.status, eventId });
        const gone = await call('GET', `/v1/events/${eventId}/graph`, { token: v.token });
        rec(tag, 'cleanup verified: graph 404 after delete', gone.status === 404, { status: gone.status });
      } catch (e) { rec(tag, 'cleanup error', false, String(e)); }
    }
    // leftover sweep: no zz-qa- events may remain in this org
    try {
      const list = await call('GET', '/v1/events', { token: v.token });
      const all = list.json?.events ?? list.json ?? [];
      const left = (Array.isArray(all) ? all : []).filter((e) => (e.name ?? '').startsWith('zz-qa-'));
      leftover = left.length > 0;
      rec(tag, 'leftover sweep: zero zz-qa- events remain', !leftover, left.map((e) => ({ id: e.id, name: e.name })));
    } catch (e) { rec(tag, 'leftover sweep error', false, String(e)); }
  }
}

async function main() {
  const verticals = ONLY
    ? [...SIX, CAMP].filter((v) => v.id === ONLY)
    : INCLUDE_CAMP ? [...SIX, CAMP] : SIX;
  if (verticals.length === 0) { console.error(`unknown --vertical ${ONLY}`); process.exit(2); }

  console.log(`Contake vertical domino regression — run ${RUN_ID} against ${BASE}`);
  console.log(`verticals: ${verticals.map((v) => v.id).join(', ')}`);

  // warm the free-tier API once (cold start can exceed 50s)
  const warm = await call('GET', '/v1/health', { timeoutMs: 90000 }).catch((e) => ({ error: String(e) }));
  rec('setup', 'health warm-up 200', warm.status === 200, { status: warm.status });

  // logins (sequential)
  const tokens = {};
  for (const v of [...SIX, CAMP]) {
    try { tokens[v.id] = await login(v); } catch (e) {
      if (verticals.some((x) => x.id === v.id)) rec('setup', `login ${v.id}`, false, String(e));
    }
    await sleep(250);
  }
  for (const v of verticals) v.token = tokens[v.id];
  // cross-tenant probe uses the NEXT six-vertical's admin (cyclic), camp probed by film
  const order = [...SIX.map((v) => v.id), 'camp'];
  const cross = {};
  for (const v of verticals) {
    const i = order.indexOf(v.id);
    cross[v.id] = tokens[order[(i + 1) % order.length]];
  }

  for (const v of verticals) {
    if (throttled) break;
    if (!v.token) { rec(v.id, 'skipped: no token', false, null); continue; }
    await runVertical(v, cross);
    await sleep(400); // be gentle with free tier
  }

  const fails = evidence.filter((e) => !e.pass);
  const summary = { runId: RUN_ID, base: BASE, at: new Date().toISOString(), verticals: verticals.map((v) => v.id), checks: evidence.length, passed: evidence.length - fails.length, failed: fails.length, throttled };
  console.log('\n==== SUMMARY ====');
  console.log(JSON.stringify(summary, null, 2));
  if (OUT) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(OUT, JSON.stringify({ summary, evidence }, null, 2));
    console.log(`evidence written: ${OUT}`);
  }
  process.exit(fails.length > 0 ? 1 : 0);
}
main().catch((e) => { console.error('fatal:', e); process.exit(throttled ? 3 : 2); });
