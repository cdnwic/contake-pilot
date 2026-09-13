/** QA FE v13.0 live E2E (G5 part 2 gate): the REAL v13 push client modules
 *  (push.ts/session.ts/liveApi.ts) against the live webpush backend — subscribe
 *  through a stubbed PushManager, list through the REAL server envelope, dispatch
 *  fanout delivers to the FE-registered device with the spec payload shape, and
 *  the 410 cleanup path is observed through the FE client. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { NotificationJob, PushSubscription } from '@contake/core';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo } from './helpers/repo.js';
import { createDispatcher, type PushPayload, type WebPushProvider } from '../src/services/dispatch.js';

process.env['VAPID_PUBLIC_KEY'] = 'BEl96i0Tm2yqK9vZ8xJ3kQ7wN1sR4tU6vX8yA0bC2dE4fG6hI8jK0lM2nO4pQ6rS8tU0vW2xY4zA6bC8dE0fG2';
delete process.env['VAPID_PRIVATE_KEY']; // log-sandbox provider stays; nothing leaves the process

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k), clear: () => store.clear(),
};
(globalThis as any).window = { location: { search: '?api=live', href: '', pathname: '/' } };

const ENDPOINT = 'https://push.example.test/sub/fe13-device-A';
const SUB = { endpoint: ENDPOINT, toJSON: () => ({ keys: { p256dh: 'k'.repeat(88), auth: 'a'.repeat(24) } }), unsubscribe: async () => true };
const swReg = { pushManager: { subscribe: async () => SUB, getSubscription: async () => SUB } };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', serviceWorker: { register: async () => swReg } }, configurable: true });

const FE = '/home/sandbox/qa-workspace/frontend-v13/pkg-v13/src/api';
const live = await import(`${FE}/liveApi.ts`);
const sess = await import(`${FE}/session.ts`);
const push = await import(`${FE}/push.ts`);

let repo: GraphRepository; let app: FastifyInstance; let base = '';
beforeEach(async () => {
  // pglite's emscripten loader sniffs `typeof window === 'object'` and takes its
  // browser path (window.location/encodeURIComponent); hide the FE stub while the
  // PG repo initializes, then restore it for the FE client modules.
  const w = (globalThis as any).window; delete (globalThis as any).window;
  repo = await makeTestRepo();
  (globalThis as any).window = w;
  app = buildApp(repo, new AuthService(repo));
  await app.ready();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const a = app.server.address(); base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  store.clear(); store.set('contake-api-url', base); store.set('contake-api', 'live');
  push.resetPushCachesForTests();
  const v = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@camp.local', password: 'admin123' } });
  sess.saveSession({ token: v.json().token, principal: v.json().principal });
});
afterEach(async () => { await app.close(); });

const seedJob = (key: string): Promise<NotificationJob> => repo.createNotificationJob({
  id: `j-${key}`, eventId: 'e1', kind: 'task_moved', templateKey: 'task_moved',
  params: { taskName: 'בריכה', newStart: '2026-09-14T10:00:00+03:00', summaryHe: 'אפקט דומינו: 1 משימות תלויות יזוזו (בריכה)' },
  targets: [{ channel: 'in_app', address: 'u-admin', recipientLabel: 'דנה מנהלת' }],
  idempotencyKey: key, batchWindowSec: 60,
} as NotificationJob);
const spy = (behavior: () => { ok: boolean; retryable: boolean; gone?: boolean; error?: string }) => {
  const calls: { sub: PushSubscription; payload: PushPayload }[] = [];
  const provider: WebPushProvider = { name: 'web_push', send: (sub, payload) => { calls.push({ sub, payload }); return Promise.resolve(behavior()); } };
  return { provider, calls };
};
const makeDispatcher = (provider: WebPushProvider, nowRef: { t: number }) =>
  createDispatcher({ repo, providers: {
    whatsapp: { name: 'whatsapp', send: () => Promise.resolve({ ok: true, retryable: false }) },
    sms: { name: 'sms', send: () => Promise.resolve({ ok: true, retryable: false }) },
  }, push: provider, now: () => nowRef.t });

describe('FE v13.0 push live E2E', () => {
  it('E2E-P1: FE subscribePush -> server upsert; listSubscriptions parses the REAL {subscriptions} envelope; toggle OFF deletes', async () => {
    const ep = await push.subscribePush();
    expect(ep).toBe(ENDPOINT);
    expect(await repo.getPushSubscriptionByEndpoint(ENDPOINT)).toBeTruthy(); // landed server-side
    const devices = await push.listSubscriptions(); // real server response, FE envelope parsing
    expect(devices.map(d => d.endpoint)).toEqual([ENDPOINT]);
    expect(devices[0]!.keys.p256dh).toBe('k'.repeat(88));
    await push.unsubscribePush();
    expect(await push.listSubscriptions()).toEqual([]);
    expect(await repo.getPushSubscriptionByEndpoint(ENDPOINT)).toBeUndefined();
  });

  it('E2E-P2: dispatch fanout delivers to the FE-registered device with the spec payload shape after the batch window', async () => {
    await push.subscribePush();
    await seedJob('fe13-batch');
    const nowRef = { t: Date.now() };
    const { provider, calls } = spy(() => ({ ok: true, retryable: false }));
    const d = makeDispatcher(provider, nowRef);
    await d.dispatchDue();
    expect(calls.length).toBe(0); // batch window holds push; in_app immediate
    nowRef.t += 61_000;
    await d.dispatchDue();
    expect(calls.length).toBe(1);
    expect(calls[0]!.sub.endpoint).toBe(ENDPOINT); // the device the FE client registered
    expect(calls[0]!.payload.title).toBe('יום קייטנה');
    expect(typeof calls[0]!.payload.body).toBe('string');
    expect(calls[0]!.payload.body.length).toBeGreaterThan(0);
    expect(calls[0]!.payload.data.kind).toBe('task_moved');
    expect(calls[0]!.payload.data.url).toBe('/focus');
  });

  it('E2E-P3: 410 gone -> server deletes the subscription; the FE client observes the cleanup', async () => {
    await push.subscribePush();
    expect((await push.listSubscriptions()).length).toBe(1);
    await seedJob('fe13-gone');
    const nowRef = { t: Date.now() };
    const { provider, calls } = spy(() => ({ ok: false, retryable: false, gone: true, error: 'gone (410)' }));
    const d = makeDispatcher(provider, nowRef);
    await d.dispatchDue();
    nowRef.t += 61_000;
    await d.dispatchDue();
    expect(calls.length).toBe(1); // exactly one attempt, never retried
    expect(await repo.getPushSubscriptionByEndpoint(ENDPOINT)).toBeUndefined();
    expect(await push.listSubscriptions()).toEqual([]); // cleanup visible through the real FE client
  });
});
