import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import { MemoryGraphRepository } from '../src/repo/memory.js';
import { seedDemo } from '../src/seed.js';
import { createRealtime, type Realtime } from '../src/realtime.js';

let app: FastifyInstance; let repo: MemoryGraphRepository; let rt: Realtime; let url: string;
const clients: ClientSocket[] = [];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
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
const H = (t: string) => ({ authorization: `Bearer ${t}` });

it('PROBE-A3: FM site frame must not carry subscriberChannelIds', async () => {
  const fmTok = await login('fm@camp.local', 'fm12345');
  const frames: any[] = [];
  const socket = ioc(url, { auth: { token: fmTok }, transports: ['websocket'], reconnection: false });
  clients.push(socket);
  socket.on('graph.patch', p => frames.push(p));
  await new Promise<void>((res, rej) => { socket.on('connect', () => res()); socket.on('connect_error', e => rej(e)); });
  const admin = await login('admin@camp.local', 'admin123');
  const res = await app.inject({ method: 'PATCH', url: '/v1/tasks/t1', headers: H(admin), payload: { version: 1, move: { newStart: '2026-09-14T08:15:00+03:00' } } });
  console.log('PATCH status:', res.statusCode);
  await sleep(400);
  console.log('frames:', frames.length);
  const siteFrames = frames.filter(f => f.siteId);
  console.log('site frames:', siteFrames.length);
  if (siteFrames[0]) {
    const rs = siteFrames[0].resources as any[];
    const withCh = rs.filter(r => (r.subscriberChannelIds?.length ?? 0) > 0);
    console.log('resources:', rs.length, 'with channel ids:', withCh.map(r => `${r.id}:${r.subscriberChannelIds.length}`));
    expect(withCh.length, 'subscriber channel ids leak into field_manager frame').toBe(0);
  }
});
