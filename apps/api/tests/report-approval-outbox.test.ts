/** POST /v1/reports delayed -> pending_review: durable same-transaction
 *  approval-job outbox (QA Alpha stop-ship 2026-09-17). Pre-fix the
 *  change_needs_approval job was written POST-COMMIT: a job-store failure
 *  left report+CR committed, and an exact replay deduped without restoring
 *  the job - the escalation was permanently lost. Post-fix the job commits
 *  atomically with report+CR+audit, so a fault rolls EVERYTHING back and an
 *  exact retry recreates exactly one of each. Runs in both harness lanes
 *  (REPO_IMPL=memory and =postgres via makeTestRepo). */
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
const fm = () => login('fm@camp.local', 'fm12345');
const TS = '2026-09-17T19:00:00+03:00';
// FM on own site (e2/site-1), delay on a scheduled task -> pending_review CR path.
const payload = (id: string) => ({ taskId: 'ta1', status: 'delayed', delayMin: 90, clientReportId: id, clientTimestamp: TS });
const create = (tok: string, p: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/v1/reports', headers: H(tok), payload: p });
const approvalJobs = (eventId: string) => repo.listNotificationJobs(eventId).then(js => js.filter(j => j.kind === 'change_needs_approval'));
const appliedAudits = (orgId: string) => repo.listAudit(orgId).then(rs => rs.filter(r => r.action === 'report.status.create' && r.outcome !== 'denied'));
const watch = () => {
  const frames: AppEvent[] = [];
  const un = appEvents.subscribe(e => { if (e.type === 'report.new' || e.type === 'change.pending') frames.push(e); });
  return { frames, un };
};

describe('QA Alpha: delayed-report approval job is durable (same-tx outbox)', () => {
  it('job-write fault -> 500 with ZERO report/CR/audit/job/frames; exact retry commits exactly one of each', async () => {
    const t = await fm();
    const { frames, un } = watch();
    const original = repo.createNotificationJob.bind(repo);
    repo.createNotificationJob = () => { throw new Error('job store down'); };

    const attempt1 = await create(t, payload('alpha-1'));
    repo.createNotificationJob = original;

    expect(attempt1.statusCode).toBe(500);
    expect(await repo.getReportByClientId('alpha-1')).toBeUndefined();
    expect((await repo.listReports('e2')).length).toBe(0);
    expect(await repo.listChangeRequests('e2')).toHaveLength(0);
    expect(await approvalJobs('e2')).toHaveLength(0);
    expect(await appliedAudits('org-1')).toHaveLength(0);
    expect(frames).toHaveLength(0); // no ghost report.new / change.pending

    const retry = await create(t, payload('alpha-1'));
    expect(retry.statusCode).toBe(200);
    const body = retry.json();
    expect(body.changeRequest?.state).toBe('pending_review');
    expect(body.deduped).toBeUndefined();
    expect((await repo.listReports('e2')).length).toBe(1);
    expect(await repo.listChangeRequests('e2')).toHaveLength(1);
    const jobs = await approvalJobs('e2');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.idempotencyKey).toBe(`e2+${body.changeRequest.id}+change_needs_approval`);
    expect((await appliedAudits('org-1')).length).toBe(2); // report + CR rows
    expect(frames.filter(f => f.type === 'report.new')).toHaveLength(1);
    expect(frames.filter(f => f.type === 'change.pending')).toHaveLength(1);
    un();
  });

  it('exact replay after a clean commit is effect-free and keeps exactly one approval job', async () => {
    const t = await fm();
    const { frames, un } = watch();
    const first = await create(t, payload('alpha-2'));
    expect(first.statusCode).toBe(200);

    const replay = await create(t, payload('alpha-2'));
    expect(replay.statusCode).toBe(200);
    expect(replay.json().deduped).toBe(true);
    expect(replay.json().report.id).toBe(first.json().report.id);

    expect((await repo.listReports('e2')).length).toBe(1);
    expect(await repo.listChangeRequests('e2')).toHaveLength(1);
    expect(await approvalJobs('e2')).toHaveLength(1);
    expect((await appliedAudits('org-1')).length).toBe(2);
    expect(frames.filter(f => f.type === 'report.new')).toHaveLength(1);
    expect(frames.filter(f => f.type === 'change.pending')).toHaveLength(1);
    un();
  });

  it('admin delayed -> pending_review also commits its approval job atomically', async () => {
    const t = await login('admin@camp.local', 'admin123');
    const r = await create(t, payload('alpha-3'));
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.changeRequest?.state).toBe('pending_review');
    expect(await repo.listChangeRequests('e2')).toHaveLength(1);
    const jobs = await approvalJobs('e2');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.idempotencyKey).toBe(`e2+${body.changeRequest.id}+change_needs_approval`);
  });
});
