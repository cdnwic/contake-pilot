#!/usr/bin/env node
/**
 * Contake E2E: audit-trail evidence (reliability queue item 3).
 *
 * Proves on the live stack (QA AC-AUD-1, constitution laws 09/19):
 *  A. Every mutation in a scripted scenario appends an audit row with actor,
 *     role, action, entityType, entityId, before/after, createdAt.
 *  B. Rows are causally ordered (create -> dependency -> publish -> move ->
 *     report -> resolve) and sort consistently by createdAt/id.
 *  C. before/after TRUTH: create rows carry after with the created entity and
 *     null before; the move row's before/after carry the real old/new starts.
 *  D. REDACTION: recursive scan of every audit row (whole org view) for
 *     forbidden material: passwordHash, password values, tokens, secrets,
 *     OTP/devCode. Any hit = FAIL (security finding, not a QA pass).
 *  E. Visibility rules: focus_worker 403 on /v1/audit; field_manager rows are
 *     scope-filtered; a mutating deny appends a denied row with null
 *     before/afterJson (contracts v1.9).
 *
 * Rules (TL binding): zz-qa- prefix; create+delete in-session; leftovers fail
 * the run; never touch seeded demo content or cd-ev1; sequential; abort on
 * 429; Thursday 08:00-14:00 IL blackout for remote bases.
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
const V = { id: 'film-shoot', admin: ['admin@film-demo.local', 'admin123'], fm: ['fm@film-demo.local', 'fm12345'], focusPhone: '+972500100101', siteId: 'film-site-1', channelId: 'ch-film-client-1' };
const FORBIDDEN_KEYS = /password(hash)?|secret|token|otp|devcode|authorization/i;
const FORBIDDEN_VALUES = ['admin123', 'fm12345', 'camp-admin-1'];

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
  evidence.push({ group, label, status: pass ? 'PASS' : 'FAIL', ...details });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${group}] ${label}${Object.keys(details).length ? ' — ' + JSON.stringify(details) : ''}`);
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
async function login(email, password) {
  const r = await call('POST', '/v1/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status}`);
  return r.json.token;
}

/** recursive forbidden-material scan; returns list of jsonpaths that hit */
function leaks(node, path = '$', hits = []) {
  if (node === null || node === undefined) return hits;
  if (typeof node === 'string') {
    for (const v of FORBIDDEN_VALUES) if (node.includes(v)) hits.push(`${path} contains seeded credential value`);
    return hits;
  }
  if (Array.isArray(node)) { node.forEach((x, i) => leaks(x, `${path}[${i}]`, hits)); return hits; }
  if (typeof node === 'object') {
    for (const [k, val] of Object.entries(node)) {
      if (FORBIDDEN_KEYS.test(k)) hits.push(`${path}.${k} (key name)`);
      // beforeJson/afterJson are JSON strings: parse and descend
      if ((k === 'beforeJson' || k === 'afterJson') && typeof val === 'string') {
        try { leaks(JSON.parse(val), `${path}.${k}`, hits); } catch { /* non-JSON */ }
      } else leaks(val, `${path}.${k}`, hits);
    }
  }
  return hits;
}

async function main() {
  const admin = await login(...V.admin);
  const fm = await login(...V.fm);
  // focus_worker login via OTP (honest label if dev OTP is suppressed)
  let focus = null;
  const otp = await call('POST', '/v1/auth/otp/request', { body: { phone: V.focusPhone } });
  const devCode = otp.json?.devCode;
  if (devCode) {
    const ver = await call('POST', '/v1/auth/otp/verify', { body: { phone: V.focusPhone, code: devCode } });
    focus = ver.json?.token ?? null;
  }
  rec('setup', 'focus_worker OTP login', focus ? 'PASS' : 'SKIP', focus ? {} : { note: 'devCode suppressed on this base (CONTAKE_DEV_OTP unset) — focus_worker checks skipped', httpStatus: otp.status });

  const ctx = {};
  const g = async () => {
    const j = (await call('GET', `/v1/events/${ctx.eventId}/graph`, { token: admin })).json;
    return { event: j?.event, tasks: Object.fromEntries((j?.tasks ?? []).map((t) => [t.id, t.version])) };
  };

  // --- scripted mutation scenario (causal chain) ---
  const ev = await call('POST', '/v1/events', { token: admin, body: { name: `zz-qa-aud-${RUN_ID}`, date: DEMO_DATE, timezone: TZ, domainProfileId: V.id, siteIds: [V.siteId] } });
  ctx.eventId = ev.json?.applied?.event?.id;
  if (!ctx.eventId) { rec('setup', 'event.create', false, { httpStatus: ev.status }); return finish(); }
  const t1 = (await call('POST', `/v1/events/${ctx.eventId}/tasks`, { token: admin, body: { task: { name: 'zz-qa-A1', durationMin: 30, siteId: V.siteId, start: `${DEMO_DATE}T09:00:00+02:00` } } })).json?.applied?.createdId;
  const t2 = (await call('POST', `/v1/events/${ctx.eventId}/tasks`, { token: admin, body: { task: { name: 'zz-qa-A2', durationMin: 30, siteId: V.siteId, start: `${DEMO_DATE}T09:30:00+02:00` } } })).json?.applied?.createdId;
  await call('POST', `/v1/events/${ctx.eventId}/dependencies`, { token: admin, body: { fromTaskId: t2, toTaskId: t1, lagMin: 0, hard: true } });
  await call('POST', `/v1/events/${ctx.eventId}/publish`, { token: admin });
  const gv = await g();
  const mv = await call('PATCH', `/v1/tasks/${t1}`, { token: admin, body: { version: gv.tasks[t1], move: { newStart: `${DEMO_DATE}T09:45:00+02:00` } } });
  rec('setup', 'scenario applied (event, 2 tasks, dep, publish, move+cascade)', !!(t1 && t2) && mv.status === 200, { httpStatus: mv.status });
  const rep = await call('POST', '/v1/reports', { token: admin, body: { taskId: t2, status: 'done', clientReportId: `zz-qa-aud-${RUN_ID}`, clientTimestamp: new Date().toISOString() } });
  const repId = rep.json?.report?.id;
  if (repId) await call('POST', `/v1/reports/${repId}/resolve`, { token: admin });
  // a mutating deny for the denied-row check (focus_worker attempts task.create)
  if (focus) await call('POST', `/v1/events/${ctx.eventId}/tasks`, { token: focus, body: { task: { name: 'zz-qa-denied', durationMin: 15, siteId: V.siteId } } });

  try {
    // --- A/B: rows present, causally ordered ---
    const aud = (await call('GET', `/v1/audit?eventId=${ctx.eventId}`, { token: admin })).json?.audit ?? [];
    rec('audit', `rows returned for sacrificial event: ${aud.length}`, aud.length >= 6, { count: aud.length });
    const actions = aud.map((a) => a.action);
    const orderOk = (arr, seq) => { let i = 0; for (const a of arr) if (a === seq[i]) i++; return i === seq.length; };
    rec('audit', 'causal order: event.create -> task.create -> dependency.create -> publish -> task.move -> report -> resolve', orderOk(actions, ['event.create', 'task.create', 'dependency.create', 'event.publish', 'task.move', 'report.status.create', 'report.resolve']), { actions: [...new Set(actions)] });
    const sorted = [...aud].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    rec('audit', 'createdAt/id ordering is consistent', JSON.stringify(sorted.map((a) => a.id)) === JSON.stringify(aud.map((a) => a.id)) || aud.every((a, i) => i === 0 || a.createdAt >= aud[i - 1].createdAt), {});
    // every row carries required fields
    const missing = aud.filter((a) => !a.actorUserId || !a.role || !a.action || !a.entityType || !a.entityId || !a.createdAt || a.beforeJson === undefined || a.afterJson === undefined);
    rec('audit', 'every row carries actor/role/action/entity/createdAt/beforeJson/afterJson fields', missing.length === 0, { missing: missing.length });

    // --- C: before/after truth ---
    const createRow = aud.find((a) => a.action === 'task.create' && a.entityId === t1);
    const cAfter = createRow ? JSON.parse(createRow.afterJson ?? 'null') : null;
    rec('audit', 'task.create row: null before, after carries created task (name zz-qa-A1)', !!createRow && createRow.beforeJson === null && cAfter?.name === 'zz-qa-A1', { hasRow: !!createRow });
    const moveRow = aud.find((a) => a.action === 'task.move' && a.entityId === t1);
    const mBefore = moveRow ? JSON.parse(moveRow.beforeJson ?? 'null') : null;
    const mAfter = moveRow ? JSON.parse(moveRow.afterJson ?? 'null') : null;
    rec('audit', 'task.move row: before start 09:00, after start 09:45 (real old/new values)', !!moveRow && (mBefore?.start ?? mBefore?.beforeStart ?? '').includes('09:00') && (mAfter?.start ?? mAfter?.afterStart ?? '').includes('09:45'), { before: mBefore, after: mAfter });

    // --- D: redaction scan over the WHOLE org audit view ---
    const orgAudit = (await call('GET', '/v1/audit', { token: admin })).json?.audit ?? [];
    const hits = leaks(orgAudit);
    rec('redaction', `org-wide audit scan (${orgAudit.length} rows): no passwordHash/tokens/secrets/OTP/seeded credentials`, hits.length === 0, { hits: hits.slice(0, 5), rows: orgAudit.length });

    // --- E: visibility rules ---
    if (focus) {
      const fw = await call('GET', `/v1/audit?eventId=${ctx.eventId}`, { token: focus });
      rec('visibility', 'focus_worker GET /v1/audit -> 403', fw.status === 403, { httpStatus: fw.status });
      const deniedRow = aud.find((a) => a.action === 'task.create' && a.entityId === 'pending' && a.beforeJson === null && a.afterJson === null) ?? aud.find((a) => a.outcome === 'denied' || (a.beforeJson === null && a.afterJson === null && a.action === 'task.create' && a.entityId !== t1));
      rec('visibility', 'mutating deny appended a denied row with null before/after (contracts v1.9)', !!deniedRow, { found: !!deniedRow });
    }
    const fmAud = (await call('GET', `/v1/audit?eventId=${ctx.eventId}`, { token: fm })).json?.audit ?? [];
    const fmSeesForeign = fmAud.some((a) => a.eventId === ctx.eventId && a.actorUserId !== undefined && a.action === 'event.create');
    rec('visibility', `field_manager audit view is scope-filtered (sacrificial event out of FM scope -> ${fmAud.length} rows, no admin event.create row)`, !fmSeesForeign, { fmRows: fmAud.length });
  } finally {
    const del = await call('DELETE', `/v1/events/${ctx.eventId}`, { token: admin });
    rec('cleanup', 'event deleted', del.status === 200, { httpStatus: del.status });
    const list = (await call('GET', '/v1/events', { token: admin })).json?.events ?? [];
    const left = list.filter((e) => e.name.startsWith('zz-qa-'));
    for (const e of left) await call('DELETE', `/v1/events/${e.id}`, { token: admin });
    rec('cleanup', 'leftover sweep: zero zz-qa- events remain', left.length === 0, { swept: left.map((e) => e.id) });
    // note: audit rows of deleted events persist by design (append-only log) - not leftovers
  }
  return finish();
}

function finish() {
  const fails = evidence.filter((e) => e.status === 'FAIL');
  const summary = { runId: RUN_ID, base: BASE, checks: evidence.length, passed: evidence.length - fails.length, failed: fails.length, throttled };
  console.log(JSON.stringify(summary, null, 2));
  if (OUT) { writeFileSync(OUT, JSON.stringify({ summary, evidence }, null, 2)); console.log(`evidence written: ${OUT}`); }
  process.exit(throttled ? 3 : fails.length ? 1 : 0);
}

main().catch((e) => { console.error(e.message); process.exit(throttled ? 3 : 1); });
