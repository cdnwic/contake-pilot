/** contracts v1.9 (G4 planning): denied-attempt auditing — every MUTATING endpoint
 *  attempt that passes auth but fails authz (matrix deny or scope violation)
 *  appends a standalone outcome:'denied' row (null before/afterJson). Excluded:
 *  reads, domino.compute dry-run, 401s. A broken audit store never upgrades a
 *  denial: the append failure is logged server-side and the 403 stands. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AuditLogEntry } from '@contake/core';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo } from './helpers/repo.js';

let repo: GraphRepository;
let app: FastifyInstance;
beforeEach(async () => {
  repo = await makeTestRepo();
  app = buildApp(repo, new AuthService(repo));
  await app.ready();
});
afterEach(() => { vi.restoreAllMocks(); });

const login = async (e: string, p: string) => (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: e, password: p } })).json().token as string;
const otpLogin = async (phone: string): Promise<string> => {
  const req = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone } });
  const res = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code: req.json().devCode } });
  return res.json().token as string;
};
const H = (t: string) => ({ authorization: `Bearer ${t}` });
const deniedRows = async (): Promise<AuditLogEntry[]> =>
  (await repo.listAudit('org-1')).filter(r => r.outcome === 'denied');

describe('contracts v1.9 denied-attempt auditing', () => {
  it('matrix deny on a proposeMutation flow (FW task.move) appends one denied row', async () => {
    const w1 = await otpLogin('+972500000001');
    const res = await app.inject({
      method: 'PATCH', url: '/v1/tasks/t1', headers: H(w1),
      payload: { version: 1, move: { newStart: '2026-09-14T08:00:00+03:00' } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    const rows = await deniedRows();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      orgId: 'org-1', eventId: 'e1', actorUserId: 'u-w1', role: 'focus_worker',
      action: 'task.move', entityType: 'task', entityId: 't1',
      outcome: 'denied', denialReason: 'matrix_deny',
      beforeJson: null, afterJson: null,
    });
    // graph untouched
    expect((await repo.getTask('t1'))!.start).toContain('07:30');
  });

  it('matrix deny on event.create (FW) records the pending sentinel for the undeterminable event', async () => {
    const w1 = await otpLogin('+972500000001');
    const res = await app.inject({
      method: 'POST', url: '/v1/events', headers: H(w1),
      payload: { name: 'x', date: '2026-09-14', timezone: 'Asia/Jerusalem', domainProfileId: 'camp', siteIds: ['site-1'] },
    });
    expect(res.statusCode).toBe(403);
    const rows = await deniedRows();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      action: 'event.create', entityType: 'event', entityId: 'pending', eventId: 'pending',
      outcome: 'denied', denialReason: 'matrix_deny', beforeJson: null, afterJson: null,
    });
  });

  it('matrix deny on event.delete (FM) carries the target event id', async () => {
    const fm = await login('fm@camp.local', 'fm12345');
    const res = await app.inject({ method: 'DELETE', url: '/v1/events/e1', headers: H(fm) });
    expect(res.statusCode).toBe(403);
    const rows = await deniedRows();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      action: 'event.delete', entityType: 'event', entityId: 'e1', eventId: 'e1',
      actorUserId: 'u-fm', outcome: 'denied', denialReason: 'matrix_deny',
    });
    expect(await repo.getEvent('e1')).toBeTruthy();
  });

  it('matrix deny on change.approve (FW) targets the change request', async () => {
    const w1 = await otpLogin('+972500000001');
    const res = await app.inject({ method: 'POST', url: '/v1/changes/cr-zzz/approve', headers: H(w1) });
    expect(res.statusCode).toBe(403);
    const rows = await deniedRows();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      action: 'change.approve', entityType: 'change_request', entityId: 'cr-zzz', eventId: 'pending',
      outcome: 'denied', denialReason: 'matrix_deny',
    });
  });

  it('scope violation on a delay report (FW on another worker\'s task) appends a denied row and persists NO report', async () => {
    const w2 = await otpLogin('+972500000002'); // r-g2: not an assignee of t1
    const res = await app.inject({
      method: 'POST', url: '/v1/reports', headers: H(w2),
      payload: { taskId: 't1', status: 'delayed', delayMin: 30, clientReportId: 'den-cr-1', clientTimestamp: '2026-09-14T07:40:00+03:00' },
    });
    expect(res.statusCode).toBe(403);
    const rows = await deniedRows();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      action: 'report.status.create', entityType: 'task', entityId: 't1', eventId: 'e1',
      actorUserId: 'u-w2', outcome: 'denied', denialReason: 'scope_violation',
      beforeJson: null, afterJson: null,
    });
    // the report itself was never persisted, and no applied audit row exists
    expect(await repo.getReportByClientId('den-cr-1')).toBeUndefined();
    const applied = (await repo.listAudit('org-1')).filter(r => r.action === 'report.status.create' && r.outcome !== 'denied');
    expect(applied.length).toBe(0);
  });

  it('admin-only notify.ack (FM) appends a denied row targeting the job', async () => {
    const fm = await login('fm@camp.local', 'fm12345');
    const res = await app.inject({ method: 'POST', url: '/v1/notify-jobs/j-404/ack', headers: H(fm) });
    expect(res.statusCode).toBe(403);
    const rows = await deniedRows();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      action: 'notify.ack', entityType: 'notification', entityId: 'j-404', eventId: 'pending',
      outcome: 'denied', denialReason: 'matrix_deny',
    });
  });

  it('exclusions: read 403s, the domino.compute dry-run deny and 401s append NOTHING', async () => {
    const w1 = await otpLogin('+972500000001');
    const read = await app.inject({ method: 'GET', url: '/v1/audit?eventId=e1', headers: H(w1) });
    expect(read.statusCode).toBe(403);
    const dry = await app.inject({
      method: 'POST', url: '/v1/domino/compute', headers: H(w1),
      payload: { eventId: 'e1', change: { type: 'task.move', taskId: 't1', newStart: '2026-09-14T08:00:00+03:00' } },
    });
    expect(dry.statusCode).toBe(403);
    const unauth = await app.inject({
      method: 'PATCH', url: '/v1/tasks/t1',
      payload: { version: 1, move: { newStart: '2026-09-14T08:00:00+03:00' } },
    });
    expect(unauth.statusCode).toBe(401);
    expect((await deniedRows()).length).toBe(0);
  });

  it('standalone failure: a broken audit store never upgrades the denial (403 stands, failure logged)', async () => {
    const w1 = await otpLogin('+972500000001');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const orig = repo.appendAudit.bind(repo);
    vi.spyOn(repo, 'appendAudit').mockImplementation(async (rec: AuditLogEntry) => {
      if (rec.outcome === 'denied') throw new Error('audit store down');
      return orig(rec);
    });
    const res = await app.inject({
      method: 'PATCH', url: '/v1/tasks/t1', headers: H(w1),
      payload: { version: 1, move: { newStart: '2026-09-14T08:00:00+03:00' } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(errSpy).toHaveBeenCalled();
    expect(errSpy.mock.calls.some(c => String(c[0]).includes('denied-attempt append failed'))).toBe(true);
    expect((await deniedRows()).length).toBe(0);
  });

  it('success-path audits stay tx-atomic and carry no outcome marker (QA-M2-6 untouched)', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const res = await app.inject({
      method: 'PATCH', url: '/v1/tasks/t7', headers: H(admin),
      payload: { version: 1, move: { newStart: '2026-09-14T13:00:00+03:00' } },
    });
    expect(res.statusCode).toBe(200);
    const rows = (await repo.listAudit('org-1')).filter(r => r.action === 'task.move');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.outcome ?? 'applied').toBe('applied');
    expect((await deniedRows()).length).toBe(0);
  });
});
