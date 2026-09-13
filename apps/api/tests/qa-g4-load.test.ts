/** QA G4 LOAD HARNESS (plan 3ו-ב, PG mode only — production shape).
 *  Weighted in-app per Chaim's ruling: socket fanout, CAS contention, reconnect herd.
 *  Run: REPO_IMPL=postgres pnpm vitest run tests/qa-g4-load.test.ts
 *  Bars (QA-set, hard unless marked): G4-L1 loss = 0, p95 latency < 2000ms (provisional,
 *  localhost harness); G4-L2 exactly one CAS winner, gapless version sequence;
 *  G4-L4 100% reconnect success, server responsive after herd. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService, hashPasswordPure } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo, REPO_IMPL } from './helpers/repo.js';
import { createRealtime, type Realtime } from '../src/realtime.js';

const PG = REPO_IMPL === 'postgres';
const N = Number(process.env['G4_N'] ?? 200);
let app: FastifyInstance; let repo: GraphRepository; let rt: Realtime; let url: string; let auth: AuthService;
const clients: ClientSocket[] = [];
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

beforeAll(async () => {
  if (!PG) return;
  repo = await makeTestRepo();
  auth = new AuthService(repo);
  app = buildApp(repo, auth);
  await app.ready();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  rt = createRealtime(app.server, repo, auth, { revalidateMs: 60_000 }); // isolate fanout from revalidate churn
}, 120_000);

afterAll(async () => {
  if (!PG) return;
  for (const c of clients) c.disconnect();
  clients.length = 0;
  await rt.close();
  await app.close();
}, 120_000);

const H = (t: string): { authorization: string } => ({ authorization: `Bearer ${t}` });
const adminToken = async (): Promise<string> =>
  (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@camp.local', password: 'admin123' } })).json().token as string;

// site-room membership is field_manager-only by design (focus workers get userRoom own-task frames only)
async function spawnFocusUsers(n: number): Promise<string[]> {
  const tokens: string[] = [];
  for (let i = 0; i < n; i++) {
    const userId = `u-load-${i}`;
    await repo.createUser({ userId, orgId: 'org-1', name: `עובד עומס ${i}`, role: 'field_manager', scopes: [{ eventId: 'e1' }], phone: `+9726000${String(i).padStart(5, '0')}`, passwordHash: hashPasswordPure('x'), active: true } as Parameters<GraphRepository['createUser']>[0]);
    tokens.push(auth.issueToken(userId));
  }
  return tokens;
}

interface Conn { socket: ClientSocket; frames: { name: string; at: number; payload: Record<string, unknown> }[]; }
const connect = (token: string): Promise<Conn> =>
  new Promise((resolve, reject) => {
    const frames: Conn['frames'] = [];
    const socket = ioc(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    clients.push(socket);
    for (const n of ['graph.patch', 'graph.remove', 'change.pending', 'change.resolved', 'notify.failed'])
      socket.on(n, (payload: Record<string, unknown>) => frames.push({ name: n, at: Date.now(), payload }));
    socket.on('connect', () => resolve({ socket, frames }));
    socket.on('connect_error', reject);
  });

const pct = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

describe.skipIf(!PG)('QA G4 load harness (PG)', () => {
  it('G4-L1: one mutation fans out to N site subscribers + adminsRoom with zero loss', async () => {
    const tokens = await spawnFocusUsers(N);
    const conns: Conn[] = [];
    for (let i = 0; i < tokens.length; i += 50) // connect in waves of 50
      conns.push(...await Promise.all(tokens.slice(i, i + 50).map(connect)));
    const t0 = Date.now();
    const token = await adminToken();
    const task = (await repo.listTasks('e1')).find(t => !t.locked && t.status !== 'canceled')!;
    const res = await app.inject({ method: 'PATCH', url: `/v1/tasks/${task.id}`, headers: H(token), payload: { version: task.version, patch: { name: `${task.name} · G4-L1` } } });
    expect(res.statusCode).toBe(200);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && conns.some(c => !c.frames.some(f => f.name === 'graph.patch' && f.at >= t0))) await sleep(100);
    const lat = conns.map(c => (c.frames.find(f => f.name === 'graph.patch' && f.at >= t0)?.at ?? -1) - t0);
    const lost = lat.filter(l => l < 0).length;
    const got = lat.filter(l => l >= 0).sort((a, b) => a - b);
    console.log(`G4-L1 N=${N}: loss=${lost} p50=${pct(got, 50)}ms p95=${pct(got, 95)}ms max=${got[got.length - 1]}ms`);
    expect(lost).toBe(0);
    expect(pct(got, 95)).toBeLessThan(2000);
  }, 180_000);

  it('G4-L2: M concurrent same-event patches -> clean CAS per mutation, gapless version sequence, no lost update', async () => {
    const token = await adminToken();
    const tasks = (await repo.listTasks('e1')).filter(t => !t.locked && t.status !== 'canceled');
    const M = tasks.length; // all unlocked tasks of the event (seed-sized)
    expect(M).toBeGreaterThanOrEqual(3);
    const v = (await repo.getEvent('e1'))!.version;
    // (a) multi-winner shape: DIFFERENT tasks racing on the same event - each applied
    // mutation must bump the event version exactly once; losers fail clean with 409.
    const results = await Promise.all(tasks.map((t, i) =>
      app.inject({ method: 'PATCH', url: `/v1/tasks/${t.id}`, headers: H(token), payload: { version: t.version, patch: { name: `${t.name} · race${i}` } } })));
    const codes = results.map(r => r.statusCode);
    const wins = codes.filter(c => c === 200).length;
    const conflicts = codes.filter(c => c === 409).length;
    const other = codes.filter(c => c !== 200 && c !== 409);
    console.log(`G4-L2a M=${M}: wins=${wins} conflicts=${conflicts} other=${other}`);
    expect(other).toEqual([]);
    expect(wins).toBeGreaterThanOrEqual(1);
    expect(wins + conflicts).toBe(M);
    // gapless sequence: exactly one version bump per applied mutation
    expect((await repo.getEvent('e1'))!.version).toBe(v + wins);
    // no lost update: every winner's rename persisted
    for (let i = 0; i < M; i++) {
      if (codes[i] === 200) expect((await repo.getTask(tasks[i].id))!.name).toContain(`race${i}`);
    }
    // (b) true CAS race: two concurrent patches on the SAME task with the SAME task
    // version - exactly one wins (endpoint CAS on task.version).
    const t0 = (await repo.listTasks('e1')).find(t => !t.locked && t.status !== 'canceled')!;
    const pair = await Promise.all([0, 1].map(i =>
      app.inject({ method: 'PATCH', url: `/v1/tasks/${t0.id}`, headers: H(token), payload: { version: t0.version, patch: { name: `${t0.name} · cas${i}` } } })));
    const pairCodes = pair.map(r => r.statusCode).sort();
    console.log(`G4-L2b same-task race: ${pairCodes}`);
    expect(pairCodes).toEqual([200, 409]);
  }, 60_000);

  it('G4-L3: 60s burst digest — K changes x R recipients coalesce to ONE digest per recipient, zero duplicates', async () => {
    // QA-set bar: exactly R provider sends total (one per recipient), each a digest
    // with changeCount = K; closing tick < 5000ms; no per-change sends; tick 3 silent.
    const R = 25, K = 40;
    let clock = Date.parse('2026-09-14T12:00:00+03:00');
    const calls: { to: string; body: string }[] = [];
    const okP = (name: 'whatsapp' | 'sms'): import('../src/services/dispatch.js').MessageProvider =>
      ({ name, send: (to: string, body: string) => { calls.push({ to, body }); return Promise.resolve({ ok: true as const, retryable: false }); } });
    const { createDispatcher } = await import('../src/services/dispatch.js');
    const d = createDispatcher({ repo, providers: { whatsapp: okP('whatsapp'), sms: okP('sms') }, now: () => clock });
    const addrs = Array.from({ length: R }, (_, i) => `+9725999${String(i).padStart(5, '0')}`);
    const t0 = Date.now();
    for (let c = 0; c < K; c++) {
      await repo.createNotificationJob({
        id: `job_g4l3_${c}`, eventId: 'e1', kind: 'change_needs_approval',
        targets: addrs.map(a => ({ channel: 'whatsapp' as const, address: a, recipientLabel: `הורה ${a.slice(-4)}` })),
        templateKey: 'change_needs_approval',
        params: { summaryHe: `שינוי מספר ${c}` },
        idempotencyKey: `e1+cr_g4l3_${c}+change_needs_approval`,
        batchWindowSec: 60,
      } as Parameters<typeof repo.createNotificationJob>[0]);
    }
    const seedMs = Date.now() - t0;
    await d.dispatchDue(); // tick 1: windows open for all R addresses, nothing sends
    expect(calls.length).toBe(0);
    clock += 61_000;
    const t1 = Date.now();
    const recs = await d.dispatchDue(); // tick 2: windows close -> digests
    const closeMs = Date.now() - t1;
    expect(calls.length).toBe(R);
    const perAddr = new Map<string, number>();
    for (const c of calls) perAddr.set(c.to, (perAddr.get(c.to) ?? 0) + 1);
    expect([...perAddr.values()].every(n => n === 1)).toBe(true); // exactly one send per recipient
    for (const c of calls) expect(c.body).toContain(String(K)); // digest changeCount = K
    const batched = recs.filter(r => r.status === 'batched');
    expect(batched.length).toBe(R * K); // every change recorded as batched, none sent individually
    expect(recs.filter(r => r.status === 'failed')).toEqual([]);
    const recs3 = await d.dispatchDue(); // tick 3: everything dispatched -> silence
    expect(calls.length).toBe(R);
    expect(recs3.filter(r => r.status !== 'held')).toEqual([]);
    console.log(`G4-L3 R=${R} K=${K}: seed=${seedMs}ms, closing tick=${closeMs}ms, sends=${calls.length} (1 digest/recipient), batched records=${batched.length}`);
    expect(closeMs).toBeLessThan(5000);
  }, 120_000);

  it('G4-L4: thundering-herd reconnect — all N clients reconnect, server stays responsive', async () => {
    const tokens = await spawnFocusUsers(N);
    const first: Conn[] = [];
    for (let i = 0; i < tokens.length; i += 50) first.push(...await Promise.all(tokens.slice(i, i + 50).map(connect)));
    for (const c of first) c.socket.disconnect();
    const t0 = Date.now();
    const herd: Conn[] = [];
    const waves: Promise<Conn[]>[] = [];
    for (let i = 0; i < tokens.length; i += 50) waves.push(Promise.all(tokens.slice(i, i + 50).map(connect)));
    for (const w of waves) herd.push(...await w);
    const reconnectMs = Date.now() - t0;
    // server responsive after herd: a mutation still applies and fans out
    const token = await adminToken();
    const task = (await repo.listTasks('e1')).find(t => !t.locked && t.status !== 'canceled')!;
    const res = await app.inject({ method: 'PATCH', url: `/v1/tasks/${task.id}`, headers: H(token), payload: { version: task.version, patch: { name: `${task.name} · G4-L4` } } });
    expect(res.statusCode).toBe(200);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && herd.some(c => !c.frames.some(f => f.name === 'graph.patch' && f.at >= t0))) await sleep(100);
    const lost = herd.filter(c => !c.frames.some(f => f.name === 'graph.patch' && f.at >= t0)).length;
    console.log(`G4-L4 N=${N}: herd reconnect=${reconnectMs}ms, post-herd fanout loss=${lost}`);
    expect(herd.length).toBe(N);
    expect(lost).toBe(0);
  }, 180_000);
});
