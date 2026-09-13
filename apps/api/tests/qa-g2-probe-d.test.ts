/** QA G2 probes — QA-M2-4 (plan rev cc7502eb): fault injection on dispatch + audit layer. */
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import { MemoryGraphRepository } from '../src/repo/memory.js';
import { seedDemo } from '../src/seed.js';
import { createDispatcher, type MessageProvider } from '../src/services/dispatch.js';

let app: FastifyInstance; let repo: MemoryGraphRepository;
const mv = (h: string): string => `2026-09-14T${h}:00+03:00`;
const login = async (e: string, p: string) => (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: e, password: p } })).json().token as string;
const H = (t: string) => ({ authorization: `Bearer ${t}` });
beforeEach(async () => {
  repo = MemoryGraphRepository.seeded(seedDemo());
  app = buildApp(repo, new AuthService(repo));
  await app.ready();
});

describe('QA-M2-4 fault injection', () => {
  it('P-D1: terminal dispatch failure must be written to audit', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    await app.inject({ method: 'PATCH', url: '/v1/tasks/t1', headers: H(admin), payload: { version: 1, move: { newStart: mv('08:15') } } });
    const down: MessageProvider = { name: 'whatsapp', send: () => Promise.resolve({ ok: false, retryable: true, error: 'down' }) };
    const downSms: MessageProvider = { name: 'sms', send: () => Promise.resolve({ ok: false, retryable: true, error: 'down' }) };
    let fake = Date.now();
    const d = createDispatcher({ repo, providers: { whatsapp: down, sms: downSms }, now: () => fake });
    await d.dispatchDue(); // tick 1: opens the 60s recipient batch windows (ND-3)
    fake += 61_000; // advance past window close so jobs become dispatchable
    const recs = await d.dispatchDue();
    const failed = recs.filter(r => r.status === 'failed').length;
    console.log('P-D1 dispatch records:', recs.length, 'failed:', failed);
    expect(failed, 'no jobs dispatched at all — batch window or probe setup wrong').toBeGreaterThan(0);
    const audit = await repo.listAudit('org-1');
    const failEntries = audit.filter(a => a.action === 'notify.dispatch' || /notify|dispatch/i.test(a.entityType + a.action));
    console.log('P-D1 audit entries total:', audit.length, 'failure-related:', failEntries.length);
    expect(failEntries.length, 'terminal dispatch failure left no audit trail').toBeGreaterThan(0);
  });

  it('P-D2: audit-write failure must fail the mutation loudly (no silent apply)', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const orig = repo.appendAudit.bind(repo);
    let injected = true;
    repo.appendAudit = ((e: never) => { if (injected) throw new Error('disk full'); orig(e); }) as typeof repo.appendAudit;
    const res = await app.inject({ method: 'PATCH', url: '/v1/tasks/t7', headers: H(admin), payload: { version: 1, move: { newStart: mv('14:30') } } });
    console.log('P-D2 status with failing audit:', res.statusCode);
    injected = false;
    const task = (await repo.snapshot('e1'))!.tasks.find(t => t.id === 't7')!;
    console.log('P-D2 task start after request:', task.start);
    if (res.statusCode >= 500) {
      // client saw a loud failure: the mutation must NOT have applied
      expect(task.start, 'mutation applied even though the client got a loud failure').toBe(mv('14:00'));
    } else {
      expect(res.statusCode, 'audit-write failure was swallowed silently').toBeGreaterThanOrEqual(500);
    }
  });

  it('P-D3: DELETE /v1/events/:id actually deletes the event', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const res = await app.inject({ method: 'DELETE', url: '/v1/events/e2', headers: H(admin) });
    console.log('P-D3 delete status:', res.statusCode, 'event e2 still exists:', await repo.getEvent('e2') !== undefined);
    expect(await repo.getEvent('e2'), 'event reported deleted but still in repo').toBeUndefined();
  });
});
