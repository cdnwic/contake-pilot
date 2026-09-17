/** v1.20 Builder (§20-§25): content surface, focus-now, org matrix,
 *  stakeholders + guest status tokens, branches, report list/read,
 *  inbound opt-out webhook. Backend-owned implementation tests.
 *  Updated for the v1.20.2/v2.1 remediation contract: clientMutationId on
 *  mutating routes, CAS content versions, tombstone deletes, scoped roles. */
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

const mkContent = async (t: string) =>
  (await app.inject({ method: 'POST', url: '/v1/orgs/org-1/content', headers: H(t), payload: { kind: 'text', title: 'הוראות בטיחות', body: 'להקפיד על קסדות', clientMutationId: cm('content') } })).json().item;

describe('§20 content items', () => {
  it('admin creates, lists, updates content; cross-org invisible', async () => {
    const t = await admin();
    const item = await mkContent(t);
    expect(item.id).toMatch(/^ci_/);
    expect(item.orgId).toBe('org-1');
    expect(item.version).toBe(1);
    const list = (await app.inject({ method: 'GET', url: '/v1/orgs/org-1/content', headers: H(t) })).json().items;
    expect(list.map((i: { id: string }) => i.id)).toContain(item.id);
    // CAS update: expectedVersion required; conflict on stale version
    const stale = await app.inject({ method: 'PATCH', url: `/v1/content/${item.id}`, headers: H(t), payload: { title: 'x', expectedVersion: 7, clientMutationId: cm('stale') } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');
    const noVersion = await app.inject({ method: 'PATCH', url: `/v1/content/${item.id}`, headers: H(t), payload: { title: 'x', clientMutationId: cm('noversion') } });
    expect(noVersion.statusCode).toBe(400);
    const upd = await app.inject({ method: 'PATCH', url: `/v1/content/${item.id}`, headers: H(t), payload: { title: 'עודכן', expectedVersion: 1, clientMutationId: cm('upd') } });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().item.title).toBe('עודכן');
    expect(upd.json().item.version).toBe(2);
    // immutable versions preserved
    const versions = (await app.inject({ method: 'GET', url: `/v1/content/${item.id}/versions`, headers: H(t) })).json().versions;
    expect(versions).toHaveLength(2);
    // cross-org admin cannot see or touch it
    const b = await login('admin@film.local', 'admin123');
    expect((await app.inject({ method: 'GET', url: '/v1/orgs/org-1/content', headers: H(b) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: `/v1/content/${item.id}`, headers: H(b), payload: { title: 'x', expectedVersion: 2, clientMutationId: cm('cross') } })).statusCode).toBe(404);
    // audit row exists
    expect((await repo.listAudit('org-1')).filter(r => r.action === 'content.create' && r.entityId === item.id).length).toBe(1);
  });

  it('mutation routes require clientMutationId', async () => {
    const t = await admin();
    expect((await app.inject({ method: 'POST', url: '/v1/orgs/org-1/content', headers: H(t), payload: { kind: 'text', title: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/orgs/org-1/stakeholders', headers: H(t), payload: { kind: 'supplier', displayName: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/orgs/org-1/branches', headers: H(t), payload: { name: 'x' } })).statusCode).toBe(400);
  });

  it('focus_worker is denied content.create; delete is admin-only tombstone (410 admin / 404 others)', async () => {
    const t = await admin();
    const item = await mkContent(t);
    const w = await fm();
    expect((await app.inject({ method: 'POST', url: '/v1/orgs/org-1/content', headers: H(w), payload: { kind: 'text', title: 'x', clientMutationId: cm('fmcreate') } })).statusCode).toBe(403);
    const del = await app.inject({ method: 'DELETE', url: `/v1/content/${item.id}?clientMutationId=${cm('fmdel')}`, headers: H(w) });
    expect(del.statusCode).toBe(403);
    const delNoKey = await app.inject({ method: 'DELETE', url: `/v1/content/${item.id}`, headers: H(t) });
    expect(delNoKey.statusCode).toBe(400);
    const delAdmin = await app.inject({ method: 'DELETE', url: `/v1/content/${item.id}?clientMutationId=${cm('del')}`, headers: H(t) });
    expect(delAdmin.statusCode).toBe(200);
    expect(delAdmin.json().deleted).toBe(true);
    // tombstone preserved, not removed
    const tomb = await repo.getContentItem(item.id);
    expect(tomb?.deletedAt).toBeTruthy();
    // admin sees 410 with tombstone metadata; field_manager sees 404
    const gAdmin = await app.inject({ method: 'GET', url: `/v1/content/${item.id}`, headers: H(t) });
    expect(gAdmin.statusCode).toBe(410);
    expect((await app.inject({ method: 'GET', url: `/v1/content/${item.id}`, headers: H(w) })).statusCode).toBe(404);
    // patch on tombstone is 410; versions stay retrievable (preservation)
    expect((await app.inject({ method: 'PATCH', url: `/v1/content/${item.id}`, headers: H(t), payload: { title: 'x', expectedVersion: 1, clientMutationId: cm('gone') } })).statusCode).toBe(410);
    expect((await app.inject({ method: 'GET', url: `/v1/content/${item.id}/versions`, headers: H(t) })).statusCode).toBe(200);
  });

  it('task attach is idempotent (replay + natural key); detach removes', async () => {
    const t = await admin();
    const item = await mkContent(t);
    const key = cm('attach');
    const payload = { contentId: item.id, role: 'instructions', clientMutationId: key };
    const a1 = await app.inject({ method: 'POST', url: '/v1/tasks/t1/content', headers: H(t), payload });
    expect(a1.statusCode).toBe(200);
    expect(a1.json().deduped).toBe(false);
    // same key = retry: byte-identical replay, replayed header, no new link
    const a2 = await app.inject({ method: 'POST', url: '/v1/tasks/t1/content', headers: H(t), payload });
    expect(a2.headers['idempotency-replayed']).toBe('true');
    expect(a2.json().deduped).toBe(false);
    // same key with different body = conflict
    const a2b = await app.inject({ method: 'POST', url: '/v1/tasks/t1/content', headers: H(t), payload: { contentId: item.id, role: 'script', clientMutationId: key } });
    expect(a2b.statusCode).toBe(409);
    expect(a2b.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    // different key, same natural key = deduped
    const a3 = await app.inject({ method: 'POST', url: '/v1/tasks/t1/content', headers: H(t), payload: { contentId: item.id, role: 'instructions', clientMutationId: cm('attach2') } });
    expect(a3.json().deduped).toBe(true);
    expect((await repo.listTaskContent('t1')).filter(l => l.contentId === item.id).length).toBe(1);
    // invalid role + missing key rejected
    expect((await app.inject({ method: 'POST', url: '/v1/tasks/t1/content', headers: H(t), payload: { contentId: item.id, role: 'reference', clientMutationId: cm('badrole') } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/tasks/t1/content', headers: H(t), payload: { contentId: item.id, role: 'instructions' } })).statusCode).toBe(400);
    const d = await app.inject({ method: 'DELETE', url: `/v1/tasks/t1/content/${item.id}`, headers: H(t) });
    expect(d.statusCode).toBe(200);
    expect((await repo.listTaskContent('t1')).filter(l => l.contentId === item.id).length).toBe(0);
  });

  it('focus/now returns current task with visible content for a scoped worker', async () => {
    const t = await admin();
    const item = await mkContent(t);
    // attach to t1 (07:30-08:00) with a wide visibility offset so "now" in test time falls inside
    await app.inject({ method: 'POST', url: '/v1/tasks/t1/content', headers: H(t), payload: { contentId: item.id, role: 'instructions', visibleFromOffsetMin: 60 * 24 * 365, clientMutationId: cm('focus') } });
    const w1 = await fm();
    const res = await app.inject({ method: 'GET', url: '/v1/focus/now', headers: H(w1) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('currentTask');
    expect(body).toHaveProperty('visibleResources');
  });

  it('content ack dedupes per org+actor; replay carries replayed header', async () => {
    const t = await admin();
    const item = await mkContent(t);
    const w = await fm();
    const r1 = await app.inject({ method: 'POST', url: `/v1/content/${item.id}/ack`, headers: H(w), payload: { clientAckId: 'ack-1', taskId: 't1' } });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({ method: 'POST', url: `/v1/content/${item.id}/ack`, headers: H(w), payload: { clientAckId: 'ack-1', taskId: 't1' } });
    expect(r2.headers['idempotency-replayed']).toBe('true');
    expect((await repo.listAudit('org-1')).filter(r => r.action === 'content.ack').length).toBe(1);
    // org+actor isolation: admin acking with the same clientAckId is a new ack
    const r3 = await app.inject({ method: 'POST', url: `/v1/content/${item.id}/ack`, headers: H(t), payload: { clientAckId: 'ack-1', taskId: 't1' } });
    expect(r3.statusCode).toBe(200);
    expect(r3.headers['idempotency-replayed']).toBeUndefined();
    expect((await repo.listAudit('org-1')).filter(r => r.action === 'content.ack').length).toBe(2);
  });
});

describe('§21 org matrix', () => {
  it('groups events by branchId with _unassigned fallback', async () => {
    const t = await admin();
    const br = (await app.inject({ method: 'POST', url: '/v1/orgs/org-1/branches', headers: H(t), payload: { name: 'סניף צפון', clientMutationId: cm('br') } })).json().branch;
    const res = await app.inject({ method: 'GET', url: '/v1/orgs/org-1/matrix', headers: H(t) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.branches.map((b: { id: string }) => b.id)).toContain(br.id);
    expect(body.grouped).toHaveProperty('_unassigned');
    expect(body.grouped._unassigned.length).toBe(2); // e1 + e2 seeded
  });
});

describe('§22 stakeholders + guest status tokens', () => {
  it('admin CRUD + links; field_manager denied create', async () => {
    const t = await admin();
    const p = (await app.inject({ method: 'POST', url: '/v1/orgs/org-1/stakeholders', headers: H(t),
      payload: { kind: 'guardian', displayName: 'אבא של דני', contactRefs: [{ channel: 'sms', value: '+972500000099' }], clientMutationId: cm('party') } })).json().party;
    expect(p.id).toMatch(/^xp_/);
    expect(p.contactRefs[0].transport).toBe('deferred');
    expect(p.consent.status).toBe('pending');
    const f = await fm();
    expect((await app.inject({ method: 'POST', url: '/v1/orgs/org-1/stakeholders', headers: H(f), payload: { kind: 'supplier', displayName: 'x', clientMutationId: cm('fmsh') } })).statusCode).toBe(403);
    const link = await app.inject({ method: 'POST', url: `/v1/stakeholders/${p.id}/links`, headers: H(t), payload: { entity: 'event', entityId: 'e1', relation: 'guardian_of', clientMutationId: cm('link') } });
    expect(link.statusCode).toBe(200);
    expect(link.json().party.links.length).toBe(1);
    // links must target same-org entities
    expect((await app.inject({ method: 'POST', url: `/v1/stakeholders/${p.id}/links`, headers: H(t), payload: { entity: 'event', entityId: 'e-nope', relation: 'guardian_of', clientMutationId: cm('badlink') } })).statusCode).toBe(400);
    // consent state machine: pending -> granted -> revoked; revoked is terminal
    const c1 = await app.inject({ method: 'PATCH', url: `/v1/stakeholders/${p.id}`, headers: H(t), payload: { consent: { status: 'granted' }, clientMutationId: cm('c1') } });
    expect(c1.statusCode).toBe(200);
    const c2 = await app.inject({ method: 'PATCH', url: `/v1/stakeholders/${p.id}`, headers: H(t), payload: { consent: { status: 'pending' }, clientMutationId: cm('c2') } });
    expect(c2.statusCode).toBe(409);
    // patch.links rejected - links change only via /links
    expect((await app.inject({ method: 'PATCH', url: `/v1/stakeholders/${p.id}`, headers: H(t), payload: { links: [], clientMutationId: cm('c3') } })).statusCode).toBe(400);
  });

  it('status token grants public schedule; revoke kills access without leaking; hash-only storage', async () => {
    const t = await admin();
    const p = (await app.inject({ method: 'POST', url: '/v1/orgs/org-1/stakeholders', headers: H(t), payload: { kind: 'client', displayName: 'הורה', clientMutationId: cm('tokparty') } })).json().party;
    await app.inject({ method: 'POST', url: `/v1/stakeholders/${p.id}/links`, headers: H(t), payload: { entity: 'event', entityId: 'e1', relation: 'client_of', clientMutationId: cm('toklink') } });
    const tok = (await app.inject({ method: 'POST', url: `/v1/stakeholders/${p.id}/status-token`, headers: H(t) })).json().statusToken;
    expect(tok.token).toBeTruthy();
    expect(tok.expiresAt).toBeTruthy();
    // only the HMAC is persisted, never the plaintext
    const stored = await repo.getStatusToken(tok.id);
    expect(stored?.tokenHash).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain(tok.token);
    // no auth header needed
    const pub = await app.inject({ method: 'GET', url: `/v1/public/status/${tok.token}` });
    expect(pub.statusCode).toBe(200);
    expect(pub.json().participant).toBe('הורה');
    expect(pub.json().schedule.length).toBe(1);
    expect(pub.json().schedule[0].eventId).toBe('e1');
    // bad token: 404, no oracle
    expect((await app.inject({ method: 'GET', url: '/v1/public/status/tk_nope' })).statusCode).toBe(404);
    // revoke via token id (idempotent), then public access dies
    const rev = await app.inject({ method: 'DELETE', url: `/v1/status-tokens/${tok.id}`, headers: H(t) });
    expect(rev.statusCode).toBe(200);
    const rev2 = await app.inject({ method: 'DELETE', url: `/v1/status-tokens/${tok.id}`, headers: H(t) });
    expect(rev2.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/v1/public/status/${tok.token}` })).statusCode).toBe(404);
  });
});

describe('§23 branches', () => {
  it('create/patch/archive lifecycle; focus_worker denied', async () => {
    const t = await admin();
    const br = (await app.inject({ method: 'POST', url: '/v1/orgs/org-1/branches', headers: H(t), payload: { name: 'סניף דרום', location: 'באר שבע', clientMutationId: cm('brlife') } })).json().branch;
    expect(br.active).toBe(true);
    const upd = await app.inject({ method: 'PATCH', url: `/v1/branches/${br.id}`, headers: H(t), payload: { name: 'דרום מחוז', clientMutationId: cm('brpatch') } });
    expect(upd.json().branch.name).toBe('דרום מחוז');
    const arc = await app.inject({ method: 'POST', url: `/v1/branches/${br.id}/archive`, headers: H(t) });
    expect(arc.json().branch.active).toBe(false);
    const w = await fm();
    expect((await app.inject({ method: 'POST', url: '/v1/orgs/org-1/branches', headers: H(w), payload: { name: 'x', clientMutationId: cm('fmbr') } })).statusCode).toBe(403);
  });
});

describe('§24 report list + read state', () => {
  it('lists org reports, filters by status/unread, per-manager readAt', async () => {
    const t = await admin();
    const f = await fm();
    // worker files a blocked report via the existing surface
    const rep = (await app.inject({ method: 'POST', url: '/v1/reports', headers: H(f),
      payload: { taskId: 't1', clientReportId: 'cr-1', status: 'blocked', clientTimestamp: new Date().toISOString(), noteHe: 'אין מפתח' } })).json().report;
    expect(rep.status).toBe('blocked');
    const list1 = (await app.inject({ method: 'GET', url: '/v1/reports?status=blocked', headers: H(t) })).json().reports;
    expect(list1.map((r: { id: string }) => r.id)).toContain(rep.id);
    expect(list1.find((r: { id: string }) => r.id === rep.id).readAt).toBeUndefined();
    // unread filter includes it, then mark read and it drops out of unread
    expect((await app.inject({ method: 'GET', url: '/v1/reports?unread=true', headers: H(t) })).json().reports.map((r: { id: string }) => r.id)).toContain(rep.id);
    await app.inject({ method: 'POST', url: `/v1/reports/${rep.id}/read`, headers: H(t) });
    expect((await app.inject({ method: 'GET', url: '/v1/reports?unread=true', headers: H(t) })).json().reports.map((r: { id: string }) => r.id)).not.toContain(rep.id);
    // repeat mark-read is a no-op without a second audit row
    const auditBefore = (await repo.listAudit('org-1')).filter(r => r.action === 'report.mark_read').length;
    await app.inject({ method: 'POST', url: `/v1/reports/${rep.id}/read`, headers: H(t) });
    const auditAfter = (await repo.listAudit('org-1')).filter(r => r.action === 'report.mark_read').length;
    expect(auditBefore).toBe(1);
    expect(auditAfter).toBe(1);
    // readAt is per-manager: fm still sees it unread
    const fmList = (await app.inject({ method: 'GET', url: '/v1/reports?unread=true', headers: H(f) })).json().reports;
    expect(fmList.map((r: { id: string }) => r.id)).toContain(rep.id);
    // §24: blocked report spawned a report_blocked notification job to admins
    const jobs = (await repo.listNotificationJobs('e1')).filter(j => j.kind === 'report_blocked');
    expect(jobs.length).toBe(1);
    expect(jobs[0].idempotencyKey).toBe(`report_blocked:${rep.id}`);
    expect(jobs[0].targets.every((x: { channel: string }) => x.channel === 'in_app')).toBe(true);
  });
});

describe('§25 inbound opt-out webhook', () => {
  it('fail-closed without secret; 401 on bad secret; uniform response on every STOP path', async () => {
    // fail-closed: no test mode, no secret -> 503
    delete process.env.CONTAKE_TEST_MODE;
    const payload = { channel: 'sms', receivingAccount: 'org-1', from: '+972500000077', body: 'הסרה' };
    expect((await app.inject({ method: 'POST', url: '/v1/webhooks/inbound', payload })).statusCode).toBe(503);
    // with a secret configured: bad secret -> 401
    process.env.CONTAKE_INBOUND_SECRET = 's3cret';
    expect((await app.inject({ method: 'POST', url: '/v1/webhooks/inbound', headers: { 'x-inbound-secret': 'wrong' }, payload })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v1/webhooks/inbound', headers: { 'x-inbound-secret': 's3cret' }, payload })).statusCode).toBe(200);
    delete process.env.CONTAKE_INBOUND_SECRET;
  });

  it('STOP revokes modelled ExternalParty consent; response never reveals path', async () => {
    const t = await admin();
    const p = (await app.inject({ method: 'POST', url: '/v1/orgs/org-1/stakeholders', headers: H(t),
      payload: { kind: 'supplier', displayName: 'ספק', contactRefs: [{ channel: 'sms', value: '+972500000077' }], clientMutationId: cm('stopparty') } })).json().party;
    const res = await app.inject({ method: 'POST', url: '/v1/webhooks/inbound', payload: { channel: 'sms', receivingAccount: 'org-1', from: '+972500000077', body: 'הסרה' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ handled: 1 });
    expect((await repo.getExternalParty(p.id))!.consent.status).toBe('revoked');
    // machine-principal audit taxonomy
    const rows = (await repo.listAudit('org-1')).filter(r => r.action === 'channel.optout');
    expect(rows.length).toBe(1);
    expect(rows[0].actorUserId).toBe('system-inbound');
    expect(rows[0].role).toBe('system');
    expect(rows[0].entityType).toBe('external_party');
    // unmodelled address: durable global suppression, same uniform response
    const res2 = await app.inject({ method: 'POST', url: '/v1/webhooks/inbound', payload: { channel: 'sms', receivingAccount: 'org-1', from: '+972599999999', body: 'STOP' } });
    expect(res2.statusCode).toBe(200);
    expect(res2.json()).toEqual({ handled: 1 });
    expect((await repo.listOptoutSuppressions(null)).length).toBe(1);
    // replay of the same STOP: idempotent 200 + replayed header, no second suppression
    const res3 = await app.inject({ method: 'POST', url: '/v1/webhooks/inbound', payload: { channel: 'sms', receivingAccount: 'org-1', from: '+972599999999', body: 'STOP' } });
    expect(res3.statusCode).toBe(200);
    expect(res3.headers['idempotency-replayed']).toBe('true');
    expect((await repo.listOptoutSuppressions(null)).length).toBe(1);
    // non-opt-out text handled=0
    const res4 = await app.inject({ method: 'POST', url: '/v1/webhooks/inbound', payload: { channel: 'sms', receivingAccount: 'org-1', from: '+972500000001', body: 'שלום' } });
    expect(res4.json().handled).toBe(0);
    // missing required fields -> 400
    expect((await app.inject({ method: 'POST', url: '/v1/webhooks/inbound', payload: { from: 'x', body: 'STOP' } })).statusCode).toBe(400);
  });
});
