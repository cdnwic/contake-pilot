/** G2 stop-ship follow-up (QA 2026-09-17): the REAL server assembly
 *  (assembleServer - the same factory server.ts uses) in BOTH modes:
 *  exactly one DispatchStateStore, injected unconditionally into buildApp
 *  AND the sender; behavioral STOP->send-side suppression proof through
 *  the factory's own dispatcher; plus the race-linearization fence:
 *  a STOP committing between the batching-stage read and provider I/O
 *  blocks the provider call. Lanes: memory / PGlite / realpg. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import type { Queryable } from '../src/repo/postgres.js';
import { makeTestRepo, makeLaneQueryable, REPO_IMPL } from './helpers/repo.js';
import { assembleServer, type ServerAssembly } from '../src/server-assembly.js';
import { memoryDispatchState, type DispatchStateStore, type MessageProvider } from '../src/services/dispatch.js';

const AT = '2026-09-14T';
const mv = (h: string): string => `${AT}${h}:00+03:00`;
const STAFF = '+972500000001'; // unmodelled staff number: DispatchStateStore suppression path

interface SentCall { provider: string; to: string; body: string }
const okProvider = (name: 'whatsapp' | 'sms', calls: SentCall[]): MessageProvider => ({
  name, send: (to, body) => { calls.push({ provider: name, to, body }); return Promise.resolve({ ok: true, providerMessageId: `${name}-${calls.length}`, retryable: false }); },
});

let repo: GraphRepository;
let pool: Queryable | undefined;
let asm: ServerAssembly;
let calls: SentCall[];

beforeEach(async () => {
  process.env.CONTAKE_TEST_MODE = 'true';
  delete process.env.CONTAKE_INBOUND_SECRET;
  vi.useFakeTimers({ now: new Date('2026-09-14T12:00:00+03:00').getTime(), toFake: ['Date'] });
  repo = await makeTestRepo();
  // PG lanes: a pool/connectable over the lane's real backend => assemble in
  // "DATABASE_URL mode". Memory lane: no pool => in-memory mode.
  pool = await makeLaneQueryable();
  calls = [];
  asm = assembleServer({
    repo, auth: new AuthService(repo),
    providers: { whatsapp: okProvider('whatsapp', calls), sms: okProvider('sms', calls) },
    ...(pool ? { pool } : {}),
  });
  await asm.app.ready();
});
afterEach(async () => {
  delete process.env.CONTAKE_TEST_MODE;
  vi.useRealTimers();
  await asm.app.close();
});


const flagship = async (): Promise<void> => {
  const res = await asm.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@camp.local', password: 'admin123' } });
  const t = res.json().token as string;
  await asm.app.inject({ method: 'PATCH', url: '/v1/tasks/t1', headers: { authorization: `Bearer ${t}` }, payload: { version: 1, move: { newStart: mv('08:15') } } });
};
const stopInbound = (from: string) =>
  asm.app.inject({ method: 'POST', url: '/v1/webhooks/inbound', payload: { channel: 'whatsapp', receivingAccount: 'org-1', from, body: 'STOP' } });

describe('server assembly factory (REAL wiring, both modes)', () => {
  it('mode = ' + '(current lane)' + ': exactly ONE store - buildApp and the sender share the factory object', async () => {
    expect((asm.app as unknown as { dispatchState: DispatchStateStore }).dispatchState).toBe(asm.dispatchState);
    // The factory's OWN dispatcher (not a reconstructed one) consults the same store:
    await flagship();
    const res = await stopInbound(STAFF);
    expect(res.statusCode).toBe(200);
    expect(await asm.dispatchState.isSuppressed(STAFF)).toBe(true);
    const first = await asm.dispatcher.dispatchDue();
    vi.setSystemTime(new Date(Date.now() + 61_000));
    const second = await asm.dispatcher.dispatchDue();
    const out = [...first, ...second];
    expect(calls.some(c => c.to === STAFF)).toBe(false);
    expect(out.some(r => r.address === STAFF && r.status === 'suppressed_optout')).toBe(true);
    expect(calls.length).toBe(30);
  });

  it('memory-mode store when no pool is given (lane-independent factory contract)', () => {
    const local = assembleServer({
      repo, auth: new AuthService(repo),
      providers: { whatsapp: okProvider('whatsapp', []), sms: okProvider('sms', []) },
    });
    expect((local.app as unknown as { dispatchState: DispatchStateStore }).dispatchState).toBe(local.dispatchState);
    expect(typeof local.dispatchState.markSuppressed).toBe('function');
    return local.app.close();
  });
});

describe('race linearization fence (stronger contract)', () => {
  it('dispatch read UNSUPPRESSED, STOP commits before provider I/O -> provider call MUST NOT occur (fence)', async () => {
    await flagship();
    const { createDispatcher } = await import('../src/services/dispatch.js');
    let clock = Date.now();
    const base = asm.dispatchState;
    let armed = false;
    let fenceReadStarted!: () => void;
    const fenceRead = new Promise<void>(r => { fenceReadStarted = r; });
    let releaseFence!: () => void;
    const fenceHeld = new Promise<void>(r => { releaseFence = r; });
    const reads: boolean[] = [];
    const racing: DispatchStateStore = {
      ...base,
      isSuppressed: async (a: string) => {
        if (a === STAFF && armed) {
          if (reads.length === 0) { reads.push(false); return false; } // batching-stage: genuinely unsuppressed (STOP not yet committed)
          fenceReadStarted();           // the FENCE consult has begun
          await fenceHeld;              // hold it; the test commits STOP now
          const v = await base.isSuppressed(a);
          reads.push(v);
          return v;
        }
        return base.isSuppressed(a);
      },
    };
    const d = createDispatcher({ repo, providers: { whatsapp: okProvider('whatsapp', calls), sms: okProvider('sms', calls) }, now: () => clock, state: racing });
    await d.dispatchDue(); // pass 1: opens the 60s batch windows (unarmed)
    clock += 61_000;       // window now CLOSED: pass 2 proceeds past the batching stage
    armed = true;
    const pass = d.dispatchDue();
    await fenceRead;                        // deterministic: fence consult in flight
    const res = await stopInbound(STAFF);   // STOP commits BEFORE provider I/O
    expect(res.statusCode).toBe(200);
    releaseFence();
    const out = await pass;
    expect(calls.some(c => c.to === STAFF)).toBe(false); // provider NEVER called for STAFF
    expect(reads).toEqual([false, true]); // batching read unsuppressed; fence saw the committed STOP
    expect(out.some(r => r.address === STAFF && r.status === 'suppressed_optout')).toBe(true);
  });
});
