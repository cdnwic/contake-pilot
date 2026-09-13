import { describe, expect, it, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo } from './helpers/repo.js';
let app: FastifyInstance; let repo: GraphRepository;
const move = (h: string) => `2026-09-14T${h}:00+03:00`;
beforeEach(async () => { repo = await makeTestRepo(); app = buildApp(repo, new AuthService(repo)); await app.ready(); });
const login = async (e: string, p: string) => (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: e, password: p } })).json().token as string;
const H = (t: string) => ({ authorization: `Bearer ${t}` });

describe('QA lock-bypass regression (QA-M1-1)', () => {
  it('ADMIN task.move on LOCKED t6 without unlock', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const t6 = (await repo.getTask('t6'))!;
    expect(t6.locked).toBe(true);
    const res = await app.inject({ method: 'PATCH', url: '/v1/tasks/t6', headers: H(admin), payload: { version: t6.version, move: { newStart: move('13:00') } } });
    // QA-M1-1: rejected for admin too; unlock-first is the only path
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('LOCK_VIOLATION');
    expect((await repo.getTask('t6'))!.start).toBe(move('12:00'));
    expect((await repo.getTask('t6'))!.locked).toBe(true);
  });
  it('FIELD_MANAGER task.move on LOCKED t6 without unlock (scope path)', async () => {
    const fm = await login('fm@camp.local', 'fm12345');
    const t6 = (await repo.getTask('t6'))!;
    const res = await app.inject({ method: 'PATCH', url: '/v1/tasks/t6', headers: H(fm), payload: { version: t6.version, move: { newStart: move('13:00') } } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('LOCK_VIOLATION');
    expect((await repo.getTask('t6'))!.start).toBe(move('12:00'));
    // no ChangeRequest created for a refused move
    expect(await repo.listChangeRequests({ eventId: 'e1' })).toEqual([]);
  });
});


  it('unlock-first path: gated unlock then move succeeds', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const un = await app.inject({ method: 'POST', url: '/v1/tasks/t6/unlock', headers: H(admin), payload: { version: 1 } });
    expect(un.statusCode).toBe(200);
    expect((await repo.getTask('t6'))!.locked).toBe(false);
    const mv = await app.inject({ method: 'PATCH', url: '/v1/tasks/t6', headers: H(admin), payload: { version: 2, move: { newStart: move('13:00') } } });
    expect(mv.statusCode).toBe(200);
    expect((await repo.getTask('t6'))!.start).toBe(move('13:00'));
  });

  it('S0 report path on a locked task never applies (engine guard)', async () => {
    const w1 = (await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: '+972500000001' } })).json().devCode as string;
    const tok = (await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: '+972500000001', code: w1 } })).json().token as string;
    // assign t6 to w1's group so the worker can report on it
    const admin = await login('admin@camp.local', 'admin123');
    await app.inject({ method: 'PATCH', url: '/v1/tasks/t6', headers: H(admin), payload: { version: 1, assign: { assigneeResourceIds: ['r-g1'] } } });
    const rep = await app.inject({ method: 'POST', url: '/v1/reports', headers: H(tok), payload: { taskId: 't6', status: 'delayed', delayMin: 30, clientReportId: 'r-lock-1', clientTimestamp: move('12:05') } });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().applied).toBeUndefined();
    expect((await repo.getTask('t6'))!.start).toBe(move('12:00'));
  });
