/** POST /v1/reports authorization + tenant/actor-safe idempotency (QA QM3
 *  2026-09-17): task resolution + same-org + per-role scope run BEFORE any
 *  replay; FM taskInScope and FW own-assignment for ALL statuses; exact
 *  same-actor replay is effect-free, any other clientReportId collision is a
 *  409 with a conflict audit in the attempting org and no cross-tenant leak.
 *  Runs in both harness lanes (REPO_IMPL=memory and =postgres via makeTestRepo). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo } from './helpers/repo.js';
import { appEvents, type AppEvent } from '../src/services/events.js';

let repo: GraphRepository;
let app: FastifyInstance;
beforeEach(async () => {
  repo = await makeTestRepo();
  app = buildApp(repo, new AuthService(repo));
  await app.ready();
});
afterEach(async () => { await app.close(); });

const H = (t: string) => ({ authorization: `Bearer ${t}` });
const login = async (e: string, p: string) => (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: e, password: p } })).json().token as string;
const admin = () => login('admin@camp.local', 'admin123');
const adminB = () => login('admin@film.local', 'admin123');
const fm = () => login('fm@camp.local', 'fm12345');
const otp = async (phone: string) => {
  const q = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone } });
  return (await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code: q.json().devCode } })).json().token as string;
};
const TS = '2026-09-17T19:00:00+03:00';
const create = (tok: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/v1/reports', headers: H(tok), payload });
const blocked = (taskId: string, id: string, extra: Record<string, unknown> = {}) =>
  ({ taskId, status: 'blocked', clientReportId: id, clientTimestamp: TS, ...extra });
const watchFrames = () => {
  const frames: AppEvent[] = [];
  const un = appEvents.subscribe(e => { if (e.type === 'report.new') frames.push(e); });
  return { frames, un };
};
const deniedRows = (orgId: string) => repo.listAudit(orgId).then(rs => rs.filter(r => r.action === 'report.status.create' && r.outcome === 'denied'));
const conflictRows = (orgId: string) => repo.listAudit(orgId).then(rs => rs.filter(r => r.action === 'report.status.create' && r.afterJson?.includes('client_report_id_taken')));
const blockedJobs = (eventId: string) => repo.listNotificationJobs(eventId).then(js => js.filter(j => j.kind === 'report_blocked'));

describe('POST /v1/reports create-side authorization (all statuses)', () => {
  it('site-1 FM: site-2 task denied for blocked AND done; site-1 allowed; zero writes on denial', async () => {
    const t = await fm();
    for (const status of ['blocked', 'done'] as const) {
      const { frames, un } = watchFrames();
      const r = await create(t, { taskId: 'ta2', status, clientReportId: `fm-outsite-${status}`, clientTimestamp: TS });
      expect(r.statusCode).toBe(403);
      expect(await repo.getReportByClientId(`fm-outsite-${status}`)).toBeUndefined();
      expect(frames).toHaveLength(0);
      un();
    }
    expect(await blockedJobs('e2')).toHaveLength(0);
    const denied = await deniedRows('org-1');
    expect(denied).toHaveLength(2);
    expect(denied.every(r => r.entityId === 'ta2')).toBe(true);
    // in-scope site-1 task still works
    const ok = await create(t, blocked('ta1', 'fm-insite'));
    expect(ok.statusCode).toBe(200);
  });

  it('FW: another workers task denied for blocked AND done; own assignment allowed', async () => {
    const w1 = await otp('+972500000001'); // linked r-g1; t4 assigned to r-g2/r-grp/r-pool
    for (const status of ['blocked', 'done'] as const) {
      const { frames, un } = watchFrames();
      const r = await create(w1, { taskId: 't4', status, clientReportId: `fw-notown-${status}`, clientTimestamp: TS });
      expect(r.statusCode).toBe(403);
      expect(await repo.getReportByClientId(`fw-notown-${status}`)).toBeUndefined();
      expect(frames).toHaveLength(0);
      un();
    }
    expect(await blockedJobs('e1')).toHaveLength(0);
    expect((await deniedRows('org-1')).length).toBe(2);
    const ok = await create(w1, blocked('t1', 'fw-own'));
    expect(ok.statusCode).toBe(200);
    const ok2 = await create(w1, { taskId: 't1', status: 'done', clientReportId: 'fw-own-done', clientTimestamp: TS });
    expect(ok2.statusCode).toBe(200);
  });

  it('admin: same-org task allowed incl. site-2; unknown task 404; cross-org task id 404', async () => {
    const t = await admin();
    expect((await create(t, blocked('ta2', 'admin-site2'))).statusCode).toBe(200);
    expect((await create(t, blocked('nope', 'admin-nope'))).statusCode).toBe(404);
    expect((await create(t, blocked('tf1', 'admin-crossorg'))).statusCode).toBe(404);
    expect(await repo.getReportByClientId('admin-crossorg')).toBeUndefined();
  });
});

describe('POST /v1/reports tenant/actor-safe idempotency', () => {
  it('exact same-actor replay: 200 deduped, zero new report/audit/job/frame', async () => {
    const t = await fm();
    const first = await create(t, blocked('ta1', 'replay-1', { noteHe: 'הערה' }));
    expect(first.statusCode).toBe(200);
    const rep = first.json().report;
    const auditsBefore = (await repo.listAudit('org-1')).filter(r => r.action === 'report.status.create').length;
    const { frames, un } = watchFrames();
    const replay = await create(t, blocked('ta1', 'replay-1', { noteHe: 'הערה' }));
    expect(replay.statusCode).toBe(200);
    expect(replay.json().deduped).toBe(true);
    expect(replay.json().report.id).toBe(rep.id);
    expect((await repo.listReports('e2')).length).toBe(1);
    expect((await repo.listAudit('org-1')).filter(r => r.action === 'report.status.create').length).toBe(auditsBefore);
    expect(await blockedJobs('e2')).toHaveLength(1);
    expect(frames).toHaveLength(0);
    un();
  });

  it('same actor, changed task or payload -> 409 + conflict audit, no overwrite', async () => {
    const t = await fm();
    await create(t, blocked('ta1', 'mut-1', { noteHe: 'מקורי' }));
    const changedPayload = await create(t, blocked('ta1', 'mut-1', { noteHe: 'שונה' }));
    expect(changedPayload.statusCode).toBe(409);
    const changedTask = await create(t, blocked('ta2', 'mut-2b'));
    expect(changedTask.statusCode).toBe(403); // site-2: scope denial precedes any dedupe
    await create(t, blocked('ta1', 'mut-2'));
    const changedTaskInScope = await create(t, { taskId: 'ta1', status: 'done', clientReportId: 'mut-2', clientTimestamp: TS });
    expect(changedTaskInScope.statusCode).toBe(409);
    const stored = await repo.getReportByClientId('mut-1');
    expect(stored!.noteHe).toBe('מקורי');
    expect((await repo.listReports('e2')).length).toBe(2);
    expect((await conflictRows('org-1')).length).toBe(2);
  });

  it('same-org different actor reusing clientReportId -> 409, stored note not leaked', async () => {
    const w1 = await otp('+972500000001');
    await create(w1, blocked('t1', 'shared-in-org', { noteHe: 'סוד של א' }));
    const t = await admin();
    const r = await create(t, blocked('t1', 'shared-in-org'));
    expect(r.statusCode).toBe(409);
    expect(JSON.stringify(r.json())).not.toContain('סוד של א');
    expect((await conflictRows('org-1')).length).toBe(1);
  });

  it('cross-org clientReportId collision -> 409, no cross-tenant content leak', async () => {
    await repo.createReport({
      id: 'secret-report', clientReportId: 'shared-client-id', taskId: 'ta1', reportedBy: 'u-w1',
      status: 'blocked', noteHe: 'tenant A secret', clientTimestamp: TS, createdAt: TS,
    });
    const b = await adminB();
    const r = await create(b, { taskId: 'tf1', status: 'done', clientReportId: 'shared-client-id', clientTimestamp: TS });
    expect(r.statusCode).not.toBe(200);
    expect(r.statusCode).toBe(409);
    expect(JSON.stringify(r.json())).not.toContain('tenant A secret');
    // no report created in org-2, no applied writes
    expect((await repo.listReports('f1')).length).toBe(0);
    expect((await conflictRows('org-2')).length).toBe(1);
  });

  it('concurrent duplicate create: exactly one report, one job, losers resolve to replay', async () => {
    const t = await fm();
    const results = await Promise.all(Array.from({ length: 4 }, () => create(t, blocked('ta1', 'race-1'))));
    expect(results.every(r => r.statusCode === 200)).toBe(true);
    expect((await repo.listReports('e2')).length).toBe(1);
    expect(await blockedJobs('e2')).toHaveLength(1);
    expect(results.filter(r => r.json().deduped).length).toBe(3);
  });
});
