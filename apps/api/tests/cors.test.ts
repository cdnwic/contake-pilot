/** Deploy-prep: @fastify/cors is registered ONLY when CORS_ORIGIN is set
 *  (comma-separated origins). Without the env the API emits no CORS headers —
 *  additive, env-gated, zero change for same-origin clients. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo } from './helpers/repo.js';

let repo: GraphRepository;
beforeEach(async () => { repo = await makeTestRepo(); });

describe('CORS (env-gated, deploy-prep)', () => {
  let saved: string | undefined;
  let app: FastifyInstance | undefined;
  beforeEach(() => { saved = process.env['CORS_ORIGIN']; });
  afterEach(async () => {
    if (saved === undefined) delete process.env['CORS_ORIGIN']; else process.env['CORS_ORIGIN'] = saved;
    await app?.close();
    app = undefined;
  });

  it('CORS_ORIGIN unset: preflight gets no CORS headers', async () => {
    delete process.env['CORS_ORIGIN'];
    app = buildApp(repo, new AuthService(repo));
    await app.ready();
    const res = await app.inject({
      method: 'OPTIONS', url: '/v1/auth/otp/request',
      headers: { origin: 'https://fe.example.com', 'access-control-request-method': 'POST' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('CORS_ORIGIN set: allowed origin reflected on preflight and actual requests', async () => {
    process.env['CORS_ORIGIN'] = 'https://fe.example.com';
    app = buildApp(repo, new AuthService(repo));
    await app.ready();
    const pre = await app.inject({
      method: 'OPTIONS', url: '/v1/auth/otp/request',
      headers: { origin: 'https://fe.example.com', 'access-control-request-method': 'POST' },
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('https://fe.example.com');
    const actual = await app.inject({ method: 'GET', url: '/v1/health', headers: { origin: 'https://fe.example.com' } });
    expect(actual.statusCode).toBe(200);
    expect(actual.headers['access-control-allow-origin']).toBe('https://fe.example.com');
  });

  it('CORS_ORIGIN set: a different origin is not reflected', async () => {
    process.env['CORS_ORIGIN'] = 'https://fe.example.com';
    app = buildApp(repo, new AuthService(repo));
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/v1/health', headers: { origin: 'https://evil.example.com' } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('CORS_ORIGIN supports a comma-separated origin list', async () => {
    process.env['CORS_ORIGIN'] = 'https://fe.example.com, https://staging-fe.example.com';
    app = buildApp(repo, new AuthService(repo));
    await app.ready();
    for (const origin of ['https://fe.example.com', 'https://staging-fe.example.com']) {
      const res = await app.inject({ method: 'GET', url: '/v1/health', headers: { origin } });
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    }
  });
});
