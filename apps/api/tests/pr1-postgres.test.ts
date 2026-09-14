/** PR-1 Postgres adapter acceptance: the three hard requirements that motivated
 *  the swap, exercised against the real adapter on PGlite. Runs only under
 *  REPO_IMPL=postgres; the carried suites (which run in both modes) cover parity. */
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PostgresGraphRepository, createPgOtpState, pgDispatchState, pgliteConnectable } from '../src/repo/postgres.js';
import { AuthService } from '../src/auth.js';
import { createDispatcher, type MessageProvider } from '../src/services/dispatch.js';
import { applySeed, seedDemo } from '../src/seed.js';
import { REPO_IMPL } from './helpers/repo.js';

const run = REPO_IMPL === 'postgres' ? describe : describe.skip;

run('PR-1 Postgres adapter (PGlite, real transactions)', () => {
  let liveDb: PGlite | undefined; // bound live WASM instances per file
  const make = async () => {
    await liveDb?.close().catch(() => undefined);
    liveDb = new PGlite();
    const db = pgliteConnectable(liveDb);
    const repo = await PostgresGraphRepository.create(db);
    await applySeed(repo, seedDemo());
    return { db, repo };
  };

  it('(a) withAuditSafety: audit-write failure rolls the whole mutation back (real ROLLBACK)', async () => {
    const { repo } = await make();
    const before = (await repo.getTask('t1'))!;
    await expect(repo.runInTx!(async () => {
      await repo.applyTaskUpdates([{ id: 't1', expectedVersion: before.version, patch: { start: '2026-09-14T08:00:00+03:00' } }]);
      await repo.appendAudit({ seq: 1, orgId: 'org-1', eventId: 'e1', actorUserId: 'u-admin', role: 'admin', action: 'task.move', entityType: 'task', entityId: 't1', at: new Date().toISOString() } as never);
      throw new Error('audit store down'); // same failure QA-M2-6 injects
    })).rejects.toThrow('audit store down');
    expect((await repo.getTask('t1'))!).toEqual(before); // mutation rolled back
    expect(await repo.listAudit('org-1')).toEqual([]); // audit write rolled back too
  });

  it('(b) version sequencing: concurrent bumpEventVersion loses cleanly, never double-applies', async () => {
    const { repo } = await make();
    const ev = (await repo.getEvent('e1'))!;
    const [a, b] = await Promise.all([
      repo.bumpEventVersion('e1', ev.version),
      repo.bumpEventVersion('e1', ev.version),
    ]);
    expect([a, b].sort()).toEqual([false, true]); // exactly one wins
    expect((await repo.getEvent('e1'))!.version).toBe(ev.version + 1);
  });

  it('(b) applyTaskUpdates is all-or-nothing under a stale version mid-batch', async () => {
    const { repo } = await make();
    const t1 = (await repo.getTask('t1'))!;
    const t2 = (await repo.getTask('t2'))!;
    const ok = await repo.applyTaskUpdates([
      { id: 't1', expectedVersion: t1.version, patch: { start: '2026-09-14T08:00:00+03:00' } },
      { id: 't2', expectedVersion: t2.version + 99, patch: { start: '2026-09-14T08:05:00+03:00' } },
    ]);
    expect(ok).toBe(false);
    expect((await repo.getTask('t1'))!).toEqual(t1); // first update rolled back
    expect((await repo.getTask('t2'))!).toEqual(t2);
  });

  it('(c) dispatch state survives a dispatcher restart (sent keys, batch windows, suppressions)', async () => {
    const { db, repo } = await make();
    const state = pgDispatchState(db);
    const sends: string[] = [];
    const provider: MessageProvider = { name: 'whatsapp', send: async to => { sends.push(to); return { ok: true, retryable: false }; } };
    await repo.createNotificationJob({
      id: 'j1', eventId: 'e1', kind: 'targeted', templateKey: 'task_moved',
      params: { taskName: 'x', newStart: 'y', summaryHe: 'z' },
      targets: [{ channel: 'whatsapp', address: '+97252100001', recipientLabel: 'p' }],
      idempotencyKey: 'k1', createdAt: new Date().toISOString(),
    } as never);

    let clock = 1_000;
    const d1 = createDispatcher({ repo, providers: { whatsapp: provider, sms: provider }, now: () => clock, state });
    await d1.dispatchDue(); // opens the 60s batch window, sends nothing yet
    expect(sends).toEqual([]);
    // "restart": brand-new dispatcher, SAME durable state
    const d2 = createDispatcher({ repo, providers: { whatsapp: provider, sms: provider }, now: () => clock, state });
    await d2.dispatchDue(); // window still open across the restart
    expect(sends).toEqual([]);
    clock += 61_000;
    await d2.dispatchDue(); // window closes -> sends
    expect(sends).toEqual(['+97252100001']);
    // second restart: the sent key survives, so no duplicate send
    const d3 = createDispatcher({ repo, providers: { whatsapp: provider, sms: provider }, now: () => clock, state });
    await d3.dispatchDue();
    expect(sends).toEqual(['+97252100001']);
    // suppression survives too: a fresh store over the same database still sees it
    expect(await d3.handleInboundStop('+97252100999')).toBe(1);
    const state2 = pgDispatchState(db);
    expect(await state2.isSuppressed('+97252100999')).toBe(true);
  });

  it('(d) whitelist auth_audit + entries persist on the real adapter (QA integrity gate)', async () => {
    const { db, repo } = await make();
    // whitelist store on PG: upsert/get/list
    await repo.upsertWhitelistEntry({ phone: '+972500100001', status: 'approved', orgId: 'org-1', assignedRole: 'admin', createdAt: new Date().toISOString() });
    await repo.upsertWhitelistEntry({ phone: '+972500100002', status: 'pending_approval', orgId: 'org-1', displayName: 'x', createdAt: new Date().toISOString() });
    expect((await repo.getWhitelistEntry('+972500100001'))!.status).toBe('approved');
    expect((await repo.listWhitelist('org-1', 'pending_approval')).map(e => e.phone)).toEqual(['+972500100002']);
    // upsert on phone is idempotent reset (re-invite)
    await repo.upsertWhitelistEntry({ phone: '+972500100002', status: 'invited', orgId: 'org-1', createdAt: new Date().toISOString() });
    expect((await repo.getWhitelistEntry('+972500100002'))!.status).toBe('invited');
    // auth_audit channel: appendWhitelistAudit lands durable rows with all fields
    const otp = await createPgOtpState(db);
    const auth = new AuthService(repo, undefined, undefined, otp);
    await auth.appendWhitelistAudit('+972500100002', 'whitelist.register', { outcome: 'success', reasonCode: 'pending_approval', deviceClass: 'desktop', requestId: '42' });
    const rows = await otp.listAuthAudit('+972500100002');
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe('whitelist.register');
    expect((rows[0]!.detail as { reasonCode?: string }).reasonCode).toBe('pending_approval');
    expect(rows[0]!.createdAt).toBeTruthy();
  });
});
