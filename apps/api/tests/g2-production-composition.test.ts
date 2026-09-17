/** G2 stop-ship repair (QA 2026-09-17): production composition proof.
 *  Defect: buildApp kept a PRIVATE in-memory DispatchStateStore for the
 *  inbound webhook STOP path while server.ts's send-side dispatcher used
 *  the durable pgDispatchState(pool) - production sends never saw STOP
 *  suppressions and a restart wiped them.
 *  Fix: buildApp accepts an injected store; server.ts injects its durable
 *  one. These proofs mirror the server composition: ONE store, minted
 *  first, injected into buildApp AND the send-side dispatcher.
 *  Lanes: memory / PGlite / realpg (via makeLaneDispatchState). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo, makeLaneDispatchState, REPO_IMPL } from './helpers/repo.js';
import { createDispatcher, type DispatchStateStore, type MessageProvider } from '../src/services/dispatch.js';

let app: FastifyInstance;
let repo: GraphRepository;
let store: DispatchStateStore;
const AT = '2026-09-14T';
const mv = (h: string): string => `${AT}${h}:00+03:00`;
const STAFF = '+972500000001'; // unmodelled staff number: the DispatchStateStore suppression path

interface SentCall { provider: string; to: string; body: string }
const okProvider = (name: 'whatsapp' | 'sms', calls: SentCall[]): MessageProvider => ({
  name, send: (to, body) => { calls.push({ provider: name, to, body }); return Promise.resolve({ ok: true, providerMessageId: `${name}-${calls.length}`, retryable: false }); },
});

beforeEach(async () => {
  process.env.CONTAKE_TEST_MODE = 'true';
  delete process.env.CONTAKE_INBOUND_SECRET;
  vi.useFakeTimers({ now: new Date('2026-09-14T12:00:00+03:00').getTime(), toFake: ['Date'] });
  repo = await makeTestRepo();
  store = await makeLaneDispatchState(); // ONE durable store, minted first - like server.ts
  app = buildApp(repo, new AuthService(repo), { dispatchState: store });
  await app.ready();
});
afterEach(() => { delete process.env.CONTAKE_TEST_MODE; vi.useRealTimers(); });

const flagship = async (target: FastifyInstance = app): Promise<void> => {
  const res = await target.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@camp.local', password: 'admin123' } });
  const t = res.json().token as string;
  const r2 = await target.inject({ method: 'PATCH', url: '/v1/tasks/t1', headers: { authorization: `Bearer ${t}` }, payload: { version: 1, move: { newStart: mv('08:15') } } });
};
const stopInbound = (from: string) =>
  app.inject({ method: 'POST', url: '/v1/webhooks/inbound', payload: { channel: 'whatsapp', receivingAccount: 'org-1', from, body: 'STOP' } });
const sendSide = (calls: SentCall[], s: DispatchStateStore) => {
  let clock = Date.now();
  const d = createDispatcher({ repo, providers: { whatsapp: okProvider('whatsapp', calls), sms: okProvider('sms', calls) }, now: () => clock, state: s });
  return { d, tick: () => { clock += 61_000; } };
};

describe('production composition: ONE injected durable store', () => {
  it('P1: buildApp uses the INJECTED store (identity) and a webhook STOP on an unmodelled staff number blocks the send-side dispatcher', async () => {
    expect((app as unknown as { dispatchState: DispatchStateStore }).dispatchState).toBe(store);
    await flagship(); // queues the 31-recipient batch incl. STAFF
    const res = await stopInbound(STAFF);
    expect(res.statusCode).toBe(200);
    expect(await store.isSuppressed(STAFF)).toBe(true); // durable store, not a private memory one
    const calls: SentCall[] = [];
    const { d, tick } = sendSide(calls, store); // send-side over the SAME store
    const first = await d.dispatchDue(); tick();
    const second = await d.dispatchDue();
    const out = [...first, ...second];
    expect(calls.some(c => c.to === STAFF)).toBe(false);
    expect(out.some(r => r.address === STAFF && r.status === 'suppressed_optout')).toBe(true);
    expect(calls.length).toBe(30); // all other recipients unaffected
  });

  it('P2: STOP-before-send - suppression committed before the batch is due blocks the very first dispatch pass', async () => {
    const res = await stopInbound(STAFF); // STOP lands BEFORE flagship queues anything
    expect(res.statusCode).toBe(200);
    await flagship();
    const calls: SentCall[] = [];
    const { d, tick } = sendSide(calls, store);
    const first = await d.dispatchDue(); tick();
    const second = await d.dispatchDue();
    expect(calls.some(c => c.to === STAFF)).toBe(false);
    expect([...first, ...second].some(r => r.address === STAFF && r.status === 'suppressed_optout')).toBe(true);
  });

  // Memory lane skipped on purpose: an in-memory store CANNOT survive a
  // restart by design - durability is exactly what the PG lanes prove here.
  it.skipIf(REPO_IMPL === 'memory')('P3: restart over the SAME database - a fresh store instance + fresh app still honor the suppression', async () => {
    await stopInbound(STAFF);
    expect(await store.isSuppressed(STAFF)).toBe(true);
    await app.close();
    // "restart": NEW store instance + NEW app over the SAME durable backend (no wipe)
    const store2 = await makeLaneDispatchState();
    const app2 = buildApp(repo, new AuthService(repo), { dispatchState: store2 });
    await app2.ready();
    expect(await store2.isSuppressed(STAFF)).toBe(true); // survived the restart
    await flagship(app2);
    const calls: SentCall[] = [];
    const { d, tick } = sendSide(calls, store2);
    const first = await d.dispatchDue(); tick();
    const second = await d.dispatchDue();
    expect(calls.some(c => c.to === STAFF)).toBe(false);
    expect([...first, ...second].some(r => r.address === STAFF && r.status === 'suppressed_optout')).toBe(true);
    await app2.close();
  });

  it('P4: STOP-vs-dispatch race - a suppression COMMITTING while dispatchDue is mid-evaluation still blocks the send', async () => {
    await flagship();
    // Wrap the durable store: the send-side suppression READ for STAFF is
    // held until the concurrent STOP write has committed. Whatever wins, the
    // send decision must consult the store AFTER the STOP commit.
    let releaseRead!: () => void;
    const readHeld = new Promise<void>(r => { releaseRead = r; });
    let stopCommitted = false;
    const racing: DispatchStateStore = {
      ...store,
      isSuppressed: async (a: string) => {
        if (a === STAFF && !stopCommitted) await readHeld;
        return store.isSuppressed(a);
      },
    };
    const calls: SentCall[] = [];
    const { d } = sendSide(calls, racing);
    const pass = d.dispatchDue(); // starts evaluating; STAFF read is held
    const res = await stopInbound(STAFF); // concurrent STOP commits now
    expect(res.statusCode).toBe(200);
    stopCommitted = true;
    releaseRead();
    const out = await pass;
    expect(calls.some(c => c.to === STAFF)).toBe(false);
    expect(out.some(r => r.address === STAFF && r.status === 'suppressed_optout')).toBe(true);
  });
});
