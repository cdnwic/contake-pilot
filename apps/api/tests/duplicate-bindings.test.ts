/** TL ruling 2026-09-14: counselor bindings survive event duplication (same
 *  userIds, scope preserved, eventId repointed, siteIds remapped positionally);
 *  site-room joins then work for scoped field_managers on the duplicated event.
 *  v1.15 section 13: event-wide (scope='all') managers join ALL site rooms of the
 *  events they cover - the expansion mirrors inScope exactly. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService, hashPasswordPure } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo } from './helpers/repo.js';
import { createRealtime, type Realtime } from '../src/realtime.js';

let app: FastifyInstance;
let repo: GraphRepository;
let auth: AuthService;
let rt: Realtime;
let url: string;
const clients: ClientSocket[] = [];

beforeEach(async () => {
  repo = await makeTestRepo();
  auth = new AuthService(repo);
  app = buildApp(repo, auth);
  await app.ready();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  url = `http://127.0.0.1:${port}`;
  rt = createRealtime(app.server, repo, new AuthService(repo), { revalidateMs: 120 });
});
afterEach(async () => {
  for (const c of clients) c.disconnect();
  clients.length = 0;
  await rt.close();
  await app.close();
});

const login = async (e: string, p: string) => (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: e, password: p } })).json().token as string;
const H = (t: string) => ({ authorization: `Bearer ${t}` });
interface Frame { name: string; payload: Record<string, unknown>; }
const connect = (token: string): Promise<{ frames: Frame[] }> =>
  new Promise((resolve, reject) => {
    const frames: Frame[] = [];
    const socket = ioc(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    clients.push(socket);
    for (const n of ['graph.patch', 'graph.remove', 'change.pending', 'change.resolved', 'report.new', 'report.resolved']) {
      socket.on(n, (p: Record<string, unknown>) => frames.push({ name: n, payload: p }));
    }
    socket.on('connect', () => resolve({ frames }));
    socket.on('connect_error', reject);
  });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('counselor bindings survive event duplication', () => {
  it('site-bound FM and event-wide worker scopes are cloned to the new event; admin untouched', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const res = await app.inject({ method: 'POST', url: '/v1/events/e1/duplicate', headers: H(admin), payload: { date: '2026-09-15', name: 'עותק' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const newEv = body.applied.event.id as string;
    // contract-pinned response shape: no bindings surface (implicit copy)
    expect(Object.keys(body.applied.copied).sort()).toEqual(['dependencies', 'resources', 'tasks']);
    const fm = await repo.getUser('u-fm');
    expect(fm!.scopes).toContainEqual({ eventId: newEv, siteId: 'site-1' });
    expect(fm!.scopes).toContainEqual({ eventId: 'e1', siteId: 'site-1' }); // source binding preserved
    expect(fm!.scopes).toContainEqual({ eventId: 'e2', siteId: 'site-1' }); // other event untouched
    const w1 = await repo.getUser('u-w1');
    expect(w1!.scopes).toContainEqual({ eventId: newEv });
    const adm = await repo.getUser('u-admin');
    expect(adm!.scopes).toEqual([]);
  });

  it("QA's scenario: a site-bound manager socket receives site-room frames on the DUPLICATED event", async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const res = await app.inject({ method: 'POST', url: '/v1/events/e1/duplicate', headers: H(admin), payload: { date: '2026-09-15' } });
    const newEv = res.json().applied.event.id as string;
    const fmTok = await login('fm@camp.local', 'fm12345');
    const { frames } = await connect(fmTok);
    const dup = (await repo.listTasks(newEv)).find(t => t.name === 'משימת בודד')!;
    const mv = await app.inject({ method: 'PATCH', url: `/v1/tasks/${dup.id}`, headers: H(admin), payload: { version: dup.version, move: { newStart: '2026-09-15T16:00:00+03:00' } } });
    expect(mv.statusCode).toBe(200);
    await sleep(150);
    expect(frames.some(f => f.name === 'graph.patch' && JSON.stringify(f.payload).includes(dup.id))).toBe(true);
  });
});

describe("event-wide ('all') managers: expansion mirrors inScope (contracts v1.15 s13)", () => {
  it('an FM scoped to the event without a site RECEIVES the site-room frame', async () => {
    await repo.createUser({ userId: 'u-fm-wide', orgId: 'org-1', name: 'רכז כללי', role: 'field_manager', scopes: [{ eventId: 'e1' }], email: 'fmwide@camp.local', passwordHash: hashPasswordPure('wide12345'), active: true });
    const admin = await login('admin@camp.local', 'admin123');
    const wide = await login('fmwide@camp.local', 'wide12345');
    const { frames } = await connect(wide);
    const t7 = await repo.getTask('t7');
    const mv = await app.inject({ method: 'PATCH', url: '/v1/tasks/t7', headers: H(admin), payload: { version: t7!.version, move: { newStart: '2026-09-14T16:00:00+03:00' } } });
    expect(mv.statusCode).toBe(200);
    await sleep(200);
    expect(frames.some(f => f.name === 'graph.patch' && JSON.stringify(f.payload).includes('t7'))).toBe(true);
  });
});
