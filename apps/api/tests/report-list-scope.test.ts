/** GET /v1/reports site-scope isolation (QA pre-adjudication 2026-09-17):
 *  event-level admission previously leaked other-site reports to site-scoped
 *  field managers in multi-site events; list visibility is now task/site
 *  scoped, matching mark-read. Probe matrix: two-site event e2 (site-1/site-2;
 *  u-fm scoped e2/site-1 only), admin both sites, FW 403, cross-org 404,
 *  mark-read deny/idempotency, blocked-report job cardinality, fault rollback.
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
let auth: AuthService;
beforeEach(async () => {
  repo = await makeTestRepo();
  auth = new AuthService(repo);
  app = buildApp(repo, auth);
  await app.ready();
});
afterEach(async () => { await app.close(); });

const H = (t: string) => ({ authorization: `Bearer ${t}` });
const login = async (e: string, p: string) => (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: e, password: p } })).json().token as string;
const admin = () => login('admin@camp.local', 'admin123');
const adminB = () => login('admin@film.local', 'admin123');
const fm = () => login('fm@camp.local', 'fm12345');
const otpLogin = async (phone: string): Promise<string> => {
  const req = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone } });
  const res = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code: req.json().devCode } });
  return res.json().token as string;
};
const T = '2026-09-14T09:00:0';
const seedReport = (id: string, taskId: string, status: 'blocked' | 'done', sec: number) =>
  repo.createReport({
    id, clientReportId: `cr-${id}`, taskId, reportedBy: 'u-w1', status,
    clientTimestamp: `${T}${sec}+03:00`, createdAt: `${T}${sec}+03:00`,
  });
const ids = (rs: { id: string }[]) => rs.map(r => r.id);
const list = async (tok: string, qs: string) =>
  (await app.inject({ method: 'GET', url: `/v1/reports${qs}`, headers: H(tok) }));

describe('GET /v1/reports site-scope isolation (two-site event e2)', () => {
  it('admin sees both sites; site-1 FM sees only site-1 across unfiltered/status/unread/cursor/eventId', async () => {
    await seedReport('rA1', 'ta1', 'blocked', 1);
    await seedReport('rA2', 'ta1', 'done', 2);
    await seedReport('rB', 'ta2', 'blocked', 3);
    const t = await admin();
    const f = await fm();

    // admin: both sites, unfiltered and per-eventId
    expect(ids((await list(t, '?eventId=e2')).json().reports)).toEqual(['rA1', 'rA2', 'rB']);
    expect(ids((await list(t, '')).json().reports)).toContain('rB');

    // FM (scope e2/site-1): every surface exposes site-1 only
    expect(ids((await list(f, '')).json().reports)).toEqual(['rA1', 'rA2']);
    expect(ids((await list(f, '?eventId=e2')).json().reports)).toEqual(['rA1', 'rA2']);
    expect(ids((await list(f, '?eventId=e2&status=blocked')).json().reports)).toEqual(['rA1']);
    expect(ids((await list(f, '?eventId=e2&status=done')).json().reports)).toEqual(['rA2']);
    expect(ids((await list(f, '?unread=true')).json().reports)).toEqual(['rA1', 'rA2']);

    // cursor pagination over the VISIBLE window only (rB never appears)
    const p1 = (await list(f, '?eventId=e2&limit=1')).json();
    expect(ids(p1.reports)).toEqual(['rA1']);
    expect(p1.nextCursor).toBeDefined();
    const p2 = (await list(f, `?eventId=e2&limit=1&cursor=${encodeURIComponent(p1.nextCursor)}`)).json();
    expect(ids(p2.reports)).toEqual(['rA2']);
    expect(p2.nextCursor).toBeUndefined();
  });

  it('focus_worker -> 403 matrix_deny + denied audit row', async () => {
    const w1 = await otpLogin('+972500000001');
    const res = await list(w1, '?eventId=e2');
    expect(res.statusCode).toBe(403);
    const denied = (await repo.listAudit('org-1')).filter(r => r.action === 'report.list' && r.outcome === 'denied');
    expect(denied.length).toBe(1);
    expect(denied[0].actorUserId).toBe('u-w1');
  });

  it('cross-org: eventId of another org -> 404; mark-read of another orgs report -> 404', async () => {
    await seedReport('rA1', 'ta1', 'blocked', 1);
    const b = await adminB();
    expect((await list(b, '?eventId=e2')).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/v1/reports/rA1/read', headers: H(b) })).statusCode).toBe(404);
  });

  it('mark-read: site-2 report denied with no writes; site-1 once/idempotent', async () => {
    await seedReport('rA1', 'ta1', 'blocked', 1);
    await seedReport('rB', 'ta2', 'blocked', 3);
    const f = await fm();

    const deniedRes = await app.inject({ method: 'POST', url: '/v1/reports/rB/read', headers: H(f) });
    expect(deniedRes.statusCode).toBe(403);
    expect(await repo.getReportReadState('rB', 'u-fm')).toBeUndefined();
    const deniedRows = (await repo.listAudit('org-1')).filter(r => r.action === 'report.mark_read');
    expect(deniedRows.length).toBe(1);
    expect(deniedRows[0].outcome).toBe('denied');

    const ok = (await app.inject({ method: 'POST', url: '/v1/reports/rA1/read', headers: H(f) })).json().readState;
    expect(ok.reportId).toBe('rA1');
    const again = (await app.inject({ method: 'POST', url: '/v1/reports/rA1/read', headers: H(f) })).json().readState;
    expect(again).toEqual(ok);
    const applied = (await repo.listAudit('org-1')).filter(r => r.action === 'report.mark_read' && r.outcome !== 'denied');
    expect(applied.length).toBe(1);
  });

  it('blocked report -> exactly one same-org active-admin in_app job; duplicate create no second job', async () => {
    const f = await fm();
    const payload = { taskId: 'ta1', clientReportId: 'cr-live-1', status: 'blocked', clientTimestamp: `${T}1+03:00`, noteHe: 'אין ציוד' };
    const res = await app.inject({ method: 'POST', url: '/v1/reports', headers: H(f), payload });
    expect(res.statusCode).toBe(200);
    const rep = res.json().report;

    const jobs = (await repo.listNotificationJobs('e2')).filter(j => j.kind === 'report_blocked');
    expect(jobs.length).toBe(1);
    expect(jobs[0].idempotencyKey).toBe(`report_blocked:${rep.id}`);
    expect(jobs[0].targets.map((x: { address: string }) => x.address)).toEqual(['u-admin']);
    expect(jobs[0].targets.every((x: { channel: string }) => x.channel === 'in_app')).toBe(true);

    const dup = await app.inject({ method: 'POST', url: '/v1/reports', headers: H(f), payload });
    expect(dup.statusCode).toBe(200);
    expect(dup.json().deduped).toBe(true);
    expect((await repo.listNotificationJobs('e2')).filter(j => j.kind === 'report_blocked').length).toBe(1);
  });

  it('audit fault during blocked create -> 500 with report+audit+job+frame all rolled back', async () => {
    const f = await fm();
    const frames: AppEvent[] = [];
    const un = appEvents.subscribe(e => { if (e.type === 'report.new') frames.push(e); });
    const original = repo.appendAudit.bind(repo);
    repo.appendAudit = () => { throw new Error('audit store down'); };
    const res = await app.inject({ method: 'POST', url: '/v1/reports', headers: H(f),
      payload: { taskId: 'ta1', clientReportId: 'cr-fault-1', status: 'blocked', clientTimestamp: `${T}2+03:00` } });
    repo.appendAudit = original;

    expect(res.statusCode).toBe(500);
    expect(await repo.getReportByClientId('cr-fault-1')).toBeUndefined();
    expect((await repo.listReports('e2')).length).toBe(0);
    expect((await repo.listNotificationJobs('e2')).filter(j => j.kind === 'report_blocked').length).toBe(0);
    expect(frames.length).toBe(0);
    expect((await repo.listAudit('org-1')).filter(r => r.action === 'report.status.create').length).toBe(0);
    un();
  });
});
