import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo } from './helpers/repo.js';
import { appEvents, type AppEvent } from '../src/services/events.js';

let app: FastifyInstance;
let repo: GraphRepository;

beforeEach(async () => {
  repo = await makeTestRepo();
  app = buildApp(repo, new AuthService(repo));
  await app.ready();
});

const H = (token: string) => ({ authorization: `Bearer ${token}` });
const otpLogin = async (phone: string): Promise<string> => {
  const req = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone } });
  const res = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code: req.json().devCode } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
};

const report = (token: string, clientReportId: string, status = 'done', extra: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST', url: '/v1/reports', headers: H(token),
    payload: { taskId: 't7', status, clientReportId, clientTimestamp: '2026-09-14T14:30:00+03:00', ...extra },
  });

describe('M3-QA-2 edge probes: Focus offline queue (server side)', () => {
  it('duplicate clientReportId with DIVERGENT content is a 409 conflict (QA QM3 2026-09-17), first write untouched', async () => {
    const w1 = await otpLogin('+972500000001');
    const first = await report(w1, 'cr-1', 'done');
    expect(first.statusCode).toBe(200);
    const dup = await report(w1, 'cr-1', 'delayed', { delayMin: 45, noteHe: 'תוכן שונה לגמרי' });
    // QA QM3 supersedes the M3-QA-2 dedup-on-divergence semantic: a changed
    // payload under the same clientReportId is a conflict, never a silent dup.
    expect(dup.statusCode).toBe(409);
    const stored = (await repo.listReports('e1')).filter(r => r.clientReportId === 'cr-1');
    expect(stored.length).toBe(1);
    expect(stored[0]!.status).toBe('done'); // first write wins; divergent retry has zero effect
    expect(stored[0]!.clientTimestamp).toBe('2026-09-14T14:30:00+03:00');
    const conflict = (await repo.listAudit('org-1')).filter(r => r.action === 'report.status.create' && r.afterJson?.includes('client_report_id_taken'));
    expect(conflict.length).toBe(1);
  });

  it('expired/invalid token -> 401; after OTP re-auth the queued report syncs exactly once', async () => {
    const bad = await report('deadbeef.invalid.token', 'cr-2');
    expect(bad.statusCode).toBe(401);
    expect((await repo.listReports('e1')).filter(r => r.clientReportId === 'cr-2').length).toBe(0);
    const w1 = await otpLogin('+972500000001');
    const ok = await report(w1, 'cr-2');
    expect(ok.statusCode).toBe(200);
    const replay = await report(w1, 'cr-2'); // client retries the same queued item
    expect(replay.json().deduped).toBe(true);
    expect((await repo.listReports('e1')).filter(r => r.clientReportId === 'cr-2').length).toBe(1);
  });
});

describe('TL pinned semantic: report-originated escalated CR mirrors proposeMutation', () => {
  it('delayed report with S1+ impact emits admin change.pending AND records change_needs_approval job', async () => {
    const events: AppEvent[] = [];
    const unsub = appEvents.subscribe(e => { if (e.type === 'change.pending') events.push(e); });
    const w1 = await otpLogin('+972500000001'); // linked to r-g1, assignee of t1
    const res = await app.inject({
      method: 'POST', url: '/v1/reports', headers: H(w1),
      payload: { taskId: 't1', status: 'delayed', delayMin: 30, clientReportId: 'cr-esc-1', clientTimestamp: '2026-09-14T08:00:00+03:00' },
    });
    expect(res.statusCode).toBe(200);
    const cr = res.json().changeRequest;
    expect(cr).toBeDefined();
    expect(cr.state).toBe('pending_review');
    // realtime: admins see the pending change
    expect(events.length).toBe(1);
    expect(events[0]!.type === 'change.pending' && events[0]!.changeRequest.id).toBe(cr.id);
    // admin-only approval-needed job recorded (same shape as proposeMutation's)
    const jobs = (await repo.listNotificationJobsAll()).filter(j => j.kind === 'change_needs_approval' && j.idempotencyKey.includes(cr.id));
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.targets.map(t => t.address)).toEqual(['u-admin']);
    unsub();
  });

  it('field_manager event.create -> pending CR + change.pending frame + admin approval job (eventId pending)', async () => {
    const events: AppEvent[] = [];
    const unsub = appEvents.subscribe(e => { if (e.type === 'change.pending') events.push(e); });
    const fm = await (async () => {
      const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'fm@camp.local', password: 'fm12345' } });
      return res.json().token as string;
    })();
    const res = await app.inject({
      method: 'POST', url: '/v1/events', headers: H(fm),
      payload: { name: 'טיול שנתי', date: '2026-10-01', timezone: 'Asia/Jerusalem', domainProfileId: 'camp', siteIds: ['s9'] },
    });
    expect(res.statusCode).toBe(200);
    const cr = res.json().changeRequest;
    expect(cr).toBeDefined();
    expect(cr.state).toBe('pending_review');
    expect(events.length).toBe(1);
    const jobs = (await repo.listNotificationJobsAll()).filter(j => j.kind === 'change_needs_approval' && j.idempotencyKey.includes(cr.id));
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.eventId).toBe('pending');
    expect(jobs[0]!.targets.map(t => t.address)).toEqual(['u-admin']);
    unsub();
  });
});
