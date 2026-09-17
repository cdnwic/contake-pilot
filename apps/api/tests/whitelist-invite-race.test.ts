/** Register exactly-one-winner (QA 2026-09-17, T2 defect fix): invite-only
 *  atomic primitive + tenant-safe 409 conflict + same-org idempotent retry.
 *  Synchronized repository/API tests; runs in both harness lanes
 *  (REPO_IMPL=memory and =postgres via makeTestRepo). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import type { WhitelistEntry } from '@contake/core';
import { makeTestRepo } from './helpers/repo.js';

let app: FastifyInstance;
let repo: GraphRepository;

const H = (t: string): { authorization: string } => ({ authorization: `Bearer ${t}` });
const login = async (email: string, pw: string): Promise<string> =>
  (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: pw } })).json().token as string;
const org1Admin = (): Promise<string> => login('admin@camp.local', 'admin123');
const org2Admin = (): Promise<string> => login('admin@film.local', 'admin123');
const invite = (t: string, phone: string) =>
  app.inject({ method: 'POST', url: '/v1/whitelist', headers: H(t), payload: { phone } });
const P = '+972500000099';
const invitesFor = async (orgId: string) =>
  (await repo.listAudit(orgId)).filter(r => r.action === 'whitelist.invite');

beforeEach(async () => {
  repo = await makeTestRepo();
  app = buildApp(repo, new AuthService(repo));
  await app.ready();
});
afterEach(async () => { await app.close(); });

describe('createWhitelistInvite primitive (repository level)', () => {
  it('exactly one created; the loser gets exists with the winner row; never an overwrite', async () => {
    const e1: WhitelistEntry = { phone: P, status: 'invited', orgId: 'org-1', createdAt: '2026-09-17T00:00:00.000Z' };
    const r1 = await repo.createWhitelistInvite(e1);
    expect(r1.outcome).toBe('created');
    const r2 = await repo.createWhitelistInvite({ ...e1, orgId: 'org-2', createdAt: '2026-09-17T01:00:00.000Z' });
    expect(r2.outcome).toBe('exists');
    expect(r2.entry.orgId).toBe('org-1');
    const stored = await repo.getWhitelistEntry(P);
    expect(stored?.orgId).toBe('org-1');
    expect(stored?.createdAt).toBe('2026-09-17T00:00:00.000Z'); // untouched
  });
});

describe('cross-org invite conflict (API)', () => {
  it('loser gets 409 with no overwrite, a conflict audit in the ATTEMPTING org, and no other-org leak', async () => {
    const t1 = await org1Admin();
    const t2 = await org2Admin();
    expect((await invite(t1, P)).statusCode).toBe(200);
    const b = await invite(t2, P);
    expect(b.statusCode).toBe(409);
    expect(b.json().error.code).toBe('WHITELIST_CONFLICT');
    expect(JSON.stringify(b.json())).not.toContain('org-1'); // tenant-safe body
    const stored = await repo.getWhitelistEntry(P);
    expect(stored?.orgId).toBe('org-1'); // no overwrite
    expect((await repo.listWhitelist('org-2')).find(e => e.phone === P)).toBeUndefined();
    const org2Audits = await invitesFor('org-2');
    expect(org2Audits).toHaveLength(1);
    expect(JSON.parse(org2Audits[0]?.afterJson ?? '{}')['outcome']).toBe('conflict');
    expect(org2Audits[0]?.orgId).toBe('org-2');
    expect(await invitesFor('org-1')).toHaveLength(1); // only the created invite
  });

  it('concurrent invites from two orgs: exactly one 200 and one 409, one row, coherent audits', async () => {
    const t1 = await org1Admin();
    const t2 = await org2Admin();
    const [r1, r2] = await Promise.all([invite(t1, P), invite(t2, P)]);
    const codes = [r1.statusCode, r2.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const stored = await repo.getWhitelistEntry(P);
    expect(stored).toBeDefined();
    const winnerOrg = r1.statusCode === 200 ? 'org-1' : 'org-2';
    const loserOrg = r1.statusCode === 200 ? 'org-2' : 'org-1';
    expect(stored?.orgId).toBe(winnerOrg);
    expect((await repo.listWhitelist(loserOrg)).find(e => e.phone === P)).toBeUndefined();
    const loserAudits = await invitesFor(loserOrg);
    expect(loserAudits).toHaveLength(1);
    expect(JSON.parse(loserAudits[0]?.afterJson ?? '{}')['outcome']).toBe('conflict');
    expect(await invitesFor(winnerOrg)).toHaveLength(1);
  });
});

describe('same-org retry semantics (explicit, idempotent)', () => {
  it('re-invite is the §15 reset: createdAt preserved, decision fields cleared, repeat yields the identical state', async () => {
    const t1 = await org1Admin();
    expect((await invite(t1, P)).statusCode).toBe(200);
    const first = (await repo.getWhitelistEntry(P))!;
    // Simulate a decided entry (setup only; decide paths still use the CAS upsert).
    await repo.upsertWhitelistEntry({ ...first, status: 'approved', decidedBy: 'u-admin', decidedAt: '2026-09-17T02:00:00.000Z' });
    expect((await invite(t1, P)).statusCode).toBe(200);
    const reinvited = (await repo.getWhitelistEntry(P))!;
    expect(reinvited.status).toBe('invited');
    expect(reinvited.createdAt).toBe(first.createdAt);
    expect(reinvited.decidedBy).toBeUndefined();
    expect(reinvited.decidedAt).toBeUndefined();
    expect((await invite(t1, P)).statusCode).toBe(200);
    expect(await repo.getWhitelistEntry(P)).toEqual(reinvited); // idempotent repeat
    expect(await invitesFor('org-1')).toHaveLength(3); // one audit per intentional admin call
  });

  it('concurrent duplicate invite from the SAME org: both 200, single row, invited', async () => {
    const t1 = await org1Admin();
    const [r1, r2] = await Promise.all([invite(t1, P), invite(t1, P)]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    const stored = await repo.getWhitelistEntry(P);
    expect(stored?.orgId).toBe('org-1');
    expect(stored?.status).toBe('invited');
    expect((await repo.listWhitelist('org-1')).filter(e => e.phone === P)).toHaveLength(1);
  });
});
