/** QA M3: fault injection through the REAL Twilio adapter (stubbed HTTP layer). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTwilioProvider, type TwilioHttpClient, type TwilioRequest } from '../src/services/twilio.js';
import { MemoryGraphRepository } from '../src/repo/memory.js';
import { seedDemo } from '../src/seed.js';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import { createDispatcher } from '../src/services/dispatch.js';

// Determinism (QA, same repair as the TL's baseline fix): server-side job BUILD
// reads the real wall clock for quiet hours; pin a daytime Date or these probes
// go red 22:00-07:00 local. Fake ONLY Date - timeouts stay real for backoff probes.
beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-09-14T12:00:00+03:00').getTime(), toFake: ['Date'] }); });
afterEach(() => { vi.useRealTimers(); });


const CFG = { accountSid: 'ACtest', authToken: 'tok', whatsappFrom: '+14155238886', smsFrom: '+15005550006' };
const errBody = (code: number, message: string) => JSON.stringify({ code, message });

it('TW-1: WA 500 (retryable) -> falls back to SMS after 3 attempts', async () => {
  const calls: { ch: string; to: string }[] = [];
  const waHttp: TwilioHttpClient = (req: TwilioRequest) => { calls.push({ ch: 'wa', to: req.form['To']! }); return Promise.resolve({ status: 500, body: errBody(30007, 'server error') }); };
  const smsHttp: TwilioHttpClient = (req: TwilioRequest) => { calls.push({ ch: 'sms', to: req.form['To']! }); return Promise.resolve({ status: 201, body: JSON.stringify({ sid: 'SM1' }) }) };
  const repo = MemoryGraphRepository.seeded(seedDemo());
  const app = buildApp(repo, new AuthService(repo)); await app.ready();
  const admin = (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@camp.local', password: 'admin123' } })).json().token as string;
  await app.inject({ method: 'PATCH', url: '/v1/tasks/t1', headers: { authorization: `Bearer ${admin}` }, payload: { version: 1, move: { newStart: '2026-09-14T08:15:00+03:00' } } });
  let clock = Date.parse('2026-09-14T12:00:00+03:00');
  const d = createDispatcher({ repo, providers: { whatsapp: createTwilioProvider('whatsapp', CFG, waHttp), sms: createTwilioProvider('sms', CFG, smsHttp) }, now: () => clock });
  await d.dispatchDue(); clock += 61_000;
  const recs = await d.dispatchDue();
  const wa = calls.filter(c => c.ch === 'wa').length; const sms = calls.filter(c => c.ch === 'sms').length;
  console.log('TW-1 wa calls:', wa, 'sms calls:', sms, 'sent:', recs.filter(r => r.status === 'sent' || r.status === 'batched').length, 'all via sms:', recs.filter(r => r.provider === 'sms').length);
  await app.close();
  expect(wa).toBe(31 * 3); // 3 attempts per recipient
  expect(sms).toBe(31);
  expect(recs.filter(r => (r.status === 'sent' || r.status === 'batched') && r.provider === 'sms').length).toBe(31);
});

it('TW-2: 429 with Retry-After: 2 -> injectable sleep observed 2000ms before retry', async () => {
  const sleeps: number[] = [];
  let n = 0;
  const http: TwilioHttpClient = () => { n++; return Promise.resolve(n === 1 ? { status: 429, body: errBody(20429, 'rate limit'), headers: { 'retry-after': '2' } } : { status: 201, body: JSON.stringify({ sid: 'SM2' }) }); };
  const repo = MemoryGraphRepository.seeded(seedDemo());
  repo.createNotificationJob({ id: 'j1', eventId: 'e1', kind: 'task_moved', targets: [{ channel: 'sms', address: '+97252100001', recipientLabel: 'x' }], templateKey: 'task_moved', params: { taskName: 'x', newStart: '2026-09-14T10:00:00+03:00', summaryHe: 'x' }, idempotencyKey: 'k1', batchWindowSec: 60 });
  let clock = Date.parse('2026-09-14T12:00:00+03:00');
  const d = createDispatcher({ repo, providers: { whatsapp: createTwilioProvider('whatsapp', CFG, http), sms: createTwilioProvider('sms', CFG, http) }, now: () => clock, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } });
  await d.dispatchDue(); clock += 61_000;
  await d.dispatchDue();
  console.log('TW-2 sleeps:', sleeps, 'provider calls:', n);
  expect(sleeps).toEqual([2000]);
  expect(n).toBe(2);
});

it('TW-3: 21211 invalid number -> non-retryable, exactly 1 call per provider, terminal failure audited', async () => {
  let waCalls = 0; let smsCalls = 0;
  const waHttp: TwilioHttpClient = () => { waCalls++; return Promise.resolve({ status: 400, body: errBody(21211, 'invalid To') }); };
  const smsHttp: TwilioHttpClient = () => { smsCalls++; return Promise.resolve({ status: 400, body: errBody(21211, 'invalid To') }); };
  const repo = MemoryGraphRepository.seeded(seedDemo());
  repo.createNotificationJob({ id: 'j2', eventId: 'e1', kind: 'task_moved', targets: [{ channel: 'whatsapp', address: '+97252100099', recipientLabel: 'x' }], templateKey: 'task_moved', params: { taskName: 'x', newStart: '2026-09-14T10:00:00+03:00', summaryHe: 'x' }, idempotencyKey: 'k2', batchWindowSec: 60 });
  let clock = Date.parse('2026-09-14T12:00:00+03:00');
  const d = createDispatcher({ repo, providers: { whatsapp: createTwilioProvider('whatsapp', CFG, waHttp), sms: createTwilioProvider('sms', CFG, smsHttp) }, now: () => clock });
  await d.dispatchDue(); clock += 61_000;
  const recs = await d.dispatchDue();
  const auditRows = (await repo.listAudit('org-1')).filter(a => (a.afterJson ?? '').includes('"failed"'));
  console.log('TW-3 wa calls:', waCalls, 'sms calls:', smsCalls, 'failed records:', recs.filter(r => r.status === 'failed').length, 'audit rows:', auditRows.length);
  expect(waCalls).toBe(1);
  expect(smsCalls).toBe(1);
  expect(recs.filter(r => r.status === 'failed').length).toBe(1);
  expect(auditRows.length).toBe(1);
});

it('TW-4: adapter never sends credentials in the form body; auth header is Basic of env values', async () => {
  let seen: TwilioRequest | undefined;
  const http: TwilioHttpClient = (req) => { seen = req; return Promise.resolve({ status: 201, body: '{}' }); };
  const p = createTwilioProvider('whatsapp', CFG, http);
  await p.send('+97252100001', 'hello');
  expect(seen!.authorization).toBe(`Basic ${Buffer.from('ACtest:tok').toString('base64')}`);
  expect(JSON.stringify(seen!.form)).not.toContain('tok');
  expect(seen!.form['To']).toBe('whatsapp:+97252100001');
});

it('TW-5 (spec v1.6): UNKNOWN Twilio code -> NON-retryable loud failure, exactly 1 HTTP call, no fallback attempt', async () => {
  let calls = 0;
  const http: TwilioHttpClient = async () => { calls += 1; return { status: 400, body: errBody(29999, 'future Twilio error') }; };
  const p = createTwilioProvider('whatsapp', CFG, http);
  const r = await p.send('+972500000000', 'x');
  expect(r).toMatchObject({ ok: false, retryable: false, error: 'future Twilio error' });
  expect(calls).toBe(1);
});
