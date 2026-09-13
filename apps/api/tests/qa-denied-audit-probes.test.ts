/** QA v1.9 denied-audit ADVERSARIAL probes (QA-owned; team tests are not the evidence). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo } from './helpers/repo.js';

let repo: GraphRepository; let app: FastifyInstance;
beforeEach(async () => { repo = await makeTestRepo(); app = buildApp(repo, new AuthService(repo)); await app.ready(); });
afterEach(async () => { await app.close(); });

const login = async (e: string, p: string) =>
  (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: e, password: p } })).json().token as string;
const H = (t: string) => ({ authorization: `Bearer ${t}` });
const deniedRows = async () => (await repo.listAudit('org-1')).filter(r => r.outcome === 'denied');
const allRows = async () => repo.listAudit('org-1');

describe('QA-DA denied-audit probes', () => {
  it('QA-DA-1: matrix deny on mutating endpoint (FM event.delete) -> 403 + exactly 1 denied row, correct shape', async () => {
    const t = await login('fm@camp.local', 'fm12345');
    const before = (await allRows()).length;
    const res = await app.inject({ method: 'DELETE', url: '/v1/events/e1', headers: H(t) });
    expect(res.statusCode).toBe(403);
    const rows = await deniedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: 'u-fm', outcome: 'denied', denialReason: 'matrix_deny', beforeJson: null, afterJson: null });
    expect((await allRows()).length).toBe(before + 1);
  });

  it('QA-DA-2: 401 (no token) on the same endpoint -> NO audit row of any kind', async () => {
    const before = (await allRows()).length;
    const res = await app.inject({ method: 'DELETE', url: '/v1/events/e1' });
    expect(res.statusCode).toBe(401);
    expect((await allRows()).length).toBe(before);
  });

  it('QA-DA-3: domino.compute dry-run by a role denied the underlying action -> NO denied row (excluded)', async () => {
    const t = await login('fm@camp.local', 'fm12345');
    const before = (await allRows()).length;
    // compute is a dry-run; even a denied/forbidden use must not append v1.9 rows
    await app.inject({ method: 'POST', url: '/v1/domino/compute', headers: H(t), payload: { eventId: 'e1', change: { type: 'task.move', taskId: 'x', newStart: '2026-09-14T10:00:00+03:00' } } });
    expect((await allRows()).length).toBe(before);
  });

  it('QA-DA-4: denied rows never leak to another org listing (org-2 sees nothing)', async () => {
    const t = await login('fm@camp.local', 'fm12345');
    await app.inject({ method: 'DELETE', url: '/v1/events/e1', headers: H(t) });
    expect(await repo.listAudit('org-2')).toHaveLength(0);
  });

  it('QA-DA-5: appendAudit failure at a deny site -> 403 STILL stands (denial never upgraded), server survives', async () => {
    const t = await login('fm@camp.local', 'fm12345');
    const orig = repo.appendAudit.bind(repo);
    repo.appendAudit = async () => { throw new Error('audit store down'); };
    const res = await app.inject({ method: 'DELETE', url: '/v1/events/e1', headers: H(t) });
    expect(res.statusCode).toBe(403); // NOT 500
    repo.appendAudit = orig;
    const res2 = await app.inject({ method: 'DELETE', url: '/v1/events/e1', headers: H(t) });
    expect(res2.statusCode).toBe(403);
    expect(await deniedRows()).toHaveLength(1); // recovered append works again
  });

  it('QA-DA-6: non-admin notify.ack -> 403 + denied row with action notify.ack', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const fm = await login('fm@camp.local', 'fm12345');
    const job = await repo.createNotificationJob({ id: `njob_da6_${Date.now()}`, orgId: 'org-1', eventId: 'e1', address: '+972500000001', body: 'x', kind: 'notify.failed', status: 'failed', idempotencyKey: `k-da6-${Date.now()}`, createdAt: new Date().toISOString() } as never);
    const res = await app.inject({ method: 'POST', url: `/v1/notify-jobs/${job.id}/ack`, headers: H(fm) });
    expect(res.statusCode).toBe(403);
    const rows = await deniedRows();
    expect(rows.some(r => r.action === 'notify.ack' && r.actorUserId === 'u-fm')).toBe(true);
    expect((await repo.getNotificationJob(job.id))!.acknowledgedBy).toBeUndefined();
    void admin;
  });

  it('QA-DA-7: repeated denials append one row EACH (no dedupe - the trail is complete)', async () => {
    const t = await login('fm@camp.local', 'fm12345');
    await app.inject({ method: 'DELETE', url: '/v1/events/e1', headers: H(t) });
    await app.inject({ method: 'DELETE', url: '/v1/events/e1', headers: H(t) });
    await app.inject({ method: 'DELETE', url: '/v1/events/e1', headers: H(t) });
    expect(await deniedRows()).toHaveLength(3);
  });
});
