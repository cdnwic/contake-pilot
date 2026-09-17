/** Super Admin impersonation LIFECYCLE gate (QA 2026-09-17):
 *  explicit session metadata (createdAt/expiresAt, 15-minute server-side
 *  TTL) enforced on EVERY auth; atomic active -> stopped|expired|revoked
 *  transitions with immutable audit; crash/no-stop, restart and boundary
 *  behavior; tenant-safe paginated listing + audited revoke-by-id;
 *  storage-level unique normalized user phone with concurrent-enrollment
 *  and cross-tenant collision proofs. Inactive identities/audits are
 *  PRESERVED (no deletion). Synthetic phone numbers only.
 *  Runs in all lanes (REPO_IMPL=memory / postgres [PGlite] / realpg). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.hoisted(() => { process.env['CONTAKE_SUPER_ADMIN_PHONES'] = '+15550100001,+15550100002'; });

import { buildApp } from '../src/app.js';
import { AuthService, SANDBOX_SESSION_TTL_MS } from '../src/auth.js';
import type { GraphRepository, UserRecord } from '../src/repo/graph-repository.js';
import { makeTestRepo, REPO_IMPL } from './helpers/repo.js';
import { SUPERADMIN_SANDBOX_ORG } from '../src/services/superadmin.js';

let repo: GraphRepository;
let app: FastifyInstance;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-17T12:00:00.000Z'));
  repo = await makeTestRepo();
  app = buildApp(repo, new AuthService(repo));
  await app.ready();
});
afterEach(async () => { await app.close(); vi.useRealTimers(); });

const H = (t: string) => ({ authorization: `Bearer ${t}` });
const SA1 = '+15550100001';
const SA2 = '+15550100002';
const otpLogin = async (phone: string) => {
  const q = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone } });
  return (await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code: q.json().devCode } })).json().token as string;
};
const start = (t: string, role: string, profileId = 'camp') =>
  app.inject({ method: 'POST', url: '/v1/admin/impersonations', headers: H(t), payload: { role, domainProfileId: profileId } });
const stop = (t: string, userId?: string) =>
  app.inject({ method: 'POST', url: '/v1/admin/impersonations/stop', headers: H(t), payload: userId ? { userId } : {} });
const revoke = (t: string, userId: string) =>
  app.inject({ method: 'POST', url: `/v1/admin/impersonations/${userId}/revoke`, headers: H(t) });
const list = (t: string, qs = '') =>
  app.inject({ method: 'GET', url: `/v1/admin/impersonations${qs}`, headers: H(t) });
const audits = (action: string) => repo.listAudit('org-1').then(rs => rs.filter(r => r.action === action));
const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

describe('session metadata + server-side expiry', () => {
  it('mint stamps createdAt/expiresAt (15-minute TTL) and sessionState active', async () => {
    const t = await otpLogin(SA1);
    const s = await start(t, 'admin');
    const sid = s.json().principal.userId as string;
    const u = (await repo.getUser(sid))!;
    expect(u.sessionState).toBe('active');
    expect(Date.parse(u.expiresAt!) - Date.parse(u.createdAt!)).toBe(SANDBOX_SESSION_TTL_MS);
    expect(Date.parse(u.createdAt!)).toBe(Date.now());
  });

  it('boundary: 1s before expiresAt authenticates; exactly AT expiresAt is expired', async () => {
    const t = await otpLogin(SA1);
    const s = await start(t, 'focus_worker');
    const stok = s.json().token as string;
    const sid = s.json().principal.userId as string;
    const exp = Date.parse((await repo.getUser(sid))!.expiresAt!);
    vi.setSystemTime(new Date(exp - 1000));
    expect((await app.inject({ method: 'GET', url: '/v1/whoami', headers: H(stok) })).statusCode).toBe(200);
    vi.setSystemTime(new Date(exp)); // boundary: AT the instant -> expired
    expect((await app.inject({ method: 'GET', url: '/v1/whoami', headers: H(stok) })).statusCode).toBe(401);
  });

  it('crash/no-stop: a session never stopped still expires; atomic active->expired + ONE immutable audit; identity + audits preserved', async () => {
    const t = await otpLogin(SA1);
    const s = await start(t, 'admin');
    const stok = s.json().token as string;
    const sid = s.json().principal.userId as string;
    advance(SANDBOX_SESSION_TTL_MS + 1000); // "crash": no stop ever issued
    // a burst of concurrent first-expired requests -> exactly ONE expire audit
    const rs = await Promise.all(Array.from({ length: 5 }, () =>
      app.inject({ method: 'GET', url: '/v1/whoami', headers: H(stok) })));
    expect(rs.every(r => r.statusCode === 401)).toBe(true);
    const u = (await repo.getUser(sid))!;
    expect(u.sessionState).toBe('expired');
    expect(u.active).toBe(false);
    expect(u.sessionEndBy).toBe('server');
    expect(u.sessionEndedAt).toBeTruthy();
    const exp = await audits('identity.impersonate.expire');
    expect(exp).toHaveLength(1);
    expect(JSON.parse(exp[0]!.afterJson!)).toMatchObject({ expiredBy: 'server', impersonatorUserId: (await repo.findUserByPhone(SA1))!.userId });
    expect(await audits('identity.impersonate.start')).toHaveLength(1); // preserved
    expect((await repo.getUser(sid))!.impersonationOf).toBeTruthy(); // identity preserved, not deleted
  });

  it('an expired session can no longer be stopped (fail-loud 404, no double transition)', async () => {
    const t = await otpLogin(SA1);
    const s = await start(t, 'admin');
    const sid = s.json().principal.userId as string;
    advance(SANDBOX_SESSION_TTL_MS + 1000);
    expect((await app.inject({ method: 'GET', url: '/v1/whoami', headers: H(s.json().token) })).statusCode).toBe(401);
    const t2 = await otpLogin(SA1); // the SA's own 15-min token expired too: re-login
    expect((await stop(t2, sid)).statusCode).toBe(404);
    expect((await revoke(t2, sid)).statusCode).toBe(409); // fail loud: already inactive
    expect(await audits('identity.impersonate.expire')).toHaveLength(1);
  });
});

describe('restart durability', () => {
  it('all lanes: a fresh app instance over the SAME store sees the session; expiry still enforced', async () => {
    const t = await otpLogin(SA1);
    const s = await start(t, 'admin');
    const stok = s.json().token as string;
    await app.close();
    const app2 = buildApp(repo, new AuthService(repo)); // "process restart", same durable store
    await app2.ready();
    expect((await app2.inject({ method: 'GET', url: '/v1/whoami', headers: H(stok) })).statusCode).toBe(200);
    advance(SANDBOX_SESSION_TTL_MS + 1000);
    expect((await app2.inject({ method: 'GET', url: '/v1/whoami', headers: H(stok) })).statusCode).toBe(401);
    expect((await repo.getUser(s.json().principal.userId as string))!.sessionState).toBe('expired');
    await app2.close();
  });

  it.skipIf(REPO_IMPL !== 'realpg')('real PG: NEW pool + NEW repository over the same database (no schema drop) preserves session + audits', async () => {
    const t = await otpLogin(SA1);
    const s = await start(t, 'admin');
    const stok = s.json().token as string;
    const sid = s.json().principal.userId as string;
    advance(SANDBOX_SESSION_TTL_MS + 1000);
    expect((await app.inject({ method: 'GET', url: '/v1/whoami', headers: H(stok) })).statusCode).toBe(401);
    await app.close();
    const { Pool } = await import('pg');
    const { PostgresGraphRepository } = await import('../src/repo/postgres.js');
    const pool2 = new Pool({ connectionString: process.env['DATABASE_URL'] });
    const repo2 = await PostgresGraphRepository.create(pool2 as never); // DDL IF NOT EXISTS: no wipe
    const u = (await repo2.getUser(sid))!;
    expect(u.sessionState).toBe('expired');
    expect((await repo2.listAudit('org-1')).filter(r => r.action === 'identity.impersonate.expire')).toHaveLength(1);
    expect((await repo2.listImpersonationSessions({ limit: 10 })).sessions.map(x => x.userId)).toContain(sid);
    await pool2.end();
  });
});

describe('listing + revoke (tenant-safe, paginated, audited)', () => {
  it('non-super-admin cannot list or revoke', async () => {
    const w = await otpLogin('+972500000001');
    expect((await list(w)).statusCode).toBe(403);
    expect((await revoke(w, 'sa-imp-whatever')).statusCode).toBe(403);
  });

  it('paginates without duplicates across pages; state filter works; entries carry tenant markers + provenance', async () => {
    const t1 = await otpLogin(SA1);
    const t2 = await otpLogin(SA2);
    const ids: string[] = [];
    for (const [tk, role] of [[t1, 'admin'], [t1, 'focus_worker'], [t2, 'field_manager']] as const) {
      const s = await start(tk, role);
      ids.push(s.json().principal.userId as string);
      advance(1000); // distinct createdAt ordering
    }
    await stop(t1, ids[0]!);
    const p1 = await list(t1, '?limit=2');
    expect(p1.statusCode).toBe(200);
    expect(p1.json().sessions).toHaveLength(2);
    const cursor = p1.json().nextCursor as string;
    expect(cursor).toBeTruthy();
    const p2 = await list(t1, `?limit=2&cursor=${encodeURIComponent(cursor)}`);
    expect(p2.json().sessions).toHaveLength(1);
    const all = [...p1.json().sessions, ...p2.json().sessions];
    expect(new Set(all.map((x: { userId: string }) => x.userId)).size).toBe(3);
    const e = all[0];
    expect(e.sandboxOrg).toBe(SUPERADMIN_SANDBOX_ORG);
    expect(e.createdAt).toBeTruthy();
    expect(e.expiresAt).toBeTruthy();
    const stoppedOnly = await list(t1, '?state=stopped');
    expect(stoppedOnly.json().sessions.map((x: { userId: string }) => x.userId)).toEqual([ids[0]]);
    expect(stoppedOnly.json().sessions[0].sessionEndBy).toBe((await repo.findUserByPhone(SA1))!.userId);
  });

  it('revoke-by-id: 200 + token dies immediately + immutable revoke audit; second revoke 409; unknown id 404; identity preserved', async () => {
    const t = await otpLogin(SA1);
    const s = await start(t, 'admin');
    const stok = s.json().token as string;
    const sid = s.json().principal.userId as string;
    const r = await revoke(t, sid);
    expect(r.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/whoami', headers: H(stok) })).statusCode).toBe(401);
    const u = (await repo.getUser(sid))!;
    expect(u.sessionState).toBe('revoked');
    expect(u.sessionEndBy).toBe((await repo.findUserByPhone(SA1))!.userId);
    const rev = await audits('identity.impersonate.revoke');
    expect(rev).toHaveLength(1);
    expect(JSON.parse(rev[0]!.afterJson!)).toMatchObject({ revokedBy: (await repo.findUserByPhone(SA1))!.userId });
    expect((await revoke(t, sid)).statusCode).toBe(409);
    expect((await revoke(t, 'sa-imp-nonexistent')).statusCode).toBe(404);
    expect((await repo.getUser(sid))!.impersonationOf).toBeTruthy(); // preserved
    expect(await audits('identity.impersonate.revoke')).toHaveLength(1); // no double audit
  });

  it('stop provenance: stop flips sessionState to stopped (not deleted), stop audit intact, restart keeps it stopped', async () => {
    const t = await otpLogin(SA1);
    const s = await start(t, 'admin');
    const sid = s.json().principal.userId as string;
    expect((await stop(t, sid)).statusCode).toBe(200);
    const u = (await repo.getUser(sid))!;
    expect(u.sessionState).toBe('stopped');
    expect(u.active).toBe(false);
    expect(await audits('identity.impersonate.stop')).toHaveLength(1);
    expect((await repo.getUser(sid))!.impersonationOf).toBeTruthy();
  });
});

describe('storage-level unique normalized user phone', () => {
  const mk = (userId: string, phone: string, orgId = 'org-1'): UserRecord => ({
    userId, orgId, name: 'T', role: 'admin', scopes: [], phone, active: true,
  });

  it('second user with the same normalized phone fails loud at the store', async () => {
    await repo.createUser(mk('u-p1', '+15550100009'));
    await expect(repo.createUser(mk('u-p2', '+15550100009'))).rejects.toThrow(/unique constraint/);
  });

  it('normalization: surrounding whitespace is trimmed on write and lookup', async () => {
    await repo.createUser(mk('u-p3', '  +15550100010  '));
    expect((await repo.findUserByPhone('+15550100010'))!.userId).toBe('u-p3');
    expect((await repo.findUserByPhone('  +15550100010 '))!.userId).toBe('u-p3');
    await expect(repo.createUser(mk('u-p4', '+15550100010'))).rejects.toThrow(/unique constraint/);
  });

  it('cross-tenant collision: the same phone in a DIFFERENT org still collides (global credential identity)', async () => {
    await repo.createUser(mk('u-p5', '+15550100011', 'org-1'));
    await expect(repo.createUser(mk('u-p6', '+15550100011', 'org-superadmin-sandbox'))).rejects.toThrow(/unique constraint/);
  });

  it('concurrent enrollment of the same phone: exactly ONE winner, one stored identity', async () => {
    const rs = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => repo.createUser(mk(`u-c${i}`, '+15550100012'))));
    expect(rs.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(rs.filter(r => r.status === 'rejected')).toHaveLength(7);
    const winner = rs.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<UserRecord>;
    expect((await repo.findUserByPhone('+15550100012'))!.userId).toBe(winner.value.userId);
    expect((await repo.listUsers('org-1')).filter(u => u.phone === '+15550100012')).toHaveLength(1);
  });

  it('concurrent Super Admin first-login ensure is idempotent (deterministic id, single row)', async () => {
    const auth = new AuthService(repo);
    const [a, b] = await Promise.all([auth.ensureSuperAdmin('+15550100013'), auth.ensureSuperAdmin('+15550100013')]);
    expect(a!.userId).toBe(b!.userId);
    expect((await repo.listUsers('org-1')).filter(u => u.phone === '+15550100013')).toHaveLength(1);
  });
});
