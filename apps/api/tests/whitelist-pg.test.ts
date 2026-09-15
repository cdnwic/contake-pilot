/** QA gate: adapter-backed route-level PG audit test - real HTTP against the
 *  Postgres adapter (PGlite), proving success/rejection/429 auth_audit rows
 *  persist through the actual route wiring. Runs only under REPO_IMPL=postgres. */
import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService, hashPasswordPure } from '../src/auth.js';
import { PostgresGraphRepository, createPgOtpState, pgliteConnectable } from '../src/repo/postgres.js';
import { REPO_IMPL } from './helpers/repo.js';

const run = REPO_IMPL === 'postgres' ? describe : describe.skip;

run('whitelist route-level PG audit (real HTTP, PGlite)', () => {
  let liveDb: PGlite | undefined;
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close().catch(() => undefined);
    await liveDb?.close().catch(() => undefined);
    liveDb = undefined; app = undefined;
  });

  it('success, status rejection, and 429 rows persist through real routes', async () => {
    liveDb = new PGlite();
    const db = pgliteConnectable(liveDb);
    const repo = await PostgresGraphRepository.create(db);
    await repo.createUser({ userId: 'u-admin', orgId: 'org-1', name: 'מנהל', role: 'admin', scopes: [], email: 'admin@x.local', passwordHash: hashPasswordPure('admin123'), active: true });
    const otp = await createPgOtpState(db);
    app = buildApp(repo, new AuthService(repo, undefined, undefined, otp));
    const admin = (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@x.local', password: 'admin123' } })).json().token as string;
    const H = { authorization: `Bearer ${admin}` };

    // success: invite -> register -> approve -> phone login
    const phone = '+972500999040';
    expect((await app.inject({ method: 'POST', url: '/v1/whitelist', headers: H, payload: { phone } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone, displayName: 'פלוני', requestedRole: 'field_manager' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/v1/whitelist/${phone}/approve`, headers: H, payload: { role: 'field_manager' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { phone } })).statusCode).toBe(200);
    // status rejection: unknown phone register (409) + denied login (403)
    expect((await app.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone: '+972500000000', displayName: 'x', requestedRole: 'admin' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { phone: '+972500000000' } })).statusCode).toBe(403);
    // 429: 11 checks in the window
    let last = 0;
    for (let i = 0; i < 11; i += 1) last = (await app.inject({ method: 'POST', url: '/v1/auth/whitelist-check', payload: { phone: '+972500000001' } })).statusCode;
    expect(last).toBe(429);
    // 429: whitelist-register route throttles too (round-3 explicit coverage)
    for (let i = 0; i < 11; i += 1) last = (await app.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone: '+972500000002', displayName: 'x', requestedRole: 'admin' } })).statusCode;
    expect(last).toBe(429);

    const rows = await otp.listAuthAudit();
    const codes = (ph: string, kind: string) => rows.filter(r => r.phone === ph && r.kind === kind).map(r => (r.detail as { reasonCode?: string }).reasonCode);
    expect(codes(phone, 'whitelist.register')).toContain('pending_approval');
    expect(codes(phone, 'whitelist.login')).toContain('approved');
    expect(codes('+972500000000', 'whitelist.register')).toContain('unknown_phone');
    expect(codes('+972500000000', 'whitelist.login')).toContain('not_approved');
    expect(codes('+972500000001', 'whitelist.check')).toContain('throttle_429');
    expect(codes('+972500000002', 'whitelist.register')).toContain('throttle_429');
    // round-3 audit semantics persist in PG: accepted + committed success pair
    expect(codes(phone, 'whitelist.register')).toContain('committed');
    const regRows = rows.filter(r => r.phone === phone && r.kind === 'whitelist.register');
    expect(regRows.map(r => (r.detail as { outcome?: string }).outcome)).toContain('accepted');
    for (const r of rows) {
      expect(r.createdAt).toBeTruthy();
      expect((r.detail as Record<string, unknown>)['requestId']).toBeTruthy();
    }
  });

  it('round-4 PG atomicity: committed-insert failure rolls the upsert back in one tx; retry exactly-once', async () => {
    liveDb = new PGlite();
    const db = pgliteConnectable(liveDb);
    const repo = await PostgresGraphRepository.create(db);
    await repo.createUser({ userId: 'u-admin', orgId: 'org-1', name: 'מנהל', role: 'admin', scopes: [], email: 'admin@x.local', passwordHash: hashPasswordPure('admin123'), active: true });
    const otp = await createPgOtpState(db);
    app = buildApp(repo, new AuthService(repo, undefined, undefined, otp));
    const admin = (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@x.local', password: 'admin123' } })).json().token as string;
    const H = { authorization: `Bearer ${admin}` };
    const phone = '+972500999041';
    expect((await app.inject({ method: 'POST', url: '/v1/whitelist', headers: H, payload: { phone } })).statusCode).toBe(200);
    // Trigger fails ONLY the committed insert: accepted lands, upsert+committed tx aborts
    await liveDb.query(`CREATE OR REPLACE FUNCTION fail_committed_audit() RETURNS trigger AS $fn$ BEGIN RAISE EXCEPTION 'injected committed-audit failure'; END; $fn$ LANGUAGE plpgsql`);
    await liveDb.query(`CREATE TRIGGER fail_committed BEFORE INSERT ON auth_audit FOR EACH ROW WHEN (NEW.kind = 'whitelist.register' AND NEW.data->>'reasonCode' = 'committed') EXECUTE FUNCTION fail_committed_audit()`);
    const r1 = await app.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone, displayName: 'פלוני', requestedRole: 'field_manager' } });
    expect(r1.statusCode).toBe(500);
    expect((await repo.getWhitelistEntry(phone))!.status).toBe('invited'); // tx ROLLBACK: no ambiguous pending
    const detail = (r: { detail?: unknown }) => r.detail as { outcome?: string; reasonCode?: string };
    let rows = (await otp.listAuthAudit()).filter(r => r.phone === phone && r.kind === 'whitelist.register');
    expect(rows.some(r => detail(r).outcome === 'accepted')).toBe(true);
    expect(rows.some(r => detail(r).outcome === 'success')).toBe(false); // no false success row persisted
    await liveDb.query('DROP TRIGGER fail_committed ON auth_audit');
    const r2 = await app.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone, displayName: 'פלוני', requestedRole: 'field_manager' } });
    expect(r2.statusCode).toBe(200);
    expect((await repo.getWhitelistEntry(phone))!.status).toBe('pending_approval');
    rows = (await otp.listAuthAudit()).filter(r => r.phone === phone && r.kind === 'whitelist.register');
    expect(rows.filter(r => detail(r).reasonCode === 'committed')).toHaveLength(1); // exactly once
  });

  it('round-8 PG admin concurrency: approve-vs-approve - exactly one decision, one audit row, at most one account', async () => {
    liveDb = new PGlite();
    const db = pgliteConnectable(liveDb);
    const repo = await PostgresGraphRepository.create(db);
    await repo.createUser({ userId: 'u-admin', orgId: 'org-1', name: 'מנהל', role: 'admin', scopes: [], email: 'admin@x.local', passwordHash: hashPasswordPure('admin123'), active: true });
    const otp = await createPgOtpState(db);
    app = buildApp(repo, new AuthService(repo, undefined, undefined, otp));
    const admin = (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@x.local', password: 'admin123' } })).json().token as string;
    const H = { authorization: `Bearer ${admin}` };
    const phone = '+972500999060';
    await app.inject({ method: 'POST', url: '/v1/whitelist', headers: H, payload: { phone } });
    await app.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone, displayName: 'מועמד', requestedRole: 'field_manager' } });
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: `/v1/whitelist/${phone}/approve`, headers: H, payload: { role: 'field_manager' } }),
      app.inject({ method: 'POST', url: `/v1/whitelist/${phone}/approve`, headers: H, payload: { role: 'focus_worker', linkedResourceId: 'r-x' } }),
    ]);
    expect([a.statusCode, b.statusCode].sort((x, y) => x - y)).toEqual([200, 409]);
    expect((a.statusCode === 409 ? a : b).json().error.code).toBe('WHITELIST_NOT_PENDING'); // deterministic loser
    const entry = (await repo.getWhitelistEntry(phone))!;
    expect(entry.status).toBe('approved'); // exactly one decision landed
    expect(['field_manager', 'focus_worker']).toContain(entry.assignedRole);
    const decisions = (await repo.listAudit('org-1')).filter(x => x.action === 'whitelist.approve');
    expect(decisions).toHaveLength(1); // exactly one decision audit row
    const accounts = (await repo.listUsers('org-1')).filter(u => u.phone === phone);
    expect(accounts).toHaveLength(1); // at most one account created
  });

  it('round-8 PG admin concurrency: approve-vs-reject - exactly one terminal state, one decision audit, account only if approve won', async () => {
    liveDb = new PGlite();
    const db = pgliteConnectable(liveDb);
    const repo = await PostgresGraphRepository.create(db);
    await repo.createUser({ userId: 'u-admin', orgId: 'org-1', name: 'מנהל', role: 'admin', scopes: [], email: 'admin@x.local', passwordHash: hashPasswordPure('admin123'), active: true });
    const otp = await createPgOtpState(db);
    app = buildApp(repo, new AuthService(repo, undefined, undefined, otp));
    const admin = (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@x.local', password: 'admin123' } })).json().token as string;
    const H = { authorization: `Bearer ${admin}` };
    const phone = '+972500999061';
    await app.inject({ method: 'POST', url: '/v1/whitelist', headers: H, payload: { phone } });
    await app.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone, displayName: 'מועמד', requestedRole: 'field_manager' } });
    const [a, r] = await Promise.all([
      app.inject({ method: 'POST', url: `/v1/whitelist/${phone}/approve`, headers: H, payload: { role: 'field_manager' } }),
      app.inject({ method: 'POST', url: `/v1/whitelist/${phone}/reject`, headers: H, payload: { reasonHe: 'לא' } }),
    ]);
    expect([a.statusCode, r.statusCode].sort((x, y) => x - y)).toEqual([200, 409]);
    expect((a.statusCode === 409 ? a : r).json().error.code).toBe('WHITELIST_NOT_PENDING'); // deterministic loser
    const entry = (await repo.getWhitelistEntry(phone))!;
    expect(['approved', 'rejected']).toContain(entry.status); // one terminal state, no last-write-wins blend
    const decisions = (await repo.listAudit('org-1')).filter(x => x.action === 'whitelist.approve' || x.action === 'whitelist.reject');
    expect(decisions).toHaveLength(1); // exactly one decision audit row
    expect(decisions[0]!.action).toBe(entry.status === 'approved' ? 'whitelist.approve' : 'whitelist.reject'); // audit matches the landed state
    const accounts = (await repo.listUsers('org-1')).filter(u => u.phone === phone);
    expect(accounts).toHaveLength(entry.status === 'approved' ? 1 : 0); // account exists only when approve won
  });

  it('round-5 PG concurrency: Promise.all same-phone register yields exactly one winner, one committed row, deterministic loser', async () => {
    liveDb = new PGlite();
    const db = pgliteConnectable(liveDb);
    const repo = await PostgresGraphRepository.create(db);
    await repo.createUser({ userId: 'u-admin', orgId: 'org-1', name: 'מנהל', role: 'admin', scopes: [], email: 'admin@x.local', passwordHash: hashPasswordPure('admin123'), active: true });
    const otp = await createPgOtpState(db);
    app = buildApp(repo, new AuthService(repo, undefined, undefined, otp));
    const admin = (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@x.local', password: 'admin123' } })).json().token as string;
    const H = { authorization: `Bearer ${admin}` };
    const phone = '+972500999042';
    expect((await app.inject({ method: 'POST', url: '/v1/whitelist', headers: H, payload: { phone } })).statusCode).toBe(200);
    // Distinct names close the idempotent branch for the loser: 200/409 in every interleaving
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone, displayName: 'מתמודד א', requestedRole: 'field_manager' } }),
      app.inject({ method: 'POST', url: '/v1/auth/whitelist-register', payload: { phone, displayName: 'מתמודד ב', requestedRole: 'field_manager' } }),
    ]);
    expect([a.statusCode, b.statusCode].sort((x, y) => x - y)).toEqual([200, 409]);
    expect((a.statusCode === 409 ? a : b).json().error.code).toBe('WHITELIST_NOT_INVITED');
    const entry = (await repo.getWhitelistEntry(phone))!;
    expect(entry.status).toBe('pending_approval'); // exactly one transition, winner intact
    expect(['מתמודד א', 'מתמודד ב']).toContain(entry.displayName);
    const det = (r: { detail?: unknown }) => r.detail as { outcome?: string; reasonCode?: string };
    const rows = (await otp.listAuthAudit()).filter(r => r.phone === phone && r.kind === 'whitelist.register');
    expect(rows.filter(r => det(r).reasonCode === 'committed')).toHaveLength(1); // exactly one committed row
    expect(rows.filter(r => det(r).outcome === 'accepted').length).toBeGreaterThanOrEqual(1);
    expect(rows.filter(r => det(r).reasonCode === 'concurrent_lost').length + rows.filter(r => det(r).reasonCode === 'not_invited').length).toBe(1);
  });
});
