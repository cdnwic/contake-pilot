/** Web push (contracts v1.10, web-push-spec §8): AC-PUSH-1/2/3/5/7/8 backend probes. */
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { NotificationJob, PushSubscription } from '@contake/core';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo } from './helpers/repo.js';
import { appEvents, type AppEvent } from '../src/services/events.js';
import { createDispatcher, type PushPayload, type WebPushProvider } from '../src/services/dispatch.js';

let repo: GraphRepository;
let app: FastifyInstance;
beforeEach(async () => {
  repo = await makeTestRepo();
  app = buildApp(repo, new AuthService(repo));
  await app.ready();
});
const login = async (e: string, p: string) => (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: e, password: p } })).json().token as string;
const H = (t: string) => ({ authorization: `Bearer ${t}` });
const subBody = (endpoint: string) => ({ endpoint, keys: { p256dh: 'k'.repeat(88), auth: 'a'.repeat(24) } });

const seedJob = (key: string): Promise<NotificationJob> => repo.createNotificationJob({
  id: `j-${key}`, eventId: 'e1', kind: 'task_moved', templateKey: 'task_moved',
  params: { taskName: 'בריכה', newStart: '2026-09-14T10:00:00+03:00', summaryHe: 'אפקט דומינו: 1 משימות תלויות יזוזו (בריכה)' },
  targets: [{ channel: 'in_app', address: 'u-admin', recipientLabel: 'דנה מנהלת' }],
  idempotencyKey: key, batchWindowSec: 60,
} as NotificationJob);

const spyProvider = (behavior: (sub: PushSubscription, payload: PushPayload) => { ok: boolean; retryable: boolean; gone?: boolean; error?: string }) => {
  const calls: { sub: PushSubscription; payload: PushPayload }[] = [];
  const provider: WebPushProvider = {
    name: 'web_push',
    send: (sub, payload) => { calls.push({ sub, payload }); return Promise.resolve(behavior(sub, payload)); },
  };
  return { provider, calls };
};

describe('AC-PUSH-1/2/7: subscription routes', () => {
  it('subscribe is idempotent per endpoint; list shows own subs only', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const r1 = await app.inject({ method: 'POST', url: '/v1/push/subscriptions', headers: H(admin), payload: subBody('https://push.example/ep-1') });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({ method: 'POST', url: '/v1/push/subscriptions', headers: H(admin), payload: subBody('https://push.example/ep-1') });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().subscription.id).toBe(r1.json().subscription.id); // same record, no duplicate
    const list = (await app.inject({ method: 'GET', url: '/v1/push/subscriptions', headers: H(admin) })).json().subscriptions;
    expect(list.length).toBe(1);
    const other = await login('admin@film.local', 'admin123');
    const otherList = (await app.inject({ method: 'GET', url: '/v1/push/subscriptions', headers: H(other) })).json().subscriptions;
    expect(otherList.length).toBe(0); // no cross-user visibility
  });

  it('every subscription mutation is audited (QA §9)', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    await app.inject({ method: 'POST', url: '/v1/push/subscriptions', headers: H(admin), payload: subBody('https://push.example/ep-a') });
    await app.inject({ method: 'DELETE', url: '/v1/push/subscriptions', headers: H(admin), payload: { endpoint: 'https://push.example/ep-a' } });
    const rows = (await repo.listAudit('org-1')).filter(r => r.entityType === 'push_subscription');
    expect(rows.map(r => r.action).sort()).toEqual(['push.subscribe', 'push.unsubscribe']);
  });

  it('cross-user subscribe/delete is 403 + v1.9 denied audit', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const other = await login('admin@film.local', 'admin123');
    await app.inject({ method: 'POST', url: '/v1/push/subscriptions', headers: H(admin), payload: subBody('https://push.example/ep-x') });
    const rSub = await app.inject({ method: 'POST', url: '/v1/push/subscriptions', headers: H(other), payload: subBody('https://push.example/ep-x') });
    expect(rSub.statusCode).toBe(403);
    const rDel = await app.inject({ method: 'DELETE', url: '/v1/push/subscriptions', headers: H(other), payload: { endpoint: 'https://push.example/ep-x' } });
    expect(rDel.statusCode).toBe(403);
    const denied = (await repo.listAudit('org-2')).filter(r => r.outcome === 'denied' && r.entityType === 'push_subscription');
    expect(denied.length).toBe(2);
    expect(denied.every(r => r.denialReason === 'scope_violation')).toBe(true);
    expect((await repo.listPushSubscriptions('u-admin')).length).toBe(1); // untouched
  });

  it('vapid public key endpoint is authenticated and reflects env', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const res = await app.inject({ method: 'GET', url: '/v1/push/vapid-public-key', headers: H(admin) });
    expect(res.statusCode).toBe(200);
    expect(res.json().publicKey).toBe(process.env['VAPID_PUBLIC_KEY'] ?? null);
    const anon = await app.inject({ method: 'GET', url: '/v1/push/vapid-public-key' });
    expect(anon.statusCode).toBe(401);
  });
});

describe('AC-PUSH-2/3/5/8: dispatch fanout', () => {
  const registerSub = async (endpoint: string) => {
    await repo.upsertPushSubscription({
      id: `psub-${endpoint}`, orgId: 'org-1', userId: 'u-admin', endpoint,
      keys: { p256dh: 'k', auth: 'a' }, createdAt: new Date().toISOString(),
    });
  };
  const makeDispatcher = (provider: WebPushProvider, nowRef: { t: number }) =>
    createDispatcher({ repo, providers: {
      whatsapp: { name: 'whatsapp', send: () => Promise.resolve({ ok: true, retryable: false }) },
      sms: { name: 'sms', send: () => Promise.resolve({ ok: true, retryable: false }) },
    }, push: provider, now: () => nowRef.t });

  it('delivers to a registered device after the 60s batch window; in_app stays immediate', async () => {
    await registerSub('https://push.example/d1');
    await seedJob('k-batch-1');
    const nowRef = { t: Date.now() };
    const { provider, calls } = spyProvider(() => ({ ok: true, retryable: false }));
    const d = makeDispatcher(provider, nowRef);
    const first = await d.dispatchDue();
    expect(calls.length).toBe(0); // window just opened — push waits
    expect(first.some(r => r.address === 'u-admin' && r.status === 'sent')).toBe(true); // in_app immediate
    nowRef.t += 61_000;
    const second = await d.dispatchDue();
    expect(calls.length).toBe(1);
    expect(calls[0]!.payload.data.kind).toBe('task_moved');
    expect(calls[0]!.payload.data.url).toBe('/focus');
    expect(calls[0]!.payload.title).toBe('יום קייטנה');
    expect(second.some(r => r.provider === 'web_push' && r.status === 'sent')).toBe(true);
  });

  it('AC-PUSH-3: two changes inside the window collapse into ONE digest push', async () => {
    await registerSub('https://push.example/d2');
    await seedJob('k-digest-a');
    await seedJob('k-digest-b');
    const nowRef = { t: Date.now() };
    const { provider, calls } = spyProvider(() => ({ ok: true, retryable: false }));
    const d = makeDispatcher(provider, nowRef);
    await d.dispatchDue();
    nowRef.t += 61_000;
    await d.dispatchDue();
    expect(calls.length).toBe(1);
    expect(calls[0]!.payload.data.kind).toBe('digest_multi_change');
  });

  it('AC-PUSH-5: 404/410 marks the subscription dead — deleted, never retried', async () => {
    await registerSub('https://push.example/dead');
    await seedJob('k-gone');
    const nowRef = { t: Date.now() };
    const { provider, calls } = spyProvider(() => ({ ok: false, retryable: false, gone: true, error: 'gone (410)' }));
    const d = makeDispatcher(provider, nowRef);
    await d.dispatchDue();
    nowRef.t += 61_000;
    await d.dispatchDue();
    expect(calls.length).toBe(1); // exactly one attempt
    expect(await repo.getPushSubscriptionByEndpoint('https://push.example/dead')).toBeUndefined();
  });

  it('AC-PUSH-5: unknown codes are non-retryable (v1.6) — single attempt, failed record', async () => {
    await registerSub('https://push.example/weird');
    await seedJob('k-weird');
    const nowRef = { t: Date.now() };
    const { provider, calls } = spyProvider(() => ({ ok: false, retryable: false, error: 'weird provider code' }));
    const d = makeDispatcher(provider, nowRef);
    await d.dispatchDue();
    nowRef.t += 61_000;
    const out = await d.dispatchDue();
    expect(calls.length).toBe(1);
    expect(out.some(r => r.address === 'push:u-admin' && r.status === 'failed')).toBe(true);
  });

  it('AC-PUSH-8: push failure never raises notify.failed when in_app delivered', async () => {
    await registerSub('https://push.example/f1');
    await seedJob('k-fail');
    const nowRef = { t: Date.now() };
    const { provider } = spyProvider(() => ({ ok: false, retryable: false, error: 'down' }));
    const d = makeDispatcher(provider, nowRef);
    const frames: AppEvent[] = [];
    const un = appEvents.subscribe(e => { if (e.type === 'notify.failed') frames.push(e); });
    await d.dispatchDue();
    nowRef.t += 61_000;
    await d.dispatchDue();
    un();
    expect(frames.length).toBe(0);
  });
});
