/** QA RT-PIN-4 acceptance probes (independent of the team's realtime.test.ts regressions).
 *  Angles: cross-user leakage, emit ordering, version sequencing, cancel-not-removal,
 *  admin tombstone absence, QA-M35-1 eventId presence on every patch frame. */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import { MemoryGraphRepository } from '../src/repo/memory.js';
import { seedDemo } from '../src/seed.js';
import { createRealtime, type Realtime } from '../src/realtime.js';
import { appEvents } from '../src/services/events.js';

let app: FastifyInstance; let repo: MemoryGraphRepository; let rt: Realtime; let url: string;
const clients: ClientSocket[] = [];
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

beforeEach(async () => {
  repo = MemoryGraphRepository.seeded(seedDemo());
  app = buildApp(repo, new AuthService(repo));
  await app.ready();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const a = app.server.address(); url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  rt = createRealtime(app.server, repo, new AuthService(repo), { revalidateMs: 120 });
});
afterEach(async () => { for (const c of clients) c.disconnect(); clients.length = 0; await rt.close(); await app.close(); });

const login = async (e: string, p: string) => (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: e, password: p } })).json().token as string;
const otpLogin = async (phone: string): Promise<string> => {
  const req = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone } });
  return (await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code: req.json().devCode } })).json().token as string;
};
const H = (t: string) => ({ authorization: `Bearer ${t}` });
interface Frame { name: string; payload: Record<string, unknown>; }
const connect = (token: string): Promise<Frame[]> =>
  new Promise((resolve, reject) => {
    const frames: Frame[] = [];
    const socket = ioc(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    clients.push(socket);
    for (const n of ['graph.patch', 'graph.remove', 'change.pending', 'change.resolved', 'report.new', 'notify.failed'])
      socket.on(n, (payload: Record<string, unknown>) => frames.push({ name: n, payload }));
    socket.on('connect', () => resolve(frames));
    socket.on('connect_error', reject);
  });

it('P4-1 unassign: removed user gets one tombstone, no patch; OTHER worker gets nothing (no cross-user leak)', async () => {
  const admin = await login('admin@camp.local', 'admin123');
  const w1 = await otpLogin('+972500000001'); // r-g1, assignee of t7
  const w2 = await otpLogin('+972500000002'); // r-g2, NOT on t7
  const fW1 = await connect(w1); const fW2 = await connect(w2);
  const emitted: string[] = [];
  const unsub = appEvents.subscribe(e => emitted.push(e.type));
  const v = (await repo.getTask('t7'))!.version;
  const r = await app.inject({ method: 'PATCH', url: '/v1/tasks/t7', headers: H(admin), payload: { version: v, assign: { assigneeResourceIds: [] } } });
  expect(r.statusCode).toBe(200);
  await sleep(400);
  unsub();
  // ordering: tombstone emitted BEFORE the upsert patch
  expect(emitted.indexOf('graph.removed')).toBeGreaterThanOrEqual(0);
  expect(emitted.indexOf('graph.removed')).toBeLessThan(emitted.indexOf('graph.applied'));
  const tomb = fW1.filter(f => f.name === 'graph.remove');
  expect(tomb.length).toBe(1);
  expect(tomb[0]!.payload).toMatchObject({ type: 'graph.remove', eventId: 'e1', taskIds: ['t7'] });
  expect(tomb[0]!.payload['siteId']).toBeUndefined();
  expect(tomb[0]!.payload['version']).toBe((await repo.getEvent('e1'))!.version); // post-mutation version
  expect(fW1.filter(f => f.name === 'graph.patch').length).toBe(0); // removed user gets no upsert
  expect(fW2.length).toBe(0); // unrelated worker: total silence
});

it('P4-2 delete: site-room tombstone WITH siteId; assignee user-room tombstone WITHOUT; admin patch-only; versions in sequence', async () => {
  const admin = await login('admin@camp.local', 'admin123');
  const fm = await login('fm@camp.local', 'fm12345'); // siteRoom(e2, site-1)
  const fAdmin = await connect(admin); const fFm = await connect(fm);
  const vBefore = (await repo.getEvent('e2'))!.version;
  const v = (await repo.getTask('ta1'))!.version;
  const r = await app.inject({ method: 'DELETE', url: '/v1/tasks/ta1', headers: H(admin), payload: {} });
  expect(r.statusCode).toBe(200);
  await sleep(400);
  const siteTomb = fFm.filter(f => f.name === 'graph.remove');
  expect(siteTomb.length).toBe(1);
  expect(siteTomb[0]!.payload).toMatchObject({ type: 'graph.remove', eventId: 'e2', taskIds: ['ta1'], siteId: 'site-1' });
  expect(siteTomb[0]!.payload['version']).toBe(vBefore + 1);
  expect(fAdmin.filter(f => f.name === 'graph.remove').length).toBe(0); // admins: NO tombstone ever
  const adminPatch = fAdmin.filter(f => f.name === 'graph.patch');
  expect(adminPatch.length).toBe(1);
  expect(adminPatch[0]!.payload['version']).toBe(vBefore + 1); // same sequence slot as tombstone
  expect((adminPatch[0]!.payload['tasks'] as Array<{ id: string }>).some(t => t.id === 'ta1')).toBe(false); // wholesale replace drops it
  // every patch frame carries eventId (QA-M35-1 backend side)
  for (const p of adminPatch) expect(typeof p.payload['eventId']).toBe('string');
});

it('P4-3 cancel is NOT a removal: assignee gets upsert patch with cancelled status, zero tombstones anywhere', async () => {
  const admin = await login('admin@camp.local', 'admin123');
  const w1 = await otpLogin('+972500000001');
  const fm = await login('fm@camp.local', 'fm12345');
  const fW1 = await connect(w1); const fFm = await connect(fm); const fAdmin = await connect(admin);
  const v = (await repo.getTask('t7'))!.version;
  const r = await app.inject({ method: 'PATCH', url: '/v1/tasks/t7', headers: H(admin), payload: { version: v, patch: { status: 'cancelled' } } });
  expect(r.statusCode).toBe(200);
  await sleep(400);
  for (const f of [fW1, fFm, fAdmin]) expect(f.filter(x => x.name === 'graph.remove').length).toBe(0);
  const patch = fW1.find(f => f.name === 'graph.patch');
  expect(patch).toBeTruthy();
  const tasks = patch!.payload['tasks'] as Array<{ id: string; status: string }>;
  expect(tasks.find(t => t.id === 't7')?.status).toBe('cancelled');
});

it('P4-4 sequence: tombstone mutation then ordinary move stay strictly sequential', async () => {
  const admin = await login('admin@camp.local', 'admin123');
  const fAdmin = await connect(admin);
  const v1 = (await repo.getTask('ta1'))!.version;
  await app.inject({ method: 'DELETE', url: '/v1/tasks/ta1', headers: H(admin), payload: {} });
  await sleep(300);
  const v2 = await repo.getTask('ta2')?.version ?? 1;
  await app.inject({ method: 'PATCH', url: '/v1/tasks/ta2', headers: H(admin), payload: { version: v2, move: { newStart: '2026-09-14T10:30:00+03:00' } } });
  await sleep(400);
  const versions = fAdmin.filter(f => f.name === 'graph.patch').map(f => f.payload['version'] as number);
  expect(versions.length).toBe(2);
  expect(versions[1]).toBe(versions[0]! + 1); // no gap, no reuse — client gap-detection never false-fires
});
