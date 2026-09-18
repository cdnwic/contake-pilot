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
import { makeTestRepo } from './helpers/repo.js';
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
];

describe('canonical scope: non-sandbox / malformed legacy records', () => {
  it('predicate unit: every crafted malformed record is rejected; the minted shape is accepted', () => {
    const good = baseSession({});
    expect(isCanonicalSandboxSession(good, SUPERADMIN_SANDBOX_ORG)).toBe(true);
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
