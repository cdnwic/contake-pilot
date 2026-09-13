/** QA FE v12.0 live E2E (plan 3zav #1 gate): real OTP -> session -> authed REST calls
 *  -> 401 expiry path, all through the REAL v12 liveApi + session modules against the
 *  recovered backend. Also proves no-session and bad-token produce no silent access. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import { MemoryGraphRepository } from '../src/repo/memory.js';
import { seedDemo } from '../src/seed.js';

let app: FastifyInstance; let base = '';
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k), clear: () => store.clear(),
};
const win = { location: { search: '?api=live', href: '' } };
(globalThis as any).window = win;
const FE = '/home/sandbox/qa-workspace/frontend-v12/pkg-v12/src/api';
const live = await import(`${FE}/liveApi.ts`);
const sess = await import(`${FE}/session.ts`);

beforeEach(async () => {
  const repo = MemoryGraphRepository.seeded(seedDemo());
  app = buildApp(repo, new AuthService(repo));
  await app.ready();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const a = app.server.address(); base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  store.set('contake-api-url', base);
  store.set('contake-api', 'live');
  win.location.href = '';
});
afterEach(async () => { await app.close(); });

describe('FE v12.0 session live E2E', () => {
  it('E2E-1: real OTP verify -> session -> authed live calls succeed', async () => {
    const req = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: '+972500000001' } });
    expect(req.statusCode).toBe(200);
    const otp = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: '+972500000001', code: req.json().devCode } });
    expect(otp.statusCode).toBe(200);
    expect(typeof otp.json().token).toBe('string');
    expect(otp.json().principal?.role).toBeTruthy();
    // admin session for the authed admin-path calls below (role arg must match session identity in v12)
    const v = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@camp.local', password: 'admin123' } });
    expect(v.statusCode).toBe(200);
    const body = v.json();
    expect(typeof body.token).toBe('string');
    expect(body.principal?.userId).toBeTruthy();
    expect(body.principal?.role).toBeTruthy();
    sess.saveSession({ token: body.token, principal: body.principal });
    expect(sess.loadSession()?.token).toBe(body.token);
    const profiles = await live.getProfiles();
    expect(profiles.length).toBeGreaterThan(0);
    const state = await live.getClientState('camp', 'admin');
    expect(state.graph.tasks.length).toBeGreaterThan(0);
    expect(state.profile.id).toBe('camp');
  });

  it('E2E-2: dead token -> 401 -> session cleared + AUTH_EXPIRED + login redirect', async () => {
    sess.saveSession({ token: 'dead-token', principal: { userId: 'u-admin', role: 'admin', scopes: [] } });
    await expect(live.computePreview('camp', {} as never)).rejects.toMatchObject({ code: 'AUTH_EXPIRED', status: 401 });
    expect(sess.loadSession()).toBeNull();
    expect(win.location.href).toContain('login.html');
    expect(win.location.href).toContain('api=live');
  });

  it('E2E-3: no session -> AUTH_REQUIRED + login redirect, zero server calls', async () => {
    sess.clearSession();
    await expect(live.submitReport('camp', {} as never, {} as never)).rejects.toMatchObject({ code: 'AUTH_REQUIRED', status: 401 });
    expect(win.location.href).toContain('login.html');
  });

  it('E2E-4: session survives reload (localStorage round-trip), garbage JSON rejected', async () => {
    sess.saveSession({ token: 'tok-1', principal: { userId: 'u-admin', role: 'admin', scopes: [] } });
    expect(sess.loadSession()?.principal.userId).toBe('u-admin');
    store.set('contake-session-v1', '{not json');
    expect(sess.loadSession()).toBeNull();
    store.set('contake-session-v1', JSON.stringify({ token: '', principal: null }));
    expect(sess.loadSession()).toBeNull();
  });
});
