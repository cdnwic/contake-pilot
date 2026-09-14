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
});
