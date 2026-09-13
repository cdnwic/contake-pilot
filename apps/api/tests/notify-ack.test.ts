/** PR-3 (contracts v1.6/v1.7, notifications spec v1.4/v1.5): shared FYI ack. */
import { beforeEach, describe, expect, it } from 'vitest';
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
const login = async (e: string, p: string) => (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: e, password: p } })).json().token as string;
const H = (t: string) => ({ authorization: `Bearer ${t}` });

const seedJob = async () => repo.createNotificationJob({
  id: 'j-ack-1', eventId: 'e1', kind: 'targeted', templateKey: 'task_moved',
  params: { taskName: 'x', newStart: 'y', summaryHe: 'z' },
  targets: [{ channel: 'in_app', address: 'u-admin', recipientLabel: 'דנה' }],
  idempotencyKey: 'ack-k1', createdAt: new Date().toISOString(),
} as never);

describe('PR-3 notify.ack (contracts v1.6/v1.7)', () => {
  it('admin ack sets acknowledgedBy/At and emits notify.acked to adminsRoom payload', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    await seedJob();
    const frames: AppEvent[] = [];
    const un = appEvents.subscribe(e => { if (e.type === 'notify.acked') frames.push(e); });
    const res = await app.inject({ method: 'POST', url: '/v1/notify-jobs/j-ack-1/ack', headers: H(admin) });
    un();
    expect(res.statusCode).toBe(200);
    const job = res.json().job;
    expect(job.acknowledgedBy).toBe('u-admin');
    expect(job.acknowledgedAt).toBeTruthy();
    expect((await repo.getNotificationJob('j-ack-1'))!.acknowledgedBy).toBe('u-admin');
    expect(frames.length).toBe(1);
    expect(frames[0]).toMatchObject({ type: 'notify.acked', eventId: 'e1', orgId: 'org-1', jobId: 'j-ack-1', acknowledgedBy: 'u-admin' });
    // contracts v1.8 / QA probe: ack writes exactly one audit row (entityType notification)
    const rows = (await repo.listAudit('org-1')).filter(r => r.action === 'notify.ack' && r.entityId === 'j-ack-1');
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ entityType: 'notification', actorUserId: 'u-admin' });
  });

  it('re-ack is idempotent: 200 with the EXISTING ack, never overwrites, no second frame', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    await seedJob();
    const first = await app.inject({ method: 'POST', url: '/v1/notify-jobs/j-ack-1/ack', headers: H(admin) });
    const firstJob = first.json().job;
    const frames: AppEvent[] = [];
    const un = appEvents.subscribe(e => { if (e.type === 'notify.acked') frames.push(e); });
    const second = await app.inject({ method: 'POST', url: '/v1/notify-jobs/j-ack-1/ack', headers: H(admin) });
    un();
    expect(second.statusCode).toBe(200);
    expect(second.json().job.acknowledgedBy).toBe(firstJob.acknowledgedBy);
    expect(second.json().job.acknowledgedAt).toBe(firstJob.acknowledgedAt);
    expect(frames.length).toBe(0);
    // QA probe: re-ack does NOT produce a second audit row
    expect((await repo.listAudit('org-1')).filter(r => r.action === 'notify.ack').length).toBe(1);
  });

  it('field_manager and focus_worker are denied (admin-only; matrix untouched)', async () => {
    await seedJob();
    const fm = await login('fm@camp.local', 'fm12345');
    const res = await app.inject({ method: 'POST', url: '/v1/notify-jobs/j-ack-1/ack', headers: H(fm) });
    expect(res.statusCode).toBe(403);
    expect((await repo.getNotificationJob('j-ack-1'))!.acknowledgedBy).toBeUndefined();
  });

  it('TL Sev-3: concurrent double-ack (same admin) -> exactly ONE audit row and ONE frame, both 200 with the same ack', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    await seedJob();
    const frames: AppEvent[] = [];
    const un = appEvents.subscribe(e => { if (e.type === 'notify.acked') frames.push(e); });
    const [r1, r2] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/notify-jobs/j-ack-1/ack', headers: H(admin) }),
      app.inject({ method: 'POST', url: '/v1/notify-jobs/j-ack-1/ack', headers: H(admin) }),
    ]);
    un();
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r1.json().job.acknowledgedBy).toBe('u-admin');
    expect(r2.json().job.acknowledgedBy).toBe('u-admin');
    expect(r1.json().job.acknowledgedAt).toBe(r2.json().job.acknowledgedAt);
    expect((await repo.listAudit('org-1')).filter(r => r.action === 'notify.ack').length).toBe(1);
    expect(frames.length).toBe(1);
  });

  it('unknown job -> 404', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const res = await app.inject({ method: 'POST', url: '/v1/notify-jobs/nope/ack', headers: H(admin) });
    expect(res.statusCode).toBe(404);
  });
});
