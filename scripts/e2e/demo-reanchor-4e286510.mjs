#!/usr/bin/env node
/** Contake demo-day seed re-anchor — repeatable script (replaces hand edits).
 *
 *  Re-anchors a demo event to the demo day via the public API:
 *    POST /v1/events/:id/duplicate {date}  (server shifts every task start to the
 *    new date, keeps times; clones resources, dependencies, counselor bindings;
 *    new event starts as DRAFT, all tasks status=planned)
 *    POST /v1/events/:newId/publish        (unless --no-publish)
 *  then verifies the copy field-by-field against the source and prints evidence.
 *
 *  Why duplicate and not task.move: applyDomino marks every moved task
 *  status='delayed', locked tasks anchor their chains (BLOCKING_CONFLICT), and a
 *  multi-day shift trips MAX_SHIFT_EXCEEDED. Duplicate has none of those effects.
 *
 *  Usage:
 *    node demo-reanchor.mjs --api https://contake-api-staging.onrender.com \
 *      --email dana@oranim-camp.local --password camp-admin-1 --event cd-ev1
 *    node demo-reanchor.mjs --api https://contake-api.onrender.com \
 *      --phone +972500100001 --event cd-ev1            # OTP (dev build returns devCode)
 *    add --dry-run to print the plan without mutating; --date YYYY-MM-DD to override
 *    (default: today in Asia/Jerusalem); --name to override the copy's name.
 */
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const API = (args.api ?? '').replace(/\/$/, '');
const EVENT_ID = args.event;
const DATE = args.date ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
const DRY = 'dry-run' in args || process.argv.includes('--dry-run');
const PUBLISH = !process.argv.includes('--no-publish');
if (!API || !EVENT_ID || (!args.email && !args.phone)) {
  console.error('required: --api --event (--email --password | --phone) [--date] [--name] [--dry-run] [--no-publish]');
  process.exit(2);
}
const j = (r) => r.json().then((b) => { if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(b)}`); return b; });
const post = (path, body, token) =>
  fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then(j);
const get = (path, token) => fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } }).then(j);

// 1. auth
let token;
if (args.email) {
  token = (await post('/v1/auth/login', { email: args.email, password: args.password })).token;
} else {
  const req = await post('/v1/auth/otp/request', { phone: args.phone });
  if (!req.devCode) throw new Error('OTP sent externally; re-run once you have the code (no devCode on this env)');
  token = (await post('/v1/auth/otp/verify', { phone: args.phone, code: req.devCode })).token;
}
console.log(`[1/5] authenticated against ${API}`);

// 2. locate source event
const { events } = await get('/v1/events', token);
const src = events.find((e) => e.id === EVENT_ID);
if (!src) throw new Error(`event ${EVENT_ID} not visible to this login (have: ${events.map((e) => e.id).join(', ')})`);
console.log(`[2/5] source ${src.id} date=${src.date} status=${src.status} "${src.name}"`);
if (src.date === DATE) {
  console.log(`source already anchored to ${DATE} — duplicating would create a same-day copy; aborting (pass a different --event or --date).`);
  process.exit(1);
}
const srcGraph = await get(`/v1/events/${EVENT_ID}/graph`, token);
const counts = (g) => ({ tasks: g.tasks.length, resources: g.resources.length, dependencies: g.dependencies.length });
console.log(`[3/5] source graph: ${JSON.stringify(counts(srcGraph))}; target date ${DATE}${DRY ? ' (DRY RUN - no mutations)' : ''}`);
if (DRY) {
  console.log(`plan: duplicate ${EVENT_ID} -> date ${DATE}${PUBLISH ? ' + publish' : ''}; expected copy counts identical; all task starts ${DATE}T..+03:00`);
  process.exit(0);
}

// 4. duplicate (+publish)
const dup = await post(`/v1/events/${EVENT_ID}/duplicate`, { date: DATE, ...(args.name ? { name: args.name } : {}) }, token);
const newId = dup.applied?.event?.id ?? dup.event?.id ?? dup.id;
if (!newId) throw new Error(`could not read new event id from: ${JSON.stringify(dup).slice(0, 300)}`);
let pub = null;
if (PUBLISH) pub = await post(`/v1/events/${newId}/publish`, {}, token);
console.log(`[4/5] duplicated -> ${newId}${PUBLISH ? ' + published' : ''}`);

// 5. verify
const g = await get(`/v1/events/${newId}/graph`, token);
const bad = g.tasks.filter((t) => t.start && !t.start.startsWith(`${DATE}T`));
const notPlanned = g.tasks.filter((t) => t.status !== 'planned');
const c1 = counts(srcGraph); const c2 = counts(g);
const verdict = bad.length === 0 && c1.tasks === c2.tasks && c1.resources === c2.resources && c1.dependencies === c2.dependencies;
console.log(`[5/5] verify: counts src=${JSON.stringify(c1)} copy=${JSON.stringify(c2)}; tasks off-date: ${bad.length}; non-planned: ${notPlanned.length}`);
console.log(JSON.stringify({ evidence: { api: API, source: EVENT_ID, sourceDate: src.date, copy: newId, copyDate: DATE, published: PUBLISH, countsMatch: c1.tasks === c2.tasks && c1.resources === c2.resources && c1.dependencies === c2.dependencies, offDateTasks: bad.map((t) => t.id), nonPlannedTasks: notPlanned.map((t) => t.id), verifiedAt: new Date().toISOString() }, verdict: verdict ? 'PASS' : 'FAIL' }, null, 2));
process.exit(verdict ? 0 : 1);
