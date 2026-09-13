/** QA G3 vs FE v12.0 "session": drive the REAL FE v12 realtime client against the server.
 *  v12 change: socket + REST authenticate with the OTP/password session token (session.ts),
 *  no dev auto-auth. This probe acquires REAL sessions from the live server first. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import { MemoryGraphRepository } from '../src/repo/memory.js';
import { seedDemo } from '../src/seed.js';
import { createRealtime, type Realtime } from '../src/realtime.js';
import { createDispatcher, type MessageProvider } from '../src/services/dispatch.js';

let app: FastifyInstance; let repo: MemoryGraphRepository; let rt: Realtime; let base = '';
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k), clear: () => store.clear(),
};
(globalThis as any).window = { location: { search: '', href: '' } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const FE = '/home/sandbox/qa-workspace/frontend-v12/pkg-v12/src/api';
const live = await import(`${FE}/liveApi.ts`);
const fert = await import(`${FE}/realtime.ts`);
const sess = await import(`${FE}/session.ts`);

type Session = { token: string; principal: { userId: string; role: string } };
const adminSession = async (): Promise<Session> =>
  (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@camp.local', password: 'admin123' } })).json() as Session;
const fwSession = async (): Promise<Session> => {
  const req = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: '+972500000001' } });
  return (await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: '+972500000001', code: req.json().devCode } })).json() as Session;
};

beforeEach(async () => {
  repo = MemoryGraphRepository.seeded(seedDemo());
  app = buildApp(repo, new AuthService(repo));
  await app.ready();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const a = app.server.address(); base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  store.set('contake-api-url', base);
  (globalThis as any).location = { origin: base, href: base + '/', protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1:' + (typeof a === 'object' && a ? a.port : 0), port: String(typeof a === 'object' && a ? a.port : 0) };
  rt = createRealtime(app.server, repo, new AuthService(repo), { revalidateMs: 120 });
});
afterEach(async () => { await rt.close(); await app.close(); });

const login = async (e: string, p: string) => (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: e, password: p } })).json().token as string;
const H = (t: string) => ({ authorization: `Bearer ${t}` });

describe('FE v12 session realtime client vs server', () => {
  it('G3-RT-1: admin vs focus_worker isolation through the real client (session auth)', async () => {
    const adminEvents: string[] = []; const focusEvents: string[] = [];
    sess.saveSession(await adminSession());
    const offA = await fert.connectRealtime('admin', { onServerChange: () => adminEvents.push('x'), onNotifyFailed: () => {} });
    sess.saveSession(await fwSession());
    const offF = await fert.connectRealtime('focus_worker', { onServerChange: () => focusEvents.push('x'), onNotifyFailed: () => {} });
    await sleep(200);
    const admin = await login('admin@camp.local', 'admin123');
    await app.inject({ method: 'PATCH', url: '/v1/tasks/t4', headers: H(admin), payload: { version: 1, move: { newStart: '2026-09-14T10:00:00+03:00' } } });
    await sleep(250);
    expect(adminEvents.length).toBeGreaterThan(0);
    expect(focusEvents.length).toBe(0);
    await app.inject({ method: 'PATCH', url: '/v1/tasks/t7', headers: H(admin), payload: { version: 1, move: { newStart: '2026-09-14T15:00:00+03:00' } } });
    await sleep(250);
    expect(focusEvents.length).toBeGreaterThan(0);
    offA(); offF();
  });

  it('G3-RT-2: notify.failed reaches admin client, not focus worker (session auth)', async () => {
    const adminFails: unknown[] = []; const focusFails: unknown[] = [];
    sess.saveSession(await adminSession());
    const offA = await fert.connectRealtime('admin', { onServerChange: () => {}, onNotifyFailed: f => adminFails.push(f) });
    sess.saveSession(await fwSession());
    const offF = await fert.connectRealtime('focus_worker', { onServerChange: () => {}, onNotifyFailed: f => focusFails.push(f) });
    await sleep(200);
    const admin = await login('admin@camp.local', 'admin123');
    await app.inject({ method: 'PATCH', url: '/v1/tasks/t1', headers: H(admin), payload: { version: 1, move: { newStart: '2026-09-14T08:15:00+03:00' } } });
    let clock = Date.parse('2026-09-14T12:00:00+03:00');
    const down: MessageProvider = { name: 'whatsapp', send: () => Promise.resolve({ ok: false, retryable: true, error: 'sandbox down' }) };
    const downSms: MessageProvider = { name: 'sms', send: () => Promise.resolve({ ok: false, retryable: true, error: 'sandbox down' }) };
    const d = createDispatcher({ repo, providers: { whatsapp: down, sms: downSms }, now: () => clock });
    await d.dispatchDue(); clock += 61_000; await d.dispatchDue();
    await sleep(300);
    expect(adminFails.length).toBeGreaterThan(0);
    expect((adminFails[0] as { error?: string }).error).toBe('sandbox down');
    expect(focusFails.length).toBe(0);
    offA(); offF();
  });

  it('G3-RT-1b: no session -> AUTH_REQUIRED (no dev-auth backdoor through the client)', async () => {
    sess.clearSession();
    await expect(fert.connectRealtime('admin', { onServerChange: () => {}, onNotifyFailed: () => {} })).rejects.toThrow('AUTH_REQUIRED');
  });
});

it('G3-RT-4 (QA-G3-2): real outage -> banner state false, reconnect fires resync exactly once per outage (session auth)', async () => {
  const states: boolean[] = []; let resyncs = 0;
  sess.saveSession(await adminSession());
  const off = await fert.connectRealtime('admin', {
    onServerChange: () => {}, onNotifyFailed: () => {},
    onStateChange: (c: boolean) => states.push(c),
    onReconnect: () => { resyncs++; },
  });
  await sleep(600);
  expect(states).toEqual([true]);
  expect(resyncs).toBe(0);
  const port = Number(base.split(':').pop());
  await rt.close(); await app.close();
  const t0 = Date.now();
  while (!states.includes(false) && Date.now() - t0 < 8000) await sleep(100);
  expect(states).toContain(false);
  const downCount = states.filter(x => !x).length;
  repo = MemoryGraphRepository.seeded(seedDemo());
  app = buildApp(repo, new AuthService(repo));
  await app.ready();
  await app.listen({ port, host: '127.0.0.1' });
  rt = createRealtime(app.server, repo, new AuthService(repo), { revalidateMs: 120 });
  const t1 = Date.now();
  while (resyncs < 1 && Date.now() - t1 < 20000) await sleep(150);
  expect(resyncs).toBe(1);
  expect(states[states.length - 1]).toBe(true);
  expect(states.filter(x => !x).length).toBe(downCount);
  await rt.close(); await app.close();
  const t2 = Date.now();
  while (states.filter(x => !x).length < downCount + 1 && Date.now() - t2 < 8000) await sleep(100);
  repo = MemoryGraphRepository.seeded(seedDemo());
  app = buildApp(repo, new AuthService(repo));
  await app.ready();
  await app.listen({ port, host: '127.0.0.1' });
  rt = createRealtime(app.server, repo, new AuthService(repo), { revalidateMs: 120 });
  const t3 = Date.now();
  while (resyncs < 2 && Date.now() - t3 < 20000) await sleep(150);
  expect(resyncs).toBe(2);
  off();
}, 60000);
