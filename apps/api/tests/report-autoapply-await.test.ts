/** POST /v1/reports delayed AUTO-APPLY path: applyDomino must be awaited
 *  (QA Alpha-2 stop-ship 2026-09-17). Pre-fix the async applyDomino was
 *  called without await: withAuditSafety committed and responded before the
 *  domino writes finished - a mid-domino fault detached from the rollback
 *  (post-response writes + unhandled rejection under a 200). Post-fix the
 *  whole unit (report + task updates + version bump + audits) is atomic.
 *  Runs in both harness lanes (REPO_IMPL=memory and =postgres). */
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
// focus worker u-w1 (linked r-g1); t7 is own, unlocked, isolated -> S0 auto-apply
const w1 = async () => {
  const q = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: '+972500000001' } });
  return (await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: '+972500000001', code: q.json().devCode } })).json().token as string;
};
const TS = '2026-09-17T19:00:00+03:00';
const payload = (id: string) => ({ taskId: 't7', status: 'delayed', delayMin: 30, clientReportId: id, clientTimestamp: TS });
const create = (tok: string, p: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/v1/reports', headers: H(tok), payload: p });
const t7start = () => repo.getTask('t7').then(t => t!.start);
const appliedAudits = (action: string) => repo.listAudit('org-1').then(rs => rs.filter(r => r.action === action && r.outcome !== 'denied'));
const watch = () => {
  const frames: AppEvent[] = [];
  const un = appEvents.subscribe(e => { if (e.type === 'report.new' || e.type === 'change.pending') frames.push(e); });
  return { frames, un };
};

describe('QA Alpha-2: delayed auto-apply awaits applyDomino (atomic report+domino+audits)', () => {
  it('green auto-apply: 200 applied, task moved, report + audits committed', async () => {
    const t = await w1();
    const before = await t7start();
    const r = await create(t, payload('aa-1'));
    expect(r.statusCode).toBe(200);
    expect(r.json().applied?.domino?.ok).toBe(true);
    expect(await t7start()).not.toBe(before);
    expect(await repo.getReportByClientId('aa-1')).toBeDefined();
    expect(await appliedAudits('report.status.create')).toHaveLength(1); // the report row
    expect((await appliedAudits('task.move')).length).toBeGreaterThanOrEqual(1); // the domino audit row(s)
  });

  it('mid-domino fault (version bump) -> 500, ZERO report/task-move/audit/frames, no unhandled rejection; exact retry green', async () => {
    const t = await w1();
    const before = await t7start();
    const { frames, un } = watch();
    const rejections: unknown[] = [];
    const onRej = (e: unknown) => { rejections.push(e); };
    process.on('unhandledRejection', onRej);
    const original = repo.bumpEventVersion.bind(repo);
    repo.bumpEventVersion = () => { throw new Error('version store down'); };

    const attempt1 = await create(t, payload('aa-2'));
    repo.bumpEventVersion = original;
    await new Promise(r => setTimeout(r, 100)); // let any detached post-response rejection land

    expect(attempt1.statusCode).toBe(500);
    expect(rejections).toHaveLength(0);
    expect(await repo.getReportByClientId('aa-2')).toBeUndefined();
    expect(await t7start()).toBe(before); // task update rolled back too
    expect(await appliedAudits('report.status.create')).toHaveLength(0);
    expect(await appliedAudits('task.move')).toHaveLength(0);
    expect(frames).toHaveLength(0);

    const retry = await create(t, payload('aa-2'));
    process.removeListener('unhandledRejection', onRej);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().applied?.domino?.ok).toBe(true);
    expect((await repo.listReports('e1')).filter(x => x.clientReportId === 'aa-2')).toHaveLength(1);
    expect(await t7start()).not.toBe(before);
    expect(frames.filter(f => f.type === 'report.new')).toHaveLength(1);
    un();
  });

  it('exact replay after clean auto-apply is effect-free (no second move)', async () => {
    const t = await w1();
    const first = await create(t, payload('aa-3'));
    expect(first.statusCode).toBe(200);
    const moved = await t7start();
    const replay = await create(t, payload('aa-3'));
    expect(replay.statusCode).toBe(200);
    expect(replay.json().deduped).toBe(true);
    expect(await t7start()).toBe(moved); // not moved twice
    expect((await repo.listReports('e1')).filter(x => x.clientReportId === 'aa-3')).toHaveLength(1);
  });
});
