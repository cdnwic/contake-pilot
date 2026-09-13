/** QA G4 SECURITY probes (QA-owned, adversarial; plan 3ו-ב security half).
 *  SEC-1 systematic RBAC sweep  SEC-2 Hebrew injection (XSS+SQLi)
 *  SEC-3 replay idempotency     SEC-4 cross-org isolation (REST + socket silence).
 *  Runs in BOTH repo modes (REPO_IMPL=memory|postgres). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { io as ioc } from 'socket.io-client';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo } from './helpers/repo.js';
import { createRealtime, type Realtime } from '../src/realtime.js';

let repo: GraphRepository; let app: FastifyInstance; let auth: AuthService;
beforeEach(async () => { repo = await makeTestRepo(); auth = new AuthService(repo); app = buildApp(repo, auth); await app.ready(); });
afterEach(async () => { await app.close(); });

const H = (t: string) => ({ authorization: `Bearer ${t}` });
const login = async (e: string, p: string) =>
  (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: e, password: p } })).json().token as string;
const deniedRows = async () => (await repo.listAudit('org-1')).filter(r => r.outcome === 'denied');

describe('QA-G4-SEC-1: systematic RBAC sweep — focus_worker denied on every mutating endpoint, each denial audited', () => {
  it('every mutating endpoint denies focus_worker with 403 + exactly one denied row per attempt', async () => {
    const t = auth.issueToken('u-w1');
    const ev = (await repo.getEvent('e1'))!;
    const t1 = (await repo.getTask('t1'))!;
    const r1 = (await repo.getResource('r-g1'))!;
    const depId = (await repo.snapshot('e1'))!.dependencies[0]?.id;
    const attempts: { label: string; method: 'POST' | 'PATCH' | 'DELETE'; url: string; payload?: unknown }[] = [
      { label: 'event.create', method: 'POST', url: '/v1/events', payload: { name: 'x', date: '2026-09-20', timezone: 'Asia/Jerusalem', domainProfileId: 'camp', siteIds: ['site-1'] } },
      { label: 'event.update', method: 'PATCH', url: '/v1/events/e1', payload: { version: ev.version, patch: { name: 'x' } } },
      { label: 'event.delete', method: 'DELETE', url: '/v1/events/e1' },
      { label: 'event.publish', method: 'POST', url: '/v1/events/e1/publish', payload: {} },
      { label: 'task.create', method: 'POST', url: '/v1/events/e1/tasks', payload: { task: { name: 'x', start: '2026-09-14T09:00:00+03:00', durationMin: 30, siteId: 'site-1' } } },
      { label: 'task.update', method: 'PATCH', url: '/v1/tasks/t1', payload: { version: t1.version, patch: { name: 'x' } } },
      { label: 'task.delete', method: 'DELETE', url: '/v1/tasks/ta1' }, // draft event e2: reaches role decision (M1-3 subscriber guard would 409 first on e1 tasks)
      { label: 'resource.create', method: 'POST', url: '/v1/events/e1/resources', payload: { resource: { resourceKind: 'person', name: 'x', exclusive: false } } },
      { label: 'resource.update', method: 'PATCH', url: '/v1/resources/r-g1', payload: { version: r1.version, patch: { name: 'x' } } },
      { label: 'resource.delete', method: 'DELETE', url: '/v1/resources/r-g1' },
      { label: 'dependency.create', method: 'POST', url: '/v1/events/e1/dependencies', payload: { fromTaskId: 't7', toTaskId: 't5' } }, // t7 is dependency-free in seed - no cycle 400 before the role check
      ...(depId ? [{ label: 'dependency.delete', method: 'DELETE' as const, url: `/v1/dependencies/${depId}` }] : []),
      { label: 'change.approve', method: 'POST', url: '/v1/changes/cr_sweep/approve', payload: {} },
      { label: 'change.reject', method: 'POST', url: '/v1/changes/cr_sweep/reject', payload: {} },
    ];
    const codes: Record<string, number> = {};
    for (const a of attempts) {
      const before = (await deniedRows()).length;
      const res = await app.inject({ method: a.method, url: a.url, headers: H(t), payload: a.payload as Record<string, unknown> });
      codes[a.label] = res.statusCode;
      const after = (await deniedRows()).length;
      expect(res.statusCode, `${a.label} -> ${res.statusCode} ${res.body}`).toBe(403);
      expect(after - before, `${a.label} must append exactly one denied row`).toBe(1);
    }
    console.log('SEC-1 sweep codes:', JSON.stringify(codes));
    // domino dry-run: still 403 for focus_worker, but NO denied row (excluded by construction)
    const beforeDomino = (await deniedRows()).length;
    const dry = await app.inject({ method: 'POST', url: '/v1/domino/compute', headers: H(t), payload: { eventId: 'e1', change: { type: 'task.move', taskId: 't2', newStart: '2026-09-14T10:00:00+03:00' } } });
    expect(dry.statusCode).toBe(403);
    expect((await deniedRows()).length).toBe(beforeDomino);
    // positive control: focus_worker CAN report on an own task (no denied row)
    const beforeReport = (await deniedRows()).length;
    const rep = await app.inject({ method: 'POST', url: '/v1/reports', headers: H(t), payload: { taskId: 't1', status: 'ok', clientReportId: 'sweep-ok-1', clientTimestamp: new Date().toISOString() } });
    expect([200, 201]).toContain(rep.statusCode);
    expect((await deniedRows()).length).toBe(beforeReport);
  });

  it('field_manager is denied admin-only endpoints (sweep of 3), each audited', async () => {
    const t = await login('fm@camp.local', 'fm12345');
    for (const a of [
      { method: 'DELETE' as const, url: '/v1/events/e1' },
      { method: 'POST' as const, url: '/v1/changes/cr_sweep/approve', payload: {} },
      { method: 'POST' as const, url: '/v1/changes/cr_sweep/reject', payload: {} },
    ]) {
      const before = (await deniedRows()).length;
      const res = await app.inject({ method: a.method, url: a.url, headers: H(t), payload: a.payload as Record<string, unknown> });
      expect(res.statusCode, `${a.method} ${a.url} -> ${res.statusCode}`).toBe(403);
      expect((await deniedRows()).length - before).toBe(1);
    }
  });
});

describe('QA-G4-SEC-2: Hebrew injection — SQLi and XSS payloads stored verbatim, no execution, tables intact', () => {
  it('SQLi metacharacters in task name: stored verbatim, task table intact, version bumped once', async () => {
    const t = await login('admin@camp.local', 'admin123');
    const evil = `'; DROP TABLE tasks; -- אבגד "' OR '1'='1`;
    const t2 = (await repo.getTask('t2'))!;
    const res = await app.inject({ method: 'PATCH', url: '/v1/tasks/t2', headers: H(t), payload: { version: t2.version, patch: { name: evil } } });
    expect(res.statusCode).toBe(200);
    expect((await repo.getTask('t2'))!.name).toBe(evil); // verbatim round-trip
    expect((await repo.listTasks('e1')).length).toBeGreaterThanOrEqual(3); // table intact
    expect((await repo.getTask('t2'))!.version).toBe(t2.version + 1);
  });

  it('XSS payloads in report noteHe + task name: verbatim, API never marks up', async () => {
    const t = await login('admin@camp.local', 'admin123');
    const xss = `<script>alert(1)</script><img src=x onerror=alert(2)> עברית">'`;
    const t3 = (await repo.getTask('t3'))!;
    const res = await app.inject({ method: 'PATCH', url: '/v1/tasks/t3', headers: H(t), payload: { version: t3.version, patch: { name: xss } } });
    expect(res.statusCode).toBe(200);
    expect((await repo.getTask('t3'))!.name).toBe(xss);
    const w = auth.issueToken('u-w1');
    const rep = await app.inject({ method: 'POST', url: '/v1/reports', headers: H(w), payload: { taskId: 't1', status: 'blocked', noteHe: xss, clientReportId: 'xss-1', clientTimestamp: new Date().toISOString() } });
    expect(rep.statusCode).toBe(200);
    const stored = (await repo.listReports('e1')).find(r => r.clientReportId === 'xss-1')!;
    expect(stored.noteHe).toBe(xss); // verbatim; escaping is the renderer's job (React escapes by default)
  });
});

describe('QA-G4-SEC-3: replay idempotency — a replayed mutation or report never double-applies', () => {
  it('same task PATCH replayed: 200 then 409, version bumped once, exactly one applied audit row', async () => {
    const t = await login('admin@camp.local', 'admin123');
    const t2 = (await repo.getTask('t2'))!;
    const payload = { version: t2.version, patch: { name: 'replay-probe' } };
    const r1 = await app.inject({ method: 'PATCH', url: '/v1/tasks/t2', headers: H(t), payload });
    const r2 = await app.inject({ method: 'PATCH', url: '/v1/tasks/t2', headers: H(t), payload });
    expect([r1.statusCode, r2.statusCode]).toEqual([200, 409]);
    expect((await repo.getTask('t2'))!.version).toBe(t2.version + 1);
    const rows = (await repo.listAudit('org-1')).filter(r => r.action === 'task.update' && r.entityId === 't2' && r.outcome !== 'denied');
    expect(rows).toHaveLength(1);
  });

  it('same clientReportId resubmitted: deduped, one stored report, one applied audit row', async () => {
    const w = auth.issueToken('u-w1');
    const payload = { taskId: 't1', status: 'ok', clientReportId: 'replay-1', clientTimestamp: new Date().toISOString() };
    const r1 = await app.inject({ method: 'POST', url: '/v1/reports', headers: H(w), payload });
    const r2 = await app.inject({ method: 'POST', url: '/v1/reports', headers: H(w), payload });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r1.json().deduped ?? false).toBe(false);
    expect(r2.json().deduped).toBe(true);
    expect((await repo.listReports('e1')).filter(r => r.clientReportId === 'replay-1')).toHaveLength(1);
    const rows = (await repo.listAudit('org-1')).filter(r => r.action === 'report.status.create' && r.entityType === 'task' && r.entityId === 't1');
    expect(rows).toHaveLength(1);
  });
});

describe('QA-G4-SEC-4: cross-org isolation — REST and socket silence', () => {
  it('org-2 principal cannot see or touch org-1 resources over REST', async () => {
    const b = auth.issueToken('u-admin-b');
    const events = (await app.inject({ method: 'GET', url: '/v1/events', headers: H(b) })).json().events as { id: string }[];
    expect(events.map(e => e.id)).not.toContain('e1');
    const graph = await app.inject({ method: 'GET', url: '/v1/events/e1/graph', headers: H(b) });
    expect([403, 404]).toContain(graph.statusCode);
    const patch = await app.inject({ method: 'PATCH', url: '/v1/tasks/t1', headers: H(b), payload: { version: 1, patch: { name: 'x' } } });
    expect([403, 404]).toContain(patch.statusCode);
    expect((await repo.getTask('t1'))!.name).not.toBe('x'); // untouched
    // org-2 reporting against an org-1 task: 404 (no existence leak)
    const rep = await app.inject({ method: 'POST', url: '/v1/reports', headers: H(b), payload: { taskId: 't1', status: 'ok', clientReportId: 'xo-1', clientTimestamp: new Date().toISOString() } });
    expect(rep.statusCode).toBe(404);
    // and the org-1 audit log holds no trace of org-2 attempts beyond denied rows (no applied rows)
    const applied = (await repo.listAudit('org-1')).filter(r => r.outcome !== 'denied' && r.actorUserId === 'u-admin-b');
    expect(applied).toEqual([]);
  });

  it('org-2 socket receives ZERO frames when org-1 mutates (silence), org-1 socket receives normally', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const rt: Realtime = createRealtime(app.server, repo, auth, { revalidateMs: 60_000 });
    try {
      const frames2: string[] = []; const frames1: string[] = [];
      const s2 = ioc(url, { auth: { token: auth.issueToken('u-admin-b') }, transports: ['websocket'], reconnection: false });
      const s1 = ioc(url, { auth: { token: auth.issueToken('u-admin') }, transports: ['websocket'], reconnection: false });
      for (const [s, arr] of [[s2, frames2], [s1, frames1]] as const)
        for (const n of ['graph.patch', 'graph.remove', 'change.pending', 'change.resolved', 'notify.failed']) s.on(n, () => arr.push(n));
      await Promise.all([s1, s2].map(s => new Promise<void>((res, rej) => { s.on('connect', res); s.on('connect_error', rej); })));
      const t = await login('admin@camp.local', 'admin123');
      const task = (await repo.getTask('t2'))!;
      const res = await app.inject({ method: 'PATCH', url: '/v1/tasks/t2', headers: H(t), payload: { version: task.version, patch: { name: 'שקט ארגוני' } } });
      expect(res.statusCode).toBe(200);
      await new Promise(r => setTimeout(r, 1500));
      expect(frames1.length).toBeGreaterThan(0);
      expect(frames2).toEqual([]);
      console.log(`SEC-4 socket: org-1 frames=${frames1.length}, org-2 frames=${frames2.length}`);
      s1.disconnect(); s2.disconnect();
    } finally { await rt.close(); }
  }, 30_000);
});
