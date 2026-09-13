import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import { MemoryGraphRepository } from '../src/repo/memory.js';
import { seedDemo } from '../src/seed.js';
import { createDispatcher, type MessageProvider } from '../src/services/dispatch.js';

let app: FastifyInstance; let repo: MemoryGraphRepository;
const mv = (h: string): string => `2026-09-14T${h}:00+03:00`;
const T0 = Date.parse('2026-09-14T12:00:00+03:00');
beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-09-14T12:00:00+03:00').getTime(), toFake: ['Date'] }); });
afterEach(() => { vi.useRealTimers(); });
beforeEach(async () => {
  repo = MemoryGraphRepository.seeded(seedDemo());
  app = buildApp(repo, new AuthService(repo));
  await app.ready();
});
const login = async () => (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@camp.local', password: 'admin123' } })).json().token as string;
const H = (t: string) => ({ authorization: `Bearer ${t}` });
const flagship = async () => { const a = await login(); await app.inject({ method: 'PATCH', url: '/v1/tasks/t1', headers: H(a), payload: { version: 1, move: { newStart: mv('08:15') } } }); };

describe('M2.1 verification probes', () => {
  it('PROBE-C2: window opens on first change; closes at 60s with ONE merged digest', async () => {
    let clock = T0;
    const admin = await login();
    const calls: { to: string; body: string }[] = [];
    const okP = (name: 'whatsapp' | 'sms'): MessageProvider => ({ name, send: (to: string, body: string) => { calls.push({ to, body }); return Promise.resolve({ ok: true as const, retryable: false }); } });
    await app.inject({ method: 'PATCH', url: '/v1/tasks/t7', headers: H(admin), payload: { version: 1, move: { newStart: mv('14:30') } } });
    const d = createDispatcher({ repo, providers: { whatsapp: okP('whatsapp'), sms: okP('sms') }, now: () => clock });
    await d.dispatchDue(); // tick 1: window opens, nothing sends
    expect(calls.length).toBe(0);
    clock += 10_000; // +10s: second change lands inside the window
    await app.inject({ method: 'PATCH', url: '/v1/tasks/t7', headers: H(admin), payload: { version: 2, move: { newStart: mv('14:45') } } });
    await d.dispatchDue();
    expect(calls.length).toBe(0); // still collecting
    clock += 51_000; // +61s: window closed
    await d.dispatchDue();
    const toW1 = calls.filter(c => c.to === '+972500000001');
    console.log('PROBE-C2 messages after close:', toW1.length, 'digest?', toW1[0]?.body.includes('2 שינויים'));
    expect(toW1.length).toBe(1);
    expect(toW1[0]!.body).toContain('2 שינויים');
  });

  it('PROBE-D1v2: terminal dispatch failure is audited (after window close)', async () => {
    let clock = T0;
    await flagship();
    const down: MessageProvider = { name: 'whatsapp', send: () => Promise.resolve({ ok: false, retryable: true, error: 'down' }) };
    const downSms: MessageProvider = { name: 'sms', send: () => Promise.resolve({ ok: false, retryable: true, error: 'down' }) };
    const d = createDispatcher({ repo, providers: { whatsapp: down, sms: downSms }, now: () => clock });
    await d.dispatchDue(); // windows open
    clock += 61_000;
    const recs = await d.dispatchDue(); // close + fail terminally
    const failed = recs.filter(r => r.status === 'failed');
    console.log('PROBE-D1v2 failed:', failed.length);
    expect(failed.length).toBe(31);
    const auditRows = (await repo.listAudit('org-1')).filter(a => /notify/.test(a.action + a.entityType));
    const failRows = auditRows.filter(a => (a.afterJson ?? '').includes('"failed"'));
    console.log('PROBE-D1v2 audit notify rows:', auditRows.length, 'failure rows:', failRows.length);
    expect(failRows.length).toBeGreaterThan(0);
    // Tower surface: admin can read them via /v1/audit
    const admin = await login();
    const res = await app.inject({ method: 'GET', url: '/v1/audit?eventId=e1', headers: H(admin) });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('failed');
  });
});
