/** QA-ADV web push probes (QA-owned; G5 AC-PUSH gaps): multi-device + cross-org
 *  silence (AC-2), quiet-hours class behavior (AC-4), endpoint/keys leak sweep
 *  (AC-6), the 20/min mutation throttle, and enqueue-retry idempotency. */
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { NotificationJob, PushSubscription } from '@contake/core';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo } from './helpers/repo.js';
import { createDispatcher, type PushPayload, type WebPushProvider } from '../src/services/dispatch.js';

let repo: GraphRepository; let app: FastifyInstance;
beforeEach(async () => { repo = await makeTestRepo(); app = buildApp(repo, new AuthService(repo)); await app.ready(); });
const login = async (e: string, p: string) => (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: e, password: p } })).json().token as string;
const H = (t: string) => ({ authorization: `Bearer ${t}` });
const addSub = (userId: string, orgId: string, endpoint: string) => repo.upsertPushSubscription({
  id: `psub-${endpoint}`, orgId, userId, endpoint, keys: { p256dh: 'k', auth: 'a' }, createdAt: new Date().toISOString(),
});
const seedJob = (key: string, targets: NotificationJob['targets'], extra?: Partial<NotificationJob>) => repo.createNotificationJob({
  id: `j-${key}`, eventId: 'e1', kind: 'task_moved', templateKey: 'task_moved',
  params: { taskName: 'בריכה', newStart: '2026-09-14T10:00:00+03:00', summaryHe: 'אפקט דומינו: 1 משימות (בריכה)' },
  targets, idempotencyKey: key, batchWindowSec: 60, ...extra,
} as NotificationJob);
const spyProvider = (behavior: (sub: PushSubscription, payload: PushPayload) => { ok: boolean; retryable: boolean; gone?: boolean; error?: string }) => {
  const calls: { sub: PushSubscription; payload: PushPayload }[] = [];
  const provider: WebPushProvider = { name: 'web_push', send: (sub, payload) => { calls.push({ sub, payload }); return Promise.resolve(behavior(sub, payload)); } };
  return { provider, calls };
};
const makeDispatcher = (provider: WebPushProvider, nowRef: { t: number }) => createDispatcher({
  repo,
  providers: {
    whatsapp: { name: 'whatsapp', send: () => Promise.resolve({ ok: true, retryable: false }) },
    sms: { name: 'sms', send: () => Promise.resolve({ ok: true, retryable: false }) },
  },
  push: provider, now: () => nowRef.t,
});
const IN_APP_ADMIN = [{ channel: 'in_app', address: 'u-admin', recipientLabel: 'דנה מנהלת' }] as NotificationJob['targets'];

describe('QA-ADV web push', () => {
  it('ADV-P2 (AC-PUSH-2): two devices of one user both receive; other users (same org AND other org) stay silent', async () => {
    await addSub('u-admin', 'org-1', 'https://push.example/a1');
    await addSub('u-admin', 'org-1', 'https://push.example/a2');
    await addSub('u-w1', 'org-1', 'https://push.example/w1');
    await addSub('u-admin-b', 'org-2', 'https://push.example/b1');
    await seedJob('k-adv2', IN_APP_ADMIN);
    const nowRef = { t: Date.now() };
    const { provider, calls } = spyProvider(() => ({ ok: true, retryable: false }));
    const d = makeDispatcher(provider, nowRef);
    await d.dispatchDue();
    nowRef.t += 61_000;
    await d.dispatchDue();
    const endpoints = calls.map(c => c.sub.endpoint).sort();
    expect(endpoints).toEqual(['https://push.example/a1', 'https://push.example/a2']); // both own devices
    expect(calls.every(c => c.sub.userId === 'u-admin')).toBe(true); // nobody else, same org or not
  });

  it('ADV-P4 (AC-PUSH-4): internal push goes out at 23:55 (no quiet-hours hold); a held job synthesizes NO push while held', async () => {
    await addSub('u-admin', 'org-1', 'https://push.example/q1');
    await seedJob('k-adv4a', IN_APP_ADMIN); // internal class — never held
    await seedJob('k-adv4b', IN_APP_ADMIN, { holdUntil: '2026-09-15T07:00:00+03:00' }); // held until morning
    const nowRef = { t: Date.parse('2026-09-14T23:55:00+03:00') };
    const { provider, calls } = spyProvider(() => ({ ok: true, retryable: false }));
    const d = makeDispatcher(provider, nowRef);
    await d.dispatchDue();
    nowRef.t += 61_000; // 23:56 — inside quiet hours
    await d.dispatchDue();
    expect(calls.length).toBe(1); // only the unheld internal job produced push
    expect(calls.every(c => c.sub.endpoint === 'https://push.example/q1')).toBe(true);
    // after the hold expires, the held job dispatches and its push flows
    nowRef.t = Date.parse('2026-09-15T07:01:00+03:00');
    await d.dispatchDue();
    nowRef.t += 61_000;
    await d.dispatchDue();
    expect(calls.length).toBe(2);
  });

  it('ADV-P6 (AC-PUSH-6): no endpoint/keys leak — list is owner-only, graph/notification surfaces carry no push material', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const fm = await login('fm@camp.local', 'fm12345');
    await addSub('u-admin', 'org-1', 'https://push.example/secret-endpoint');
    const own = await app.inject({ method: 'GET', url: '/v1/push/subscriptions', headers: H(admin) });
    expect(own.statusCode).toBe(200);
    expect(own.body).toContain('secret-endpoint'); // owner sees own
    const other = await app.inject({ method: 'GET', url: '/v1/push/subscriptions', headers: H(fm) });
    expect(other.statusCode).toBe(200);
    expect(other.body).not.toContain('secret-endpoint');
    expect(other.body).not.toContain('p256dh');
    // sweep user-facing surfaces as a non-owner
    for (const url of ['/v1/events/e1/graph', '/v1/notifications?eventId=e1', '/v1/audit?eventId=e1']) {
      const r = await app.inject({ method: 'GET', url, headers: H(admin) });
      expect(r.body).not.toContain('secret-endpoint');
      expect(r.body).not.toContain('p256dh');
    }
  });

  it('ADV-P9: mutation throttle — 21st POST inside a minute is 429, GET is not throttled', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (await app.inject({ method: 'POST', url: '/v1/push/subscriptions', headers: H(admin), payload: { endpoint: `https://push.example/t${i}`, keys: { p256dh: 'k', auth: 'a' } } })).statusCode;
    }
    expect(last).toBe(429);
    const list = await app.inject({ method: 'GET', url: '/v1/push/subscriptions', headers: H(admin) });
    expect(list.statusCode).toBe(200);
  });

  it('ADV-P10: enqueue retry with the same idempotency key never duplicates the push', async () => {
    await addSub('u-admin', 'org-1', 'https://push.example/i1');
    await seedJob('k-adv10', IN_APP_ADMIN);
    await seedJob('k-adv10', IN_APP_ADMIN).catch(() => undefined); // retry of the same enqueue (may reject or dedupe)
    const nowRef = { t: Date.now() };
    const { provider, calls } = spyProvider(() => ({ ok: true, retryable: false }));
    const d = makeDispatcher(provider, nowRef);
    await d.dispatchDue();
    await d.dispatchDue(); // dispatcher re-run before window
    nowRef.t += 61_000;
    await d.dispatchDue();
    await d.dispatchDue(); // and after — hasDispatched guard must hold
    expect(calls.length).toBe(1);
  });
});
