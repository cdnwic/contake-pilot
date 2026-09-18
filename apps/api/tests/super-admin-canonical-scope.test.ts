/** Super Admin CANONICAL SCOPE hardening (QA stop-ship 2026-09-18):
 *  the impersonation-session surface (list, stop, revoke) recognizes ONLY
 *  canonical sandbox sessions - canonical sandbox org + full valid session
 *  shape. Non-sandbox or malformed legacy records 404 on transition, are
 *  invisible in listing, and are never mutated or deleted. Strict cursor
 *  validation: malformed cursors 400. Malformed records are PRESERVED.
 *  Runs in all lanes (REPO_IMPL=memory / postgres [PGlite] / realpg). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.hoisted(() => { process.env['CONTAKE_SUPER_ADMIN_PHONES'] = '+15550100001,+15550100002'; });

import { buildApp } from '../src/app.js';
import { AuthService, SANDBOX_SESSION_TTL_MS } from '../src/auth.js';
import type { GraphRepository, UserRecord } from '../src/repo/graph-repository.js';
import { isCanonicalSandboxSession, isValidSessionCursor } from '../src/repo/graph-repository.js';
import { makeTestRepo, REPO_IMPL } from './helpers/repo.js';
import { SUPERADMIN_SANDBOX_ORG } from '../src/services/superadmin.js';

let repo: GraphRepository;
let app: FastifyInstance;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-18T12:00:00.000Z'));
  repo = await makeTestRepo();
  app = buildApp(repo, new AuthService(repo));
  await app.ready();
});
afterEach(async () => { await app.close(); vi.useRealTimers(); });

const H = (t: string) => ({ authorization: `Bearer ${t}` });
const SA1 = '+15550100001';
const otpLogin = async (phone: string) => {
  const q = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone } });
  return (await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code: q.json().devCode } })).json().token as string;
};
const start = (t: string, role = 'admin') =>
  app.inject({ method: 'POST', url: '/v1/admin/impersonations', headers: H(t), payload: { role, domainProfileId: 'camp' } });
const list = (t: string, qs = '') => app.inject({ method: 'GET', url: `/v1/admin/impersonations${qs}`, headers: H(t) });
const stopBy = (t: string, userId: string) => app.inject({ method: 'POST', url: '/v1/admin/impersonations/stop', headers: H(t), payload: { userId } });
const revoke = (t: string, userId: string) => app.inject({ method: 'POST', url: `/v1/admin/impersonations/${userId}/revoke`, headers: H(t) });

let seq = 0;
const baseSession = (over: Partial<UserRecord>): UserRecord => {
  const now = Date.now();
  return {
    userId: `sa-mal-${(seq += 1)}-${Math.random().toString(36).slice(2, 8)}`,
    orgId: SUPERADMIN_SANDBOX_ORG,
    name: 'crafted',
    role: 'admin',
    scopes: [],
    active: true,
    impersonationOf: 'u-admin-1',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SANDBOX_SESSION_TTL_MS).toISOString(),
    sessionState: 'active',
    ...over,
  };
};

const MALFORMED: [string, Partial<UserRecord>][] = [
  ['impersonation in a REAL tenant (non-sandbox org)', { orgId: 'org-1' }],
  ['legacy: no createdAt/expiresAt/sessionState', { createdAt: undefined, expiresAt: undefined, sessionState: undefined }],
  ['garbage createdAt', { createdAt: 'not-a-date' }],
  ['non-canonical timestamp format (offset)', { createdAt: '2026-09-18T12:00:00+03:00' }],
  ['expiresAt before createdAt', { expiresAt: new Date(Date.now() - 1000).toISOString() }],
  ['expiresAt == createdAt', { expiresAt: new Date(Date.now()).toISOString() }],
  ['bogus sessionState', { sessionState: 'weird' as never }],
  ['missing sessionState (legacy active default)', { sessionState: undefined }],
  ['active but carries end metadata', { sessionEndedAt: new Date(Date.now()).toISOString(), sessionEndBy: 'u-admin-1' }],
  ['stopped but missing sessionEndedAt', { sessionState: 'stopped', active: false }],
  ['stopped but missing sessionEndBy', { sessionState: 'stopped', active: false, sessionEndedAt: new Date(Date.now()).toISOString() }],
  ['stopped with garbage sessionEndedAt', { sessionState: 'stopped', active: false, sessionEndedAt: 'yesterday', sessionEndBy: 'u-admin-1' }],
  ['empty impersonationOf', { impersonationOf: '' }],
  ['whitespace-only impersonationOf', { impersonationOf: '   ' }],
  ['whitespace-only sessionEndBy', { sessionState: 'stopped', active: false, sessionEndedAt: new Date(Date.now()).toISOString(), sessionEndBy: '  ' }],
  ['calendar-impossible: Feb 30', { createdAt: '2026-02-30T00:00:00.000Z' }],
  ['calendar-impossible: non-leap Feb 29', { createdAt: '2026-02-29T00:00:00.000Z' }],
  ['calendar-impossible: Apr 31 expiresAt', { expiresAt: '2026-04-31T00:00:00.000Z' }],
  ['second 60 (leap-second shape)', { createdAt: '2026-09-18T12:00:60.000Z' }],
  ['month 13', { createdAt: '2026-13-01T00:00:00.000Z' }],
];

describe('canonical scope: non-sandbox / malformed legacy records', () => {
  it('predicate unit: every crafted malformed record is rejected; the minted shape is accepted', () => {
    const good = baseSession({});
    expect(isCanonicalSandboxSession(good, SUPERADMIN_SANDBOX_ORG)).toBe(true);
    // leap-year Feb 29 is calendar-POSSIBLE and stays canonical
    expect(isCanonicalSandboxSession(baseSession({ createdAt: '2028-02-29T00:00:00.000Z', expiresAt: '2028-02-29T01:00:00.000Z' }), SUPERADMIN_SANDBOX_ORG)).toBe(true);
    // cross-representation: storage org column disagreeing with the record is non-canonical
    expect(isCanonicalSandboxSession(baseSession({}), SUPERADMIN_SANDBOX_ORG, 'org-1')).toBe(false);
    for (const [label, over] of MALFORMED) {
      expect(isCanonicalSandboxSession(baseSession(over), SUPERADMIN_SANDBOX_ORG), label).toBe(false);
    }
  });

  it('list EXCLUDES every malformed record; malformed records are preserved, never deleted', async () => {
    const t = await otpLogin(SA1);
    const s = await start(t);
    expect(s.statusCode).toBe(200);
    const goodId = s.json().principal.userId as string;
    for (const [, over] of MALFORMED) await repo.createUser(baseSession(over));
    const r = await list(t);
    expect(r.statusCode).toBe(200);
    const ids = (r.json().sessions as { userId: string }[]).map(x => x.userId);
    expect(ids).toEqual([goodId]);
    // preserved: every crafted record is still stored, untouched - 12 in the
    // sandbox org, the 1 non-sandbox craft in its real tenant.
    const all = await repo.listUsers(SUPERADMIN_SANDBOX_ORG);
    expect(all.filter(u => u.userId.startsWith('sa-mal-')).length).toBe(MALFORMED.length - 1);
    const realTenant = await repo.listUsers('org-1');
    expect(realTenant.filter(u => u.userId.startsWith('sa-mal-')).length).toBe(1);
  });

  it('stop on a malformed record is 404 and mutates nothing', async () => {
    const t = await otpLogin(SA1);
    for (const [label, over] of MALFORMED) {
      const crafted = baseSession(over);
      await repo.createUser(crafted);
      const r = await stopBy(t, crafted.userId);
      expect(r.statusCode, label).toBe(404);
      const after = await repo.getUser(crafted.userId);
      expect(after, label).toEqual(crafted); // untouched
    }
  });

  it('revoke on a malformed record is 404 and mutates nothing', async () => {
    const t = await otpLogin(SA1);
    for (const [label, over] of MALFORMED) {
      const crafted = baseSession(over);
      await repo.createUser(crafted);
      const r = await revoke(t, crafted.userId);
      expect(r.statusCode, label).toBe(404);
      const after = await repo.getUser(crafted.userId);
      expect(after, label).toEqual(crafted); // untouched
    }
  });

  it('positive control: canonical sessions still list, stop and revoke', async () => {
    const t = await otpLogin(SA1);
    const s1 = await start(t);
    const id1 = s1.json().principal.userId as string;
    expect((await stopBy(t, id1)).statusCode).toBe(200);
    const s2 = await start(t, 'field_manager');
    const id2 = s2.json().principal.userId as string;
    expect((await revoke(t, id2)).statusCode).toBe(200);
    const r = await list(t);
    expect((r.json().sessions as unknown[]).length).toBe(2);
  });
});

describe('strict cursor validation', () => {
  const BAD_CURSORS: [string, string][] = [
    ['no separator', 'abc'],
    ['empty timestamp', '|sa-imp-1'],
    ['garbage timestamp', 'garbage|sa-imp-1'],
    ['non-canonical timestamp (offset)', '2026-09-18T12:00:00+03:00|sa-imp-1'],
    ['empty id', '2026-09-18T12:00:00.000Z|'],
    ['extra separator', '2026-09-18T12:00:00.000Z|sa-imp-1|extra'],
    ['whitespace id', '2026-09-18T12:00:00.000Z|sa imp 1'],
    ['oversized', `${'2026-09-18T12:00:00.000Z|'}${'x'.repeat(300)}`],
    ['sql-ish injection', "2026-09-18T12:00:00.000Z|x' OR '1'='1"],
  ];
  it('cursor predicate unit', () => {
    expect(isValidSessionCursor('2026-09-18T12:00:00.000Z|sa-imp-1')).toBe(true);
    for (const [label, c] of BAD_CURSORS) expect(isValidSessionCursor(c), label).toBe(false);
  });
  it('every malformed cursor is a 400, never silently reinterpreted', async () => {
    const t = await otpLogin(SA1);
    for (const [label, c] of BAD_CURSORS) {
      const r = await list(t, `?cursor=${encodeURIComponent(c)}`);
      expect(r.statusCode, label).toBe(400);
    }
  });
  it('valid cursors paginate exactly across the full set', async () => {
    const t = await otpLogin(SA1);
    for (let i = 0; i < 5; i += 1) {
      await start(t);
      vi.setSystemTime(new Date(Date.now() + 1000)); // distinct createdAt keys
    }
    const seen: string[] = [];
    let cursor = '';
    for (let page = 0; page < 10; page += 1) {
      const r = await list(t, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(r.statusCode).toBe(200);
      const body = r.json();
      seen.push(...(body.sessions as { userId: string }[]).map(x => x.userId));
      if (!body.nextCursor) break;
      cursor = body.nextCursor as string;
    }
    expect(seen.length).toBe(5);
    expect(new Set(seen).size).toBe(5);
  });
});

describe('auth rejection of non-canonical impersonation-shaped records', () => {
  it('a minted session corrupted into non-canonical shape is rejected at authentication (401), record untouched', async () => {
    const t = await otpLogin(SA1);
    const s = await start(t);
    const stok = s.json().token as string;
    const sid = s.json().principal.userId as string;
    expect((await app.inject({ method: 'GET', url: '/v1/whoami', headers: H(stok) })).statusCode).toBe(200);
    const before = await repo.getUser(sid);
    // corrupt: expiresAt becomes calendar-impossible
    await repo.updateUser(sid, { expiresAt: '2026-02-30T00:00:00.000Z' });
    expect((await app.inject({ method: 'GET', url: '/v1/whoami', headers: H(stok) })).statusCode).toBe(401);
    const after = await repo.getUser(sid);
    expect(after!.expiresAt).toBe('2026-02-30T00:00:00.000Z'); // preserved, not repaired/deleted
    expect(after!.userId).toBe(before!.userId);
  });
});

describe('cross-representation org adversary (PG lanes: raw SQL shapes)', () => {
  it.skipIf(REPO_IMPL === 'memory')('storage org_id != data.orgId sandbox session: invisible to list, 404 on stop/revoke, byte-identical afterwards', async () => {
    const t = await otpLogin(SA1);
    const now = Date.now();
    const data = {
      userId: 'sa-xrep-1', orgId: SUPERADMIN_SANDBOX_ORG, name: 'x', role: 'admin', scopes: [], active: true,
      impersonationOf: 'u-admin-1', createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SANDBOX_SESSION_TTL_MS).toISOString(), sessionState: 'active',
    };
    const raw = JSON.stringify(data);
    // cross-representation: storage column org-1, embedded JSON sandbox
    const { Pool } = REPO_IMPL === 'realpg' ? await import('pg') : { Pool: undefined as never };
    void Pool;
    // write through raw SQL on the lane's connection
    const rawConn = (repo as unknown as { db?: never }).db; void rawConn;
    // use a dedicated connection per lane
    let c: import('../src/repo/postgres.js').Connectable;
    let close: () => Promise<void>;
    if (REPO_IMPL === 'realpg') {
      const pg = await import('pg');
      const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
      c = pool as unknown as import('../src/repo/postgres.js').Connectable;
      close = () => pool.end();
    } else {
      // PGlite lane: reach the file-scoped instance through a fresh write is
      // impossible (single connection); use repo.createUser for the JSON side
      // and a direct SQL UPDATE through the adapter's own connection is not
      // exposed - so craft via createUser then FIX the column via the
      // transition path is not possible; instead assert via getUserWithStorageOrg.
      const crafted = baseSession({ userId: 'sa-xrep-1' });
      await repo.createUser(crafted);
      const wso = await repo.getUserWithStorageOrg('sa-xrep-1');
      expect(wso?.storageOrgId).toBe(SUPERADMIN_SANDBOX_ORG); // adapter writes column from record: consistent
      return; // cross-representation divergence is a realpg-only raw-SQL craft
    }
    try {
      await c.query(`INSERT INTO users(user_id, org_id, email, phone, data) VALUES('sa-xrep-1','org-1',NULL,NULL,$1)`, [raw]);
      const wso = await repo.getUserWithStorageOrg('sa-xrep-1');
      expect(wso?.record.orgId).toBe(SUPERADMIN_SANDBOX_ORG);
      expect(wso?.storageOrgId).toBe('org-1'); // divergent representations
      const l = await list(t);
      expect((l.json().sessions as { userId: string }[]).some(x => x.userId === 'sa-xrep-1')).toBe(false); // invisible
      expect((await stopBy(t, 'sa-xrep-1')).statusCode).toBe(404);
      expect((await revoke(t, 'sa-xrep-1')).statusCode).toBe(404);
      const after = await repo.getUserWithStorageOrg('sa-xrep-1');
      expect(after!.record).toEqual(wso!.record); // byte-identical (untouched)
      expect(after!.storageOrgId).toBe('org-1');
    } finally { await close(); }
  });
});

describe('SUPER_ADMIN_PHONES allowlist immutability (security)', () => {
  it('the export is a detached FROZEN copy: mutation attempts throw and membership is unchanged', async () => {
    const { SUPER_ADMIN_PHONES } = await import('../src/auth.js');
    expect(Object.isFrozen(SUPER_ADMIN_PHONES)).toBe(true);
    expect(SUPER_ADMIN_PHONES instanceof Array).toBe(true);
    const members = [...SUPER_ADMIN_PHONES];
    const mutable = SUPER_ADMIN_PHONES as unknown as string[];
    expect(() => { mutable.push('+19999999999'); }).toThrow(TypeError);
    expect(() => { mutable.length = 0; }).toThrow(TypeError);
    expect(() => { mutable[0] = '+19999999999'; }).toThrow(TypeError);
    expect(() => { mutable.splice(0, 1); }).toThrow(TypeError);
    expect([...SUPER_ADMIN_PHONES]).toEqual(members);
    expect(members).toContain(SA1);
    // membership behavior unchanged: the allowlisted login still provisions SA
    const t = await otpLogin(SA1);
    const w = await app.inject({ method: 'GET', url: '/v1/whoami', headers: H(t) });
    expect(w.json().isSuperAdmin).toBe(true);
  });
});
