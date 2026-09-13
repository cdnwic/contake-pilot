/** contracts v1.12: POST /v1/reports/:id/resolve, GET /v1/users, contactPhone visibility. */
import { beforeEach, describe, expect, it } from 'vitest';
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
const login = async (e: string, p: string) => (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: e, password: p } })).json().token as string;
const H = (t: string) => ({ authorization: `Bearer ${t}` });

const seedReport = (id: string, taskId: string) =>
  repo.createReport({
    id, clientReportId: `cr-${id}`, taskId, reportedBy: 'u-w1', status: 'blocked',
    clientTimestamp: '2026-09-14T09:00:00+03:00', createdAt: '2026-09-14T09:00:05+03:00',
  });

describe('POST /v1/reports/:id/resolve (v1.12)', () => {
  it('admin resolve sets resolvedBy/At + note, one audit row (entityType report), one report.resolved frame', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    await seedReport('rep-1', 't4');
    const frames: AppEvent[] = [];
    const un = appEvents.subscribe(e => { if (e.type === 'report.resolved') frames.push(e); });
    const res = await app.inject({ method: 'POST', url: '/v1/reports/rep-1/resolve', headers: H(admin), payload: { resolutionNoteHe: 'טופל טלפונית' } });
    un();
    expect(res.statusCode).toBe(200);
    const report = res.json().report;
    expect(report.resolvedBy).toBe('u-admin');
    expect(report.resolvedAt).toBeTruthy();
    expect(report.resolutionNoteHe).toBe('טופל טלפונית');
    expect(frames.length).toBe(1);
    expect(frames[0]).toMatchObject({ type: 'report.resolved', eventId: 'e1', siteId: 'site-1' });
    const rows = (await repo.listAudit('org-1')).filter(r => r.action === 'report.resolve' && r.entityId === 'rep-1');
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ entityType: 'report', actorUserId: 'u-admin', eventId: 'e1' });
    // pure handled-state: no graph bump
    expect((await repo.getEvent('e1'))!.version).toBe(1);
  });

  it('re-resolve is idempotent: 200 with EXISTING state, no overwrite, no second audit/frame', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    await seedReport('rep-2', 't4');
    const first = await app.inject({ method: 'POST', url: '/v1/reports/rep-2/resolve', headers: H(admin), payload: { resolutionNoteHe: 'ראשון' } });
    const frames: AppEvent[] = [];
    const un = appEvents.subscribe(e => { if (e.type === 'report.resolved') frames.push(e); });
    const second = await app.inject({ method: 'POST', url: '/v1/reports/rep-2/resolve', headers: H(admin), payload: { resolutionNoteHe: 'נסיון דריסה' } });
    un();
    expect(second.statusCode).toBe(200);
    expect(second.json().report.resolvedAt).toBe(first.json().report.resolvedAt);
    expect(second.json().report.resolutionNoteHe).toBe('ראשון');
    expect(frames.length).toBe(0);
    expect((await repo.listAudit('org-1')).filter(r => r.action === 'report.resolve').length).toBe(1);
  });

  it('concurrent double-resolve -> exactly one audit row and one frame', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    await seedReport('rep-3', 't4');
    const frames: AppEvent[] = [];
    const un = appEvents.subscribe(e => { if (e.type === 'report.resolved') frames.push(e); });
    const [r1, r2] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/reports/rep-3/resolve', headers: H(admin) }),
      app.inject({ method: 'POST', url: '/v1/reports/rep-3/resolve', headers: H(admin) }),
    ]);
    un();
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r1.json().report.resolvedAt).toBe(r2.json().report.resolvedAt);
    expect(frames.length).toBe(1);
    expect((await repo.listAudit('org-1')).filter(r => r.action === 'report.resolve').length).toBe(1);
  });

  it('field_manager in-scope (own site) resolves', async () => {
    const fm = await login('fm@camp.local', 'fm12345');
    await seedReport('rep-4', 't4'); // e1 / site-1
    const res = await app.inject({ method: 'POST', url: '/v1/reports/rep-4/resolve', headers: H(fm) });
    expect(res.statusCode).toBe(200);
    expect(res.json().report.resolvedBy).toBe('u-fm');
  });

  it('field_manager out-of-scope site -> 403 scope_violation + denied audit row, report untouched', async () => {
    const fm = await login('fm@camp.local', 'fm12345');
    await seedReport('rep-5', 'ta2'); // e2 / site-2 - fm scoped to e2/site-1 only
    const res = await app.inject({ method: 'POST', url: '/v1/reports/rep-5/resolve', headers: H(fm) });
    expect(res.statusCode).toBe(403);
    expect((await repo.getReport('rep-5'))!.resolvedBy).toBeUndefined();
    const denied = (await repo.listAudit('org-1')).filter(r => r.action === 'report.resolve' && r.outcome === 'denied');
    expect(denied.length).toBe(1);
    expect(denied[0]).toMatchObject({ denialReason: 'scope_violation', entityType: 'report', entityId: 'rep-5', eventId: 'e2' });
  });

  it('focus_worker -> 403 matrix_deny + denied audit row', async () => {
    await seedReport('rep-6', 't4');
    const w = auth.issueToken('u-w1');
    const res = await app.inject({ method: 'POST', url: '/v1/reports/rep-6/resolve', headers: H(w) });
    expect(res.statusCode).toBe(403);
    expect((await repo.getReport('rep-6'))!.resolvedBy).toBeUndefined();
    const denied = (await repo.listAudit('org-1')).filter(r => r.action === 'report.resolve' && r.outcome === 'denied');
    expect(denied.length).toBe(1);
    expect(denied[0]).toMatchObject({ denialReason: 'matrix_deny', entityType: 'report', entityId: 'rep-6' });
  });

  it('cross-org report id -> 404 (not 403)', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    await seedReport('rep-7', 'tf1'); // org-2 task
    const res = await app.inject({ method: 'POST', url: '/v1/reports/rep-7/resolve', headers: H(admin) });
    expect(res.statusCode).toBe(404);
    expect((await repo.getReport('rep-7'))!.resolvedBy).toBeUndefined();
  });

  it('unknown id -> 404', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const res = await app.inject({ method: 'POST', url: '/v1/reports/rep-nope/resolve', headers: H(admin) });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /v1/users (v1.12)', () => {
  it('admin gets org directory with display names, no credentials/phones', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const res = await app.inject({ method: 'GET', url: '/v1/users', headers: H(admin) });
    expect(res.statusCode).toBe(200);
    const users = res.json().users;
    expect(users.length).toBeGreaterThanOrEqual(5); // org-1 seed: u-admin, u-fm, u-w1..3
    expect(users.find((u: { id: string }) => u.id === 'u-admin')).toMatchObject({ displayName: 'דנה מנהלת', role: 'admin' });
    for (const u of users) {
      expect(Object.keys(u).sort()).toEqual(['displayName', 'id', 'role']);
    }
  });

  it('field_manager gets the directory; focus_worker is denied', async () => {
    const fm = await login('fm@camp.local', 'fm12345');
    expect((await app.inject({ method: 'GET', url: '/v1/users', headers: H(fm) })).statusCode).toBe(200);
    const w = auth.issueToken('u-w1');
    expect((await app.inject({ method: 'GET', url: '/v1/users', headers: H(w) })).statusCode).toBe(403);
  });
});

describe('ResourceNode.contactPhone (v1.12)', () => {
  it('person resource carries contactPhone for managers; focus_worker graph strips it', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const patch = await app.inject({ method: 'PATCH', url: '/v1/resources/r-g1', headers: H(admin), payload: { patch: { contactPhone: '+97250111222' } } });
    expect(patch.statusCode).toBe(200);
    const adminGraph = (await app.inject({ method: 'GET', url: '/v1/events/e1/graph', headers: H(admin) })).json();
    expect(adminGraph.resources.find((r: { id: string }) => r.id === 'r-g1').contactPhone).toBe('+97250111222');
    // field_manager keeps it (manager-roles visibility)
    const fm = await login('fm@camp.local', 'fm12345');
    const fmGraph = (await app.inject({ method: 'GET', url: '/v1/events/e1/graph', headers: H(fm) })).json();
    expect(fmGraph.resources.find((r: { id: string }) => r.id === 'r-g1').contactPhone).toBe('+97250111222');
    // focus_worker NEVER sees it
    const w = auth.issueToken('u-w1');
    const wGraph = (await app.inject({ method: 'GET', url: '/v1/events/e1/graph', headers: H(w) })).json();
    const wr = wGraph.resources.find((r: { id: string }) => r.id === 'r-g1');
    expect(wr).toBeDefined();
    expect('contactPhone' in wr).toBe(false);
  });

  it('contactPhone on a non-person resource -> 400', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const res = await app.inject({
      method: 'POST', url: '/v1/events/e1/resources', headers: H(admin),
      payload: { resource: { resourceKind: 'equipment', name: 'מגאפון', exclusive: true, contactPhone: '+97250111222' } },
    });
    expect(res.statusCode).toBe(400);
  });
});
