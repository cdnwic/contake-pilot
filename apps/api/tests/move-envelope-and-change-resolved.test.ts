/** TL ruling 2026-09-14: (a) floating-local move -> pinned 400, not 500;
 *  (c) change.resolved must reach user:{proposer} on BOTH approve and reject. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo } from './helpers/repo.js';
import { createRealtime, type Realtime } from '../src/realtime.js';
import { computeDomino, getProfile, type ChangeRequest } from '@contake/core';

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

describe('(a) floating-local move', () => {
  it('offset-less newStart -> 400, not 500', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const res = await app.inject({ method: 'PATCH', url: '/v1/tasks/t4', headers: H(admin), payload: { version: 1, move: { newStart: '2026-09-14T10:00:00' } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
  });

  it('task.create with a floating start -> 400, not 500 (same envelope class)', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const res = await app.inject({
      method: 'POST', url: '/v1/events/e1/tasks', headers: H(admin),
      payload: { task: { name: 'בדיקה', durationMin: 30, siteId: 'site-1', start: '2026-09-14T15:00:00' } },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('(c) change.resolved reaches the proposer', () => {
  const proposeFmMove = async (fm: string): Promise<string> => {
    const res = await app.inject({ method: 'PATCH', url: '/v1/tasks/t4', headers: H(fm), payload: { version: 1, move: { newStart: '2026-09-14T10:30:00+03:00' } } });
    const cr = res.json().changeRequest;
    if (!cr) throw new Error(`expected CR, got ${res.statusCode}: ${res.body}`);
    return cr.id as string;
  };

  it('admin REJECT -> proposer user room gets change.resolved with rejectionReasonHe', async () => {
    const fm = await login('fm@camp.local', 'fm12345');
    const { frames } = await connect(fm);
    const crId = await proposeFmMove(fm);
    const admin = await login('admin@camp.local', 'admin123');
    await app.inject({ method: 'POST', url: `/v1/changes/${crId}/reject`, headers: H(admin), payload: { reasonHe: 'לא מתאים' } });
    await sleep(600);
    const got = frames.filter(f => f.name === 'change.resolved');
    expect(got.length).toBe(1);
    expect((got[0]!.payload as { changeRequest: { id: string; state: string; rejectionReasonHe?: string } }).changeRequest).toMatchObject({ id: crId, state: 'rejected', rejectionReasonHe: 'לא מתאים' });
  });

  it('admin APPROVE -> proposer user room gets change.resolved', async () => {
    const fm = await login('fm@camp.local', 'fm12345');
    const { frames } = await connect(fm);
    const crId = await proposeFmMove(fm);
    const admin = await login('admin@camp.local', 'admin123');
    await app.inject({ method: 'POST', url: `/v1/changes/${crId}/approve`, headers: H(admin) });
    await sleep(600);
    const got = frames.filter(f => f.name === 'change.resolved');
    expect(got.length).toBe(1);
    expect((got[0]!.payload as { changeRequest: { id: string; state: string } }).changeRequest).toMatchObject({ id: crId, state: 'approved' });
  });
});

describe('v1.14 §12: change.resolved site-room targeting', () => {
  const addFm2 = async (): Promise<string> => {
    await repo.createUser({ userId: 'u-fm2', orgId: 'org-1', name: 'רכזת ב', role: 'field_manager', scopes: [{ eventId: 'e1', siteId: 'site-1' }], active: true });
    return auth.issueToken('u-fm2');
  };
  const admin = () => login('admin@camp.local', 'admin123');
  const fm = () => login('fm@camp.local', 'fm12345');
  const resolvedIn = (frames: Frame[]) => frames.filter(f => f.name === 'change.resolved');

  it('task-bound CR (move): affected task site room gets it; proposer (also site member) gets exactly ONE copy; focus worker gets nothing', async () => {
    const fmTok = await fm();
    const { frames: fmFrames } = await connect(fmTok);
    const { frames: fm2Frames } = await connect(await addFm2());
    const w = auth.issueToken('u-w1');
    const { frames: wFrames } = await connect(w);
    const res = await app.inject({ method: 'PATCH', url: '/v1/tasks/t4', headers: H(fmTok), payload: { version: 1, move: { newStart: '2026-09-14T10:30:00+03:00' } } });
    const crId = res.json().changeRequest.id as string;
    await app.inject({ method: 'POST', url: `/v1/changes/${crId}/approve`, headers: H(await admin()) });
    await sleep(600);
    expect(resolvedIn(fmFrames).length).toBe(1); // dedup: proposer is also in the site room
    expect(resolvedIn(fm2Frames).length).toBe(1); // non-proposer site manager
    expect(resolvedIn(wFrames).length).toBe(0); // focus worker (user room only)
  });

  it('event-level CR (event.update): NO site room - site manager non-proposer gets nothing, proposer gets it', async () => {
    const fmTok = await fm();
    const { frames: fmFrames } = await connect(fmTok);
    const { frames: fm2Frames } = await connect(await addFm2());
    const res = await app.inject({ method: 'PATCH', url: '/v1/events/e1', headers: H(fmTok), payload: { version: 1, patch: { name: 'יום קייטנה מעודכן' } } });
    const crId = res.json().changeRequest.id as string;
    await app.inject({ method: 'POST', url: `/v1/changes/${crId}/approve`, headers: H(await admin()) });
    await sleep(600);
    expect(resolvedIn(fmFrames).length).toBe(1);
    expect(resolvedIn(fm2Frames).length).toBe(0);
  });

  it('approved task.delete: task row is gone at emit time -> no site room (pinned fallback), proposer still gets it', async () => {
    const fmTok = await fm();
    const { frames: fmFrames } = await connect(fmTok);
    const { frames: fm2Frames } = await connect(await addFm2());
    const res = await app.inject({ method: 'DELETE', url: '/v1/tasks/t7', headers: H(fmTok) });
    const crId = res.json().changeRequest.id as string;
    await app.inject({ method: 'POST', url: `/v1/changes/${crId}/approve`, headers: H(await admin()) });
    await sleep(600);
    expect(resolvedIn(fmFrames).length).toBe(1);
    expect(resolvedIn(fm2Frames).length).toBe(0); // unresolvable siteId -> always-recipients only
  });

  it('dependency.create CR: site room of the FROM task (successor) gets it', async () => {
    const { frames: fm2Frames } = await connect(await addFm2());
    const snapshot = (await repo.snapshot('e1'))!;
    const change = { type: 'dependency.create', edge: { kind: 'depends_on', fromTaskId: 't7', toTaskId: 't3', lagMin: 0, hard: true } } as const;
    const dominoResult = computeDomino(snapshot, change as never, getProfile(snapshot.event.domainProfileId));
    const cr: ChangeRequest = {
      id: 'cr-dep-1', eventId: 'e1', baseGraphVersion: snapshot.event.version,
      proposedBy: 'u-admin', role: 'admin', change: change as never, dominoResult,
      state: 'pending_review', reasonHe: 'בדיקת תלות', createdAt: new Date().toISOString(),
    };
    await repo.createChangeRequest(cr);
    await app.inject({ method: 'POST', url: '/v1/changes/cr-dep-1/approve', headers: H(await admin()) });
    await sleep(600);
    expect(resolvedIn(fm2Frames).length).toBe(1); // t7 is site-1 -> event:e1:site:site-1
  });
});
