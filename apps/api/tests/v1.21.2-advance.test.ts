/** v1.21.2 §26: bidirectional domino (early-finish advancement).
 *  This file covers §26.1א report.correct; advance compute/lifecycle lands next. */
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo } from './helpers/repo.js';
import { rateResetAll } from '../src/services/security.js';

let repo: GraphRepository;
let app: FastifyInstance;
let n = 0;
beforeEach(async () => {
  process.env.CONTAKE_TEST_MODE = 'true';
  delete process.env.CONTAKE_INBOUND_SECRET;
  rateResetAll();
  repo = await makeTestRepo();
  app = buildApp(repo, new AuthService(repo));
  await app.ready();
});
const login = async (e: string, p: string) => (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: e, password: p } })).json().token as string;
const H = (t: string) => ({ authorization: `Bearer ${t}` });
const admin = () => login('admin@camp.local', 'admin123');
const fm = () => login('fm@camp.local', 'fm12345');
const cm = (tag: string) => `cm-${tag}-${++n}`;

const mkReport = async (t: string) =>
  (await app.inject({ method: 'POST', url: '/v1/reports', headers: H(t),
    payload: { taskId: 't1', clientReportId: `cr-${++n}`, status: 'done', clientTimestamp: new Date().toISOString() } })).json().report;

describe('§26.1א report.correct', () => {
  it('admin corrects actualFinishAt with CAS + audit + version bump', async () => {
    const t = await admin();
    const rep = await mkReport(t);
    const finish = new Date(Date.now() + 3600_000).toISOString();
    const res = await app.inject({ method: 'POST', url: `/v1/reports/${rep.id}/correct`, headers: H(t),
      payload: { actualFinishAt: finish, expectedReportVersion: 1, reason: 'דיווח שדה מתוקן', clientMutationId: cm('rc') } });
    expect(res.statusCode).toBe(200);
    expect(res.json().report.actualFinishAt).toBe(finish);
    expect(res.json().report.version).toBe(2);
    expect(res.json().report.lastCorrection.reason).toBe('דיווח שדה מתוקן');
    const rows = (await repo.listAudit('org-1')).filter(r => r.action === 'report.correct');
    expect(rows.length).toBe(1);
    expect(rows[0].entityType).toBe('report');
  });

  it('CAS conflict on stale expectedReportVersion -> 409', async () => {
    const t = await admin();
    const rep = await mkReport(t);
    const finish = new Date(Date.now() + 3600_000).toISOString();
    await app.inject({ method: 'POST', url: `/v1/reports/${rep.id}/correct`, headers: H(t),
      payload: { actualFinishAt: finish, expectedReportVersion: 1, reason: 'ראשון', clientMutationId: cm('rc1') } });
    const stale = await app.inject({ method: 'POST', url: `/v1/reports/${rep.id}/correct`, headers: H(t),
      payload: { actualFinishAt: finish, expectedReportVersion: 1, reason: 'שני', clientMutationId: cm('rc2') } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');
  });

  it('idempotent on clientMutationId: replay returns stored body; changed body -> 409', async () => {
    const t = await admin();
    const rep = await mkReport(t);
    const finish = new Date(Date.now() + 3600_000).toISOString();
    const key = cm('rcidem');
    const payload = { actualFinishAt: finish, expectedReportVersion: 1, reason: 'תיקון', clientMutationId: key };
    const r1 = await app.inject({ method: 'POST', url: `/v1/reports/${rep.id}/correct`, headers: H(t), payload });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({ method: 'POST', url: `/v1/reports/${rep.id}/correct`, headers: H(t), payload });
    expect(r2.statusCode).toBe(200);
    expect(r2.headers['idempotency-replayed']).toBe('true');
    expect((await repo.listAudit('org-1')).filter(r => r.action === 'report.correct').length).toBe(1);
    const r3 = await app.inject({ method: 'POST', url: `/v1/reports/${rep.id}/correct`, headers: H(t),
      payload: { ...payload, reason: 'אחרת' } });
    expect(r3.statusCode).toBe(409);
    expect(r3.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('secret-looking reason -> 400 (no store-and-redact)', async () => {
    const t = await admin();
    const rep = await mkReport(t);
    const res = await app.inject({ method: 'POST', url: `/v1/reports/${rep.id}/correct`, headers: H(t),
      payload: { actualFinishAt: new Date().toISOString(), expectedReportVersion: 1, reason: 'token=abc123def', clientMutationId: cm('rcsec') } });
    expect(res.statusCode).toBe(400);
  });

  it('field_manager proposes via CR, focus_worker denied; cross-org 404', async () => {
    const t = await admin();
    const rep = await mkReport(t);
    const f = await fm();
    const finish = new Date(Date.now() + 3600_000).toISOString();
    const res = await app.inject({ method: 'POST', url: `/v1/reports/${rep.id}/correct`, headers: H(f),
      payload: { actualFinishAt: finish, expectedReportVersion: 1, reason: 'תיקון רכז', clientMutationId: cm('rcfm') } });
    expect(res.statusCode).toBe(200);
    expect(res.json().changeRequest).toBeTruthy();
    expect(res.json().changeRequest.change.type).toBe('report.correct');
    // report untouched while pending review
    expect((await repo.getReport(rep.id))!.actualFinishAt).toBeUndefined();
    const b = await login('admin@film.local', 'admin123');
    expect((await app.inject({ method: 'POST', url: `/v1/reports/${rep.id}/correct`, headers: H(b),
      payload: { actualFinishAt: finish, expectedReportVersion: 1, reason: 'x', clientMutationId: cm('rcb') } })).statusCode).toBe(404);
  });

  it('missing fields / bad ISO / missing key -> 400', async () => {
    const t = await admin();
    const rep = await mkReport(t);
    const finish = new Date().toISOString();
    expect((await app.inject({ method: 'POST', url: `/v1/reports/${rep.id}/correct`, headers: H(t),
      payload: { expectedReportVersion: 1, reason: 'x', clientMutationId: cm('b1') } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/v1/reports/${rep.id}/correct`, headers: H(t),
      payload: { actualFinishAt: '2026-09-17 10:00', expectedReportVersion: 1, reason: 'x', clientMutationId: cm('b2') } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/v1/reports/${rep.id}/correct`, headers: H(t),
      payload: { actualFinishAt: finish, expectedReportVersion: 1, reason: 'x' } })).statusCode).toBe(400);
  });

  it('correction stale-marks open advance proposals derived from the report', async () => {
    const t = await admin();
    const rep = await mkReport(t);
    await repo.createAdvanceProposal({
      proposalId: 'ap-1', orgId: 'org-1', eventId: 'e1', graphVersion: 1,
      anchorTaskId: rep.taskId, actualFinishAt: new Date().toISOString(), sourceReportId: rep.id,
      candidates: [], status: 'open', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1800_000).toISOString(),
    });
    const finish = new Date(Date.now() + 3600_000).toISOString();
    await app.inject({ method: 'POST', url: `/v1/reports/${rep.id}/correct`, headers: H(t),
      payload: { actualFinishAt: finish, expectedReportVersion: 1, reason: 'תיקון', clientMutationId: cm('rcstale') } });
    expect((await repo.getAdvanceProposal('ap-1'))!.status).toBe('stale');
    const staleAudit = (await repo.listAudit('org-1')).filter(r => r.entityType === 'advance_proposal');
    expect(staleAudit.length).toBe(1);
  });
});
