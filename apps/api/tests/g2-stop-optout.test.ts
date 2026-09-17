import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo } from './helpers/repo.js';
import { createDispatcher, type DispatchStateStore, type MessageProvider } from '../src/services/dispatch.js';

let app: FastifyInstance;
let repo: GraphRepository;
const AT = '2026-09-14T';
const mv = (h: string): string => `${AT}${h}:00+03:00`;

interface SentCall { provider: string; to: string; body: string; }
const okProvider = (name: 'whatsapp' | 'sms', calls: SentCall[]): MessageProvider => ({
  name,
  send: (to, body) => { calls.push({ provider: name, to, body }); return Promise.resolve({ ok: true, providerMessageId: `${name}-${calls.length}`, retryable: false }); },
});

const login = async (email: string, password: string): Promise<string> => {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });
  return res.json().token as string;
};
const H = (t: string): { authorization: string } => ({ authorization: `Bearer ${t}` });

const state = (): DispatchStateStore => (app as unknown as { dispatchState: DispatchStateStore }).dispatchState;

beforeEach(async () => {
  // Carried onto the post-merge route (v1.20.2 §25.1א fail-closed): same
  // harness convention as v1.20-builder.test.ts - explicit test mode, no
  // configured secret. Assertions unchanged.
  process.env.CONTAKE_TEST_MODE = 'true';
  delete process.env.CONTAKE_INBOUND_SECRET;
  // Same determinism pin as dispatch.test.ts: job-BUILD quiet-hours logic reads
  // the wall clock; fake ONLY Date.
  vi.useFakeTimers({ now: new Date('2026-09-14T12:00:00+03:00').getTime(), toFake: ['Date'] });
  repo = await makeTestRepo();
  app = buildApp(repo, new AuthService(repo));
  await app.ready();
});
afterEach(() => {
  delete process.env.CONTAKE_TEST_MODE;
  vi.useRealTimers();
});

const flagship = async (): Promise<void> => {
  const admin = await login('admin@camp.local', 'admin123');
  await app.inject({ method: 'PATCH', url: '/v1/tasks/t1', headers: H(admin), payload: { version: 1, move: { newStart: mv('08:15') } } });
};

describe('G2 — inbound STOP opt-out wired through the HTTP route (v1.20.2 consent/suppression machinery)', () => {
  it('G2-1: webhook STOP on a modelled channel opts it out and blocks subsequent sends', async () => {
    await flagship(); // queues the 31-recipient flagship batch incl. channel +97252100001
    const res = await app.inject({ method: 'POST', url: '/v1/webhooks/inbound', payload: { channel: 'whatsapp', receivingAccount: 'org-1', from: '+97252100001', body: 'STOP' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().handled).toBe(1);
    expect((await repo.findChannelByAddress('+97252100001'))?.optedOut).toBe(true);
    const calls: SentCall[] = [];
    let clock = Date.now();
    const d = createDispatcher({ repo, providers: { whatsapp: okProvider('whatsapp', calls), sms: okProvider('sms', calls) }, now: () => clock, state: state() });
    const first = await d.dispatchDue(); // opt-out evaluation precedes batching: suppression records emit on this pass
    clock += 61_000;
    const second = await d.dispatchDue();
    const out = [...first, ...second];
    expect(calls.some(c => c.to === '+97252100001')).toBe(false); // STOP blocks the send
    expect(out.some(r => r.address === '+97252100001' && r.status === 'suppressed_optout')).toBe(true);
    expect(calls.length).toBe(30); // every other recipient unaffected
  });

  it('G2-2: webhook STOP (Hebrew) on an unmodelled staff number records suppression and blocks subsequent sends', async () => {
    await flagship(); // staff +972500000001 is a real dispatch recipient with NO channel record
    expect(await repo.findChannelByAddress('+972500000001')).toBeUndefined();
    const res = await app.inject({ method: 'POST', url: '/v1/webhooks/inbound', payload: { channel: 'whatsapp', receivingAccount: 'org-1', from: '+972500000001', body: 'הסרה' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().handled).toBe(1);
    expect(await state().isSuppressed('+972500000001')).toBe(true); // suppression recorded via handleInboundStop
    const calls: SentCall[] = [];
    let clock = Date.now();
    const d = createDispatcher({ repo, providers: { whatsapp: okProvider('whatsapp', calls), sms: okProvider('sms', calls) }, now: () => clock, state: state() });
    const first = await d.dispatchDue();
    clock += 61_000;
    const second = await d.dispatchDue();
    const out = [...first, ...second];
    expect(calls.some(c => c.to === '+972500000001')).toBe(false); // blocked
    expect(out.some(r => r.address === '+972500000001' && r.status === 'suppressed_optout')).toBe(true);
    expect(calls.length).toBe(30);
  });

  it('G2-3: non-STOP inbound does not touch suppression or channels', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/webhooks/inbound', payload: { channel: 'whatsapp', receivingAccount: 'org-1', from: '+97252100001', body: 'שלום' } });
    expect(res.json().handled).toBe(0);
    expect(await state().isSuppressed('+97252100001')).toBe(false);
    expect((await repo.findChannelByAddress('+97252100001'))?.optedOut).not.toBe(true);
  });
});
