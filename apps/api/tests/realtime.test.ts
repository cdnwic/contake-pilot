import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo } from './helpers/repo.js';
import { createRealtime, type Realtime } from '../src/realtime.js';
import { hashPasswordPure } from '../src/auth.js';

let app: FastifyInstance;
let repo: GraphRepository;
let rt: Realtime;
let url: string;
const clients: ClientSocket[] = [];
const AT = '2026-09-14T';
const mv = (h: string): string => `${AT}${h}:00+03:00`;
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

beforeEach(async () => {
  repo = await makeTestRepo();
  app = buildApp(repo, new AuthService(repo));
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

const login = async (email: string, password: string): Promise<string> => {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });
  return res.json().token as string;
};
const otpLogin = async (phone: string): Promise<string> => {
  const req = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone } });
  const res = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code: req.json().devCode } });
  return res.json().token as string;
};
const H = (t: string): { authorization: string } => ({ authorization: `Bearer ${t}` });

interface Frame { name: string; payload: Record<string, unknown>; }
const connect = (token: string): Promise<{ socket: ClientSocket; frames: Frame[] }> =>
  new Promise((resolve, reject) => {
    const frames: Frame[] = [];
    const socket = ioc(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    clients.push(socket);
    for (const n of ['graph.patch', 'graph.remove', 'change.pending', 'change.resolved', 'report.new', 'notify.failed']) {
      socket.on(n, (payload: Record<string, unknown>) => frames.push({ name: n, payload }));
    }
    socket.on('connect', () => resolve({ socket, frames }));
    socket.on('connect_error', (e: Error) => reject(e));
  });

describe('RT — Socket.IO room membership (G2)', () => {
  it('RT-1: focus_worker gets own-task patches only; crafted join is a no-op', async () => {
    const w1 = await otpLogin('+972500000001');
    const { socket, frames } = await connect(w1);
    socket.emit('join', 'event:e1'); // crafted: server has no join handler
    socket.emit('join', { room: 'org:org-1:admins' });
    const admin = await login('admin@camp.local', 'admin123');
    // change to t4 (NOT worker's task) and to t7 (worker's task)
    await app.inject({ method: 'PATCH', url: '/v1/tasks/t4', headers: H(admin), payload: { version: 1, move: { newStart: mv('10:00') } } });
    await sleep(200);
    expect(frames).toEqual([]); // non-own task: zero frames (RT-1)
    await app.inject({ method: 'PATCH', url: '/v1/tasks/t7', headers: H(admin), payload: { version: 1, move: { newStart: mv('15:00') } } });
    await sleep(200);
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) {
      expect(f.name).toBe('graph.patch');
      const ids = (f.payload['tasks'] as { id: string }[]).map(t => t.id);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(['t1', 't2', 't3', 't7']).toContain(id); // own tasks only, never t4/t5/t6
    }
  });

  it('RT-2: field_manager(site-1) gets site-1 frames; site-2-only change produces NO frame', async () => {
    const fm = await login('fm@camp.local', 'fm12345');
    const { frames } = await connect(fm);
    const admin = await login('admin@camp.local', 'admin123');
    await app.inject({ method: 'PATCH', url: '/v1/tasks/ta2', headers: H(admin), payload: { version: 1, move: { newStart: mv('11:00') } } }); // site-2
    await sleep(200);
    expect(frames).toEqual([]); // site-2 change: no frame at all
    await app.inject({ method: 'PATCH', url: '/v1/tasks/ta1', headers: H(admin), payload: { version: 1, move: { newStart: mv('09:30') } } }); // site-1
    await sleep(200);
    expect(frames.length).toBe(1);
    const ids = (frames[0]!.payload['tasks'] as { id: string }[]).map(t => t.id);
    expect(ids).toEqual(['ta1']); // site-filtered content
    expect(frames[0]!.payload['siteId']).toBe('site-1');
  });

  it('RT-3: org-B admin receives nothing from org-A events (cross-tenant)', async () => {
    const bAdmin = await login('admin@film.local', 'admin123');
    const { frames } = await connect(bAdmin);
    const admin = await login('admin@camp.local', 'admin123');
    await app.inject({ method: 'PATCH', url: '/v1/tasks/t7', headers: H(admin), payload: { version: 1, move: { newStart: mv('15:00') } } });
    await sleep(200);
    expect(frames).toEqual([]);
  });

  it('RT-4: role downgrade mid-session revokes site frames within revalidate interval', async () => {
    const fm = await login('fm@camp.local', 'fm12345');
    const { frames } = await connect(fm);
    await repo.updateUser('u-fm', { role: 'focus_worker' });
    await sleep(300); // > 2x revalidateMs
    const admin = await login('admin@camp.local', 'admin123');
    await app.inject({ method: 'PATCH', url: '/v1/tasks/ta1', headers: H(admin), payload: { version: 1, move: { newStart: mv('09:30') } } });
    await sleep(200);
    expect(frames).toEqual([]); // no site frames after downgrade
  });

  it('RT-5: revoked (deactivated) user is disconnected within the interval', async () => {
    const fm = await login('fm@camp.local', 'fm12345');
    const { socket } = await connect(fm);
    const gone = new Promise<void>(res => { socket.on('disconnect', () => res()); });
    await repo.updateUser('u-fm', { active: false });
    await Promise.race([gone, sleep(2000)]);
    expect(socket.connected).toBe(false);
  });

  it('RT-6: change.pending -> admins only; change.resolved -> proposer + admins', async () => {
    const adminTok = await login('admin@camp.local', 'admin123');
    const fmTok = await login('fm@camp.local', 'fm12345');
    const w2Tok = await otpLogin('+972500000002');
    const admin = await connect(adminTok);
    const fm = await connect(fmTok);
    const w2 = await connect(w2Tok); // bystander
    // FM proposes S3 -> pending
    const res = await app.inject({ method: 'PATCH', url: '/v1/tasks/t1', headers: H(fmTok), payload: { version: 1, move: { newStart: mv('08:15') } } });
    const cr = res.json().changeRequest;
    await sleep(200);
    expect(admin.frames.filter(f => f.name === 'change.pending').length).toBe(1);
    expect(fm.frames.filter(f => f.name === 'change.pending').length).toBe(0); // admins only
    expect(w2.frames.filter(f => f.name === 'change.pending').length).toBe(0);
    // admin rejects -> resolved to proposer + admins, not bystander
    await app.inject({ method: 'POST', url: `/v1/changes/${cr.id}/reject`, headers: H(adminTok), payload: { reasonHe: 'לא' } });
    await sleep(200);
    expect(admin.frames.filter(f => f.name === 'change.resolved').length).toBe(1);
    expect(fm.frames.filter(f => f.name === 'change.resolved').length).toBe(1);
    expect(w2.frames.filter(f => f.name === 'change.resolved').length).toBe(0);
  });

  it('RT-7: report.new -> admins + owning-site field_managers only', async () => {
    const adminTok = await login('admin@camp.local', 'admin123');
    const fmTok = await login('fm@camp.local', 'fm12345'); // e1 site-1 + e2 site-1
    // second FM scoped to site-2 of e2 only
    await repo.createUser({ userId: 'u-fm2', orgId: 'org-1', name: 'רכז ב', role: 'field_manager', scopes: [{ eventId: 'e2', siteId: 'site-2' }], email: 'fm2@camp.local', passwordHash: hashPasswordPure('fm22222'), active: true });
    const fm2Tok = await login('fm2@camp.local', 'fm22222');
    const admin = await connect(adminTok);
    const fm = await connect(fmTok);
    const fm2 = await connect(fm2Tok);
    const w1 = await otpLogin('+972500000001');
    await app.inject({ method: 'POST', url: '/v1/reports', headers: H(w1), payload: { taskId: 't7', status: 'delayed', delayMin: 10, clientReportId: 'rt7-1', clientTimestamp: mv('14:05') } });
    await sleep(200);
    expect(admin.frames.filter(f => f.name === 'report.new').length).toBe(1);
    expect(fm.frames.filter(f => f.name === 'report.new').length).toBe(1); // site-1 owner
    expect(fm2.frames.filter(f => f.name === 'report.new').length).toBe(0); // site-2 only
  });

  it('rejects connections without a valid token', async () => {
    await expect(connect('bad.token')).rejects.toThrow();
  });
});

describe('QA-M2-3 subscriber-field leak guard (spec v1.3 / plan 3א)', () => {
  it('site frames carry only referenced resources and NEVER subscriberChannelIds', async () => {
    const fm = await login('fm@camp.local', 'fm12345');
    const { frames } = await connect(fm);
    await sleep(100); // let server-side room joins settle before the change
    const admin = await login('admin@camp.local', 'admin123');
    await app.inject({ method: 'PATCH', url: '/v1/tasks/ta1', headers: H(admin), payload: { version: 1, move: { newStart: mv('08:00') } } });
    await sleep(200);
    expect(frames.length).toBe(1);
    const frame = frames[0]!.payload;
    const taskIds = new Set((frame['tasks'] as { id: string }[]).map(t => t.id));
    const resources = frame['resources'] as { id: string; subscriberChannelIds?: string[] }[];
    for (const r of resources) {
      expect(r.subscriberChannelIds).toBeUndefined(); // stripped, always
    }
    // referenced-only: every resource in the frame is referenced by a frame task
    const referenced = new Set((frame['tasks'] as { assigneeResourceIds: string[] }[]).flatMap(t => t.assigneeResourceIds));
    for (const r of resources) expect(referenced.has(r.id)).toBe(true);
    void taskIds;
  });

  it('API graph responses for FM/FW are subscriber-filtered too (standing rule)', async () => {
    const fm = await login('fm@camp.local', 'fm12345');
    const g = (await app.inject({ method: 'GET', url: '/v1/events/e1/graph', headers: H(fm) })).json();
    for (const r of g.resources) expect(r.subscriberChannelIds).toBeUndefined();
    const w1 = await otpLogin('+972500000001');
    const gw = (await app.inject({ method: 'GET', url: '/v1/events/e1/graph', headers: H(w1) })).json();
    for (const r of gw.resources) expect(r.subscriberChannelIds).toBeUndefined();
    // admin still sees the full record
    const admin = await login('admin@camp.local', 'admin123');
    const ga = (await app.inject({ method: 'GET', url: '/v1/events/e1/graph', headers: H(admin) })).json();
    expect(ga.resources.some((r: { subscriberChannelIds?: string[] }) => (r.subscriberChannelIds?.length ?? 0) === 28)).toBe(true);
  });
});

describe('RT-PIN-4: graph.remove tombstones', () => {
  it('unassign mid-session: removed assignee gets exactly one in-sequence user-room tombstone, no siteId', async () => {
    const w2 = await otpLogin('+972500000002'); // linked r-g2, assignee of t4
    const { frames } = await connect(w2);
    const admin = await login('admin@camp.local', 'admin123');
    const res = await app.inject({
      method: 'PATCH', url: '/v1/tasks/t4', headers: H(admin),
      payload: { version: 1, assign: { assigneeResourceIds: ['r-grp', 'r-pool'] } },
    });
    expect(res.statusCode).toBe(200);
    await sleep(200);
    const tombstones = frames.filter(f => f.name === 'graph.remove');
    expect(tombstones.length).toBe(1);
    expect(tombstones[0]!.payload).toMatchObject({ type: 'graph.remove', eventId: 'e1', taskIds: ['t4'] });
    expect(tombstones[0]!.payload['siteId']).toBeUndefined();
    expect(tombstones[0]!.payload['version']).toBe((await repo.getEvent('e1'))!.version); // version AFTER the mutation
    // the removed task no longer arrives as an upsert for this user
    expect(frames.filter(f => f.name === 'graph.patch').length).toBe(0);
  });

  it('task delete: previous site room gets a siteId tombstone; admins get NO tombstone (full-snapshot reconcile)', async () => {
    await repo.createUser({ userId: 'u-fm2', orgId: 'org-1', name: 'רכז 2', role: 'field_manager', scopes: [{ eventId: 'e2', siteId: 'site-2' }], email: 'fm2@camp.local', passwordHash: hashPasswordPure('fm12345'), active: true });
    const fm2 = await login('fm2@camp.local', 'fm12345');
    const adminTok = await login('admin@camp.local', 'admin123');
    const site = await connect(fm2);
    const admin = await connect(adminTok);
    const res = await app.inject({ method: 'DELETE', url: '/v1/tasks/ta2', headers: H(adminTok) });
    expect(res.statusCode).toBe(200);
    await sleep(200);
    const siteTombstones = site.frames.filter(f => f.name === 'graph.remove');
    expect(siteTombstones.length).toBe(1);
    expect(siteTombstones[0]!.payload).toMatchObject({ type: 'graph.remove', eventId: 'e2', taskIds: ['ta2'], siteId: 'site-2' });
    expect(siteTombstones[0]!.payload['version']).toBe((await repo.getEvent('e2'))!.version);
    // admins: full patch frame only, never a tombstone
    expect(admin.frames.filter(f => f.name === 'graph.remove').length).toBe(0);
    expect(admin.frames.filter(f => f.name === 'graph.patch').length).toBeGreaterThan(0);
  });

  it('status-cancelled is NOT a removal: assignee gets an upsert patch, zero tombstones', async () => {
    const w2 = await otpLogin('+972500000002');
    const { frames } = await connect(w2);
    const admin = await login('admin@camp.local', 'admin123');
    const res = await app.inject({
      method: 'PATCH', url: '/v1/tasks/t4', headers: H(admin),
      payload: { version: 1, patch: { status: 'cancelled' } },
    });
    expect(res.statusCode).toBe(200);
    await sleep(200);
    expect(frames.filter(f => f.name === 'graph.remove').length).toBe(0);
    const patches = frames.filter(f => f.name === 'graph.patch');
    expect(patches.length).toBe(1);
    expect(patches[0]!.payload['eventId']).toBe('e1'); // QA-M35-1: frames carry eventId for the client guard
    const tasks = patches[0]!.payload['tasks'] as { id: string; status: string }[];
    expect(tasks.find(t => t.id === 't4')?.status).toBe('cancelled');
  });
});
