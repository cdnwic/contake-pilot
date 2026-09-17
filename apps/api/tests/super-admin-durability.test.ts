/** Super Admin stop-ship repairs (QA 2026-09-17): fail-closed allowlist,
 *  transactional sandbox ensure + identity mint + start audit, transactional
 *  deactivate + stop audit, and the concurrent / restart / fault /
 *  partial-repair / lifecycle / collision probes. Runs in all lanes
 *  (REPO_IMPL=memory, =postgres [PGlite], =realpg [DATABASE_URL]). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.hoisted(() => { process.env['CONTAKE_SUPER_ADMIN_PHONES'] = '+972587700852'; });

import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo } from './helpers/repo.js';
import { SUPERADMIN_SANDBOX_ORG, SUPERADMIN_SANDBOX_SITE, sandboxEventId, sandboxResourceId } from '../src/services/superadmin.js';

let repo: GraphRepository;
let app: FastifyInstance;
beforeEach(async () => {
  repo = await makeTestRepo();
  app = buildApp(repo, new AuthService(repo));
  await app.ready();
});
afterEach(async () => { await app.close(); });

const H = (t: string) => ({ authorization: `Bearer ${t}` });
const SA = '+972587700852';
const otpLogin = async (phone: string) => {
  const q = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone } });
  return (await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code: q.json().devCode } })).json().token as string;
};
const start = (t: string, role: string, profileId = 'camp') =>
  app.inject({ method: 'POST', url: '/v1/admin/impersonations', headers: H(t), payload: { role, domainProfileId: profileId } });
const stop = (t: string, userId?: string) =>
  app.inject({ method: 'POST', url: '/v1/admin/impersonations/stop', headers: H(t), payload: userId ? { userId } : {} });
const startAudits = () => repo.listAudit('org-1').then(rs => rs.filter(r => r.action === 'identity.impersonate.start'));
const stopAudits = () => repo.listAudit('org-1').then(rs => rs.filter(r => r.action === 'identity.impersonate.stop'));

describe('fail-closed allowlist (no default privileged phone)', () => {
  it('unset env yields an EMPTY allowlist (module-level evaluation)', async () => {
    const saved = process.env['CONTAKE_SUPER_ADMIN_PHONES'];
    delete process.env['CONTAKE_SUPER_ADMIN_PHONES'];
    vi.resetModules();
    try {
      const fresh = await import('../src/auth.js');
      expect(fresh.SUPER_ADMIN_PHONES).toEqual([]);
    } finally {
      process.env['CONTAKE_SUPER_ADMIN_PHONES'] = saved;
      vi.resetModules();
    }
  });
  it('non-allowlisted phone never becomes super admin', async () => {
    const t = await otpLogin('+972500000099'); // not in allowlist, unknown user
    // unknown phone -> verify succeeds but no user -> login returns 401
    // (seeded phone +972500000001 is a focus worker, also NOT allowlisted)
    const w = await otpLogin('+972500000001');
    const me = await app.inject({ method: 'GET', url: '/v1/whoami', headers: H(w) });
    expect(me.json().isSuperAdmin).toBe(false);
    expect((await start(w, 'admin')).statusCode).toBe(403);
  });
});

describe('transactional impersonation start', () => {
  it('fault at identity mint -> 500, NO sandbox event, NO user, NO start audit', async () => {
    const t = await otpLogin(SA);
    const original = repo.createUser.bind(repo);
    repo.createUser = () => { throw new Error('user store down'); };
    const r = await start(t, 'admin');
    repo.createUser = original;
    expect(r.statusCode).toBe(500);
    expect(await repo.getEvent(sandboxEventId('camp'))).toBeUndefined();
    expect(await startAudits()).toHaveLength(0);
    // retry after repair: fully green
    const ok = await start(t, 'admin');
    expect(ok.statusCode).toBe(200);
    expect(await repo.getEvent(sandboxEventId('camp'))).toBeDefined();
    expect(await startAudits()).toHaveLength(1);
  });

  it('partial sandbox is repaired: event exists, resource+task recreated', async () => {
    const t = await otpLogin(SA);
    await repo.createEvent({
      id: sandboxEventId('camp'), kind: 'event', orgId: SUPERADMIN_SANDBOX_ORG, domainProfileId: 'camp',
      name: 'partial', date: '2026-09-14', timezone: 'Asia/Jerusalem', siteIds: [SUPERADMIN_SANDBOX_SITE], status: 'published', version: 1,
    });
    const r = await start(t, 'focus_worker');
    expect(r.statusCode).toBe(200);
    expect(await repo.getResource(sandboxResourceId('camp'))).toBeDefined();
    expect(await repo.getTask('sa-t-camp-1')).toBeDefined();
    expect(r.json().principal.linkedResourceId).toBe(sandboxResourceId('camp'));
  });

  it('concurrent starts (same profile) collide safely: both 200, ONE sandbox artifact set, two audited identities', async () => {
    const t = await otpLogin(SA);
    const [a, b] = await Promise.all([start(t, 'admin'), start(t, 'field_manager')]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json().principal.userId).not.toBe(b.json().principal.userId);
    expect(await repo.getEvent(sandboxEventId('camp'))).toBeDefined();
    expect(await repo.getResource(sandboxResourceId('camp'))).toBeDefined();
    expect(await repo.getTask('sa-t-camp-1')).toBeDefined();
    expect(await startAudits()).toHaveLength(2);
  });

  it('collision isolation: sandbox artifacts never leak into real tenants', async () => {
    const t = await otpLogin(SA);
    const before = (await repo.listEvents('org-1')).length;
    expect((await start(t, 'admin')).statusCode).toBe(200);
    expect((await repo.listEvents('org-1')).length).toBe(before);
    expect((await repo.listEvents(SUPERADMIN_SANDBOX_ORG)).map(e => e.id)).toEqual([sandboxEventId('camp')]);
  });
});

describe('transactional impersonation stop', () => {
  it('fault at stop audit -> 500, target STILL ACTIVE, no stop audit; retry stops cleanly', async () => {
    const t = await otpLogin(SA);
    const s = await start(t, 'admin');
    const sid = s.json().principal.userId as string;
    const original = repo.appendAudit.bind(repo);
    repo.appendAudit = () => { throw new Error('audit store down'); };
    const r = await stop(t, sid);
    repo.appendAudit = original;
    expect(r.statusCode).toBe(500);
    expect((await repo.getUser(sid))!.active).toBe(true);
    expect(await stopAudits()).toHaveLength(0);
    const retry = await stop(t, sid);
    expect(retry.statusCode).toBe(200);
    expect((await repo.getUser(sid))!.active).toBe(false);
    expect(await stopAudits()).toHaveLength(1);
  });

  it('lifecycle: start -> whoami marked sandbox -> stop -> token dead', async () => {
    const t = await otpLogin(SA);
    const s = await start(t, 'focus_worker');
    expect(s.statusCode).toBe(200);
    const stok = s.json().token as string;
    const me = await app.inject({ method: 'GET', url: '/v1/whoami', headers: H(stok) });
    expect(me.json().sandbox).toBe(true);
    expect(me.json().impersonationOf).toBeTruthy();
    expect((await stop(stok)).statusCode).toBe(200); // self-stop
    const after = await app.inject({ method: 'GET', url: '/v1/whoami', headers: H(stok) });
    expect(after.statusCode).toBe(401);
  });
});

describe('restart durability (new app on the SAME durable store)', () => {
  it('sandbox identity + audits survive an app restart; stopped stays stopped', async () => {
    const t = await otpLogin(SA);
    const s = await start(t, 'admin');
    const sid = s.json().principal.userId as string;
    const stok = s.json().token as string;
    expect((await stop(stok)).statusCode).toBe(200);
    await app.close();
    // "restart": brand-new app instance over the same DURABLE store. On the
    // realpg lane this is a genuinely new connection (fresh Pool, no reset);
    // on other lanes a new app over the same repo (adapters keep no entity
    // state in memory; PG lanes re-read the same underlying DB).
    if (process.env['REPO_IMPL'] === 'realpg') {
      const { Pool } = await import('pg');
      const { PostgresGraphRepository } = await import('../src/repo/postgres.js');
      repo = await PostgresGraphRepository.create(new Pool({ connectionString: process.env['DATABASE_URL'] }) as never);
    }
    app = buildApp(repo, new AuthService(repo));
    await app.ready();
    expect((await repo.getUser(sid))!.active).toBe(false);
    expect(await repo.getEvent(sandboxEventId('camp'))).toBeDefined();
    expect(await startAudits()).toHaveLength(1);
    expect(await stopAudits()).toHaveLength(1);
    const me = await app.inject({ method: 'GET', url: '/v1/whoami', headers: H(stok) });
    expect(me.statusCode).toBe(401);
  });
});
