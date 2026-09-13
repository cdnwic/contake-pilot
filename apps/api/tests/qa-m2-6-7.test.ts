import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo } from './helpers/repo.js';

let app: FastifyInstance;
let repo: GraphRepository;

const move = (hhmm: string): string => `2026-09-14T${hhmm}:00+03:00`;

beforeEach(async () => {
  repo = await makeTestRepo();
  app = buildApp(repo, new AuthService(repo));
  await app.ready();
});

const login = async (email: string, password: string): Promise<string> => {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
};
const H = (token: string) => ({ authorization: `Bearer ${token}` });

describe('QA-M2-6: audit-write failure aborts the whole mutation (atomic rollback)', () => {
  it('appendAudit fault -> 500 and the graph is unchanged (no half-applied mutation)', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const before = (await repo.snapshot('e2'))!;
    const taskBefore = (await repo.getTask('ta1'))!;
    const versionBefore = before.event.version;

    const original = repo.appendAudit.bind(repo);
    repo.appendAudit = () => { throw new Error('audit store down'); };
    const res = await app.inject({
      method: 'PATCH', url: '/v1/tasks/ta1', headers: H(admin),
      payload: { version: 1, move: { newStart: move('08:00') } },
    });
    repo.appendAudit = original;

    expect(res.statusCode).toBe(500);
    // loud failure, zero side effects: task, event version, and graph untouched
    expect(await repo.getTask('ta1')).toEqual(taskBefore);
    expect((await repo.snapshot('e2'))!.event.version).toBe(versionBefore);
    expect((await repo.listChangeRequests('e2')).length).toBe(0);
  });

  it('after the fault clears, the same mutation succeeds normally', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const res = await app.inject({
      method: 'PATCH', url: '/v1/tasks/ta1', headers: H(admin),
      payload: { version: 1, move: { newStart: move('08:00') } },
    });
    expect(res.statusCode).toBe(200);
    expect((await repo.getTask('ta1'))!.start).toBe(move('08:00'));
  });
});

describe('QA-M2-7: every endpoint performs its action for real or errors', () => {
  it('DELETE /v1/events/:id actually removes the event (and cascades), with audit', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const res = await app.inject({ method: 'DELETE', url: '/v1/events/e2', headers: H(admin) });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied.deleted).toBe('e2');
    // measurable state change: the graph endpoint now 404s, tasks/CRs are gone
    expect((await app.inject({ method: 'GET', url: '/v1/events/e2/graph', headers: H(admin) })).statusCode).toBe(404);
    expect(await repo.getTask('ta1')).toBeUndefined();
    expect(await repo.getTask('ta2')).toBeUndefined();
    const del = (await repo.listAudit('org-1')).filter(a => a.action === 'event.delete' && a.entityId === 'e2');
    expect(del.length).toBe(1);
  });

  it('event.delete is admin-only (FM gets a real 403, not a fake success)', async () => {
    const fm = await login('fm@camp.local', 'fm12345');
    const res = await app.inject({ method: 'DELETE', url: '/v1/events/e2', headers: H(fm) });
    expect(res.statusCode).toBe(403);
    expect(await repo.snapshot('e2')).toBeTruthy();
  });
});

describe('QA-M2-8: create responses carry the created entity id', () => {
  it('POST task returns applied.createdId pointing at a real task', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const res = await app.inject({
      method: 'POST', url: '/v1/events/e1/tasks', headers: H(admin),
      payload: { task: { name: 'משימה חדשה', durationMin: 30, siteId: 'site-1', dependsOn: [], assigneeResourceIds: [], constraints: [], status: 'scheduled', start: null } },
    });
    expect(res.statusCode).toBe(200);
    const createdId = res.json().applied.createdId as string;
    expect(createdId).toBeTruthy();
    expect((await repo.getTask(createdId))?.name).toBe('משימה חדשה');
  });

  it('POST resource returns applied.createdId; admin event.create returns the full event', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const res = await app.inject({
      method: 'POST', url: '/v1/events/e1/resources', headers: H(admin),
      payload: { resource: { resourceKind: 'equipment', name: 'ציוד חדש', exclusive: false } },
    });
    expect(res.statusCode).toBe(200);
    const createdId = res.json().applied.createdId as string;
    expect(createdId).toBeTruthy();
    expect((await repo.getResource(createdId))?.name).toBe('ציוד חדש');
    const ev = await app.inject({
      method: 'POST', url: '/v1/events', headers: H(admin),
      payload: { name: 'אירוע חדש', date: '2026-10-05', timezone: 'Asia/Jerusalem', domainProfileId: 'camp', siteIds: ['s9'] },
    });
    expect(ev.statusCode).toBe(200);
    expect(ev.json().applied.event.id).toBeTruthy();
  });
});
