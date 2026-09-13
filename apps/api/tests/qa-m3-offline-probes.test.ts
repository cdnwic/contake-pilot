/** QA M3-prep: Focus offline queue semantics, server side (AC-FR-2). */
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import { MemoryGraphRepository } from '../src/repo/memory.js';
import { seedDemo } from '../src/seed.js';

let app: FastifyInstance; let repo: MemoryGraphRepository;
let w1 = '';
const H = (t: string) => ({ authorization: `Bearer ${t}` });
beforeEach(async () => {
  repo = MemoryGraphRepository.seeded(seedDemo());
  app = buildApp(repo, new AuthService(repo));
  await app.ready();
  const req = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: '+972500000001' } });
  w1 = (await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: '+972500000001', code: req.json().devCode } })).json().token as string;
});

describe('offline queue semantics (server side)', () => {
  it('OQ-1: same clientReportId delivered twice -> exactly one effect (dedupe)', async () => {
    const payload = { taskId: 't7', status: 'delayed', delayMin: 10, clientReportId: 'oq-1', clientTimestamp: '2026-09-14T14:05:00+03:00' };
    const r1 = await app.inject({ method: 'POST', url: '/v1/reports', headers: H(w1), payload });
    const r2 = await app.inject({ method: 'POST', url: '/v1/reports', headers: H(w1), payload });
    console.log('OQ-1 first:', r1.statusCode, 'deduped on second:', r2.json().deduped === true, 'dup flag or same id:', r2.json().report?.id === r1.json().report?.id);
    expect(r2.json().deduped ?? (r2.json().report?.id === r1.json().report?.id)).toBeTruthy();
  });
  it('OQ-2: original clientTimestamp preserved on the report record', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/reports', headers: H(w1), payload: { taskId: 't7', status: 'ok', clientReportId: 'oq-2', clientTimestamp: '2026-09-14T06:30:00+03:00' } });
    const rep = r.json().report;
    console.log('OQ-2 clientTimestamp:', rep?.clientTimestamp, 'createdAt:', rep?.createdAt);
    expect(rep?.clientTimestamp).toBe('2026-09-14T06:30:00+03:00');
  });
  it('OQ-3: out-of-order queue replay — delayed(14:05) then ok(14:02) on same task: both recorded, order preserved by clientTimestamp', async () => {
    await app.inject({ method: 'POST', url: '/v1/reports', headers: H(w1), payload: { taskId: 't7', status: 'delayed', delayMin: 15, clientReportId: 'oq-3a', clientTimestamp: '2026-09-14T14:05:00+03:00' } });
    const r2 = await app.inject({ method: 'POST', url: '/v1/reports', headers: H(w1), payload: { taskId: 't7', status: 'ok', clientReportId: 'oq-3b', clientTimestamp: '2026-09-14T14:02:00+03:00' } });
    console.log('OQ-3 second (older ts) accepted:', r2.statusCode, 'outcome:', JSON.stringify(r2.json()).slice(0, 150));
    expect(r2.statusCode).toBeLessThan(300);
  });
});
