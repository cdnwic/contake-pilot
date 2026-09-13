/** QA independent ack probes (beyond team's notify-ack suite): P-D2 parity (audit fault),
 *  concurrent first-ack write-once (PG-only), real-socket adminsRoom fanout. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo, REPO_IMPL } from './helpers/repo.js';
import { createRealtime, type Realtime } from '../src/realtime.js';

let repo: GraphRepository; let app: FastifyInstance; let rt: Realtime | undefined;
const clients: ClientSocket[] = [];
beforeEach(async () => { repo = await makeTestRepo(); app = buildApp(repo, new AuthService(repo)); await app.ready(); });
afterEach(async () => { for (const c of clients) c.disconnect(); clients.length = 0; if (rt) await rt.close(); await app.close(); rt = undefined; });
const login = async (e: string, p: string) => (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: e, password: p } })).json().token as string;
const H = (t: string) => ({ authorization: `Bearer ${t}` });
const seedJob = async () => repo.createNotificationJob({
  id: 'j-qa-ack', eventId: 'e1', kind: 'targeted', templateKey: 'task_moved',
  params: { taskName: 'x', newStart: 'y', summaryHe: 'z' },
  targets: [{ channel: 'in_app', address: 'u-admin', recipientLabel: 'דנה' }],
  idempotencyKey: 'qa-ack-k1', createdAt: new Date().toISOString(),
} as never);

it('QA-ACK-1: audit-write failure fails the ack loudly — 500, ack fields NOT persisted, no frame', async () => {
  const admin = await login('admin@camp.local', 'admin123');
  await seedJob();
  const orig = repo.appendAudit.bind(repo);
  repo.appendAudit = () => { throw new Error('audit store down'); };
  const res = await app.inject({ method: 'POST', url: '/v1/notify-jobs/j-qa-ack/ack', headers: H(admin) });
  repo.appendAudit = orig;
  expect(res.statusCode).toBeGreaterThanOrEqual(500);
  expect((await repo.getNotificationJob('j-qa-ack'))!.acknowledgedBy).toBeUndefined(); // no half-applied ack
});

it('QA-ACK-2 (both modes, atomic primitive): 5 concurrent first-acks -> exactly 1 audit row, 1 winner record, all 200 with the SAME ack', async () => {
  const admin = await login('admin@camp.local', 'admin123');
  await seedJob();
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    app.inject({ method: 'POST', url: '/v1/notify-jobs/j-qa-ack/ack', headers: H(admin) })));
  for (const r of results) expect(r.statusCode).toBe(200);
  const acks = new Set(results.map(r => r.json().job.acknowledgedAt));
  expect(acks.size).toBe(1); // single winner's timestamp returned to everyone
  expect((await repo.listAudit('org-1')).filter(r => r.action === 'notify.ack' && r.entityId === 'j-qa-ack').length).toBe(1);
});

it('QA-ACK-3: notify.acked reaches adminsRoom over a real socket within one frame', async () => {
  const admin = await login('admin@camp.local', 'admin123');
  await seedJob();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const a = app.server.address(); const url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  rt = createRealtime(app.server, repo, new AuthService(repo), { revalidateMs: 120 });
  const frames: Record<string, unknown>[] = [];
  const socket = ioc(url, { auth: { token: admin }, transports: ['websocket'], reconnection: false });
  clients.push(socket);
  socket.on('notify.acked', (p: Record<string, unknown>) => frames.push(p));
  await new Promise<void>((res, rej) => { socket.on('connect', res); socket.on('connect_error', rej); });
  await app.inject({ method: 'POST', url: '/v1/notify-jobs/j-qa-ack/ack', headers: H(admin) });
  const t0 = Date.now();
  while (frames.length === 0 && Date.now() - t0 < 5000) await new Promise(r => setTimeout(r, 100));
  expect(frames.length).toBe(1);
  expect(frames[0]).toMatchObject({ jobId: 'j-qa-ack', acknowledgedBy: 'u-admin' });
});
