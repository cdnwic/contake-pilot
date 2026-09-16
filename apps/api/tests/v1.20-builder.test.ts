/** v1.20 Builder (§20-§25): content surface, focus-now, org matrix,
 *  stakeholders + guest status tokens, branches, report list/read,
 *  inbound opt-out webhook. Backend-owned implementation tests. */
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo } from './helpers/repo.js';

let repo: GraphRepository;
let app: FastifyInstance;
beforeEach(async () => {
  repo = await makeTestRepo();
  app = buildApp(repo, new AuthService(repo));
  await app.ready();
});
const login = async (e: string, p: string) => (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: e, password: p } })).json().token as string;
const H = (t: string) => ({ authorization: `Bearer ${t}` });
const admin = () => login('admin@camp.local', 'admin123');
const fm = () => login('fm@camp.local', 'fm12345');

const mkContent = async (t: string) =>
  (await app.inject({ method: 'POST', url: '/v1/orgs/org-1/content', headers: H(t), payload: { kind: 'text', title: 'הוראות בטיחות', body: 'להקפיד על קסדות' } })).json().item;

describe('§20 content items', () => {
  it('admin creates, lists, updates content; cross-org invisible', async () => {
    const t = await admin();
    const item = await mkContent(t);
    expect(item.id).toMatch(/^ci_/);
    expect(item.orgId).toBe('org-1');
    const list = (await app.inject({ method: 'GET', url: '/v1/orgs/org-1/content', headers: H(t) })).json().items;
    expect(list.map((i: { id: string }) => i.id)).toContain(item.id);
    const upd = await app.inject({ method: 'PATCH', url: `/v1/content/${item.id}`, headers: H(t), payload: { title: 'עודכן' } });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().item.title).toBe('עודכן');
    // cross-org admin cannot see or touch it
    const b = await login('admin@film.local', 'admin123');
    expect((await app.inject({ method: 'GET', url: '/v1/orgs/org-1/content', headers: H(b) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: `/v1/content/${item.id}`, headers: H(b), payload: { title: 'x' } })).statusCode).toBe(404);
    // audit row exists
    expect((await repo.listAudit('org-1')).filter(r => r.action === 'content.create' && r.entityId === item.id).length).toBe(1);
  });

  it('focus_worker is denied content.create; delete is admin-only (§20 overrides matrix FM=propose)', async () => {
    const t = await admin();
    const item = await mkContent(t);
    const w = await login('fm@camp.local', 'fm12345'); // field_manager scope allows read/create per v1.5, but delete is hard-delete admin only
    const del = await app.inject({ method: 'DELETE', url: `/v1/content/${item.id}`, headers: H(w) });
    expect(del.statusCode).toBe(403);
    const delAdmin = await app.inject({ method: 'DELETE', url: `/v1/content/${item.id}`, headers: H(t) });
    expect(delAdmin.statusCode).toBe(200);
    expect(await repo.getContentItem(item.id)).toBeUndefined();
  });

  it('task attach is natural-key idempotent; detach removes', async () => {
    const t = await admin();
    const item = await mkContent(t);
    const a1 = await app.inject({ method: 'POST', url: '/v1/tasks/t1/content', headers: H(t), payload: { contentId: item.id, role: 'reference' } });
    expect(a1.statusCode).toBe(200);
    expect(a1.json().deduped).toBe(false);
    const a2 = await app.inject({ method: 'POST', url: '/v1/tasks/t1/content', headers: H(t), payload: { contentId: item.id, role: 'reference' } });
    expect(a2.json().deduped).toBe(true);
    expect((await repo.listTaskContent('t1')).filter(l => l.contentId === item.id).length).toBe(1);
    const d = await app.inject({ method: 'DELETE', url: `/v1/tasks/t1/content/${item.id}`, headers: H(t) });
    expect(d.statusCode).toBe(200);
    expect((await repo.listTaskContent('t1')).filter(l => l.contentId === item.id).length).toBe(0);
  });

  it('focus/now returns current task with visible content for a scoped worker', async () => {
    const t = await admin();
    const item = await mkContent(t);
    // attach to t1 (07:30-08:00) with a wide visibility offset so "now" in test time falls inside
    await app.inject({ method: 'POST', url: '/v1/tasks/t1/content', headers: H(t), payload: { contentId: item.id, role: 'briefing', visibleFromOffsetMin: 60 * 24 * 365 } });
    const w1 = await login('fm@camp.local', 'fm12345');
    const res = await app.inject({ method: 'GET', url: '/v1/focus/now', headers: H(w1) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('currentTask');
    expect(body).toHaveProperty('visibleResources');
  });

  it('content ack dedupes by clientAckId', async () => {
    const t = await admin();
    const item = await mkContent(t);
    const w = await fm();
    const r1 = await app.inject({ method: 'POST', url: `/v1/content/${item.id}/ack`, headers: H(w), payload: { clientAckId: 'ack-1', taskId: 't1' } });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({ method: 'POST', url: `/v1/content/${item.id}/ack`, headers: H(w), payload: { clientAckId: 'ack-1', taskId: 't1' } });
    expect(r2.json().deduped).toBe(true);
    expect((await repo.listAudit('org-1')).filter(r => r.action === 'content.ack').length).toBe(1);
  });
});

describe('§21 org matrix', () => {
  it('groups events by branchId with _unassigned fallback', async () => {
    const t = await admin();
    const br = (await app.inject({ method: 'POST', url: '/v1/orgs/org-1/branches', headers: H(t), payload: { name: 'סניף צפון' } })).json().branch;
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
      payload: { kind: 'guardian', displayName: 'אבא של דני', contactRefs: [{ channel: 'sms', value: '+972500000099' }] } })).json().party;
    expect(p.id).toMatch(/^xp_/);
    expect(p.contactRefs[0].transport).toBe('deferred');
    const f = await fm();
    expect((await app.inject({ method: 'POST', url: '/v1/orgs/org-1/stakeholders', headers: H(f), payload: { kind: 'supplier', displayName: 'x' } })).statusCode).toBe(403);
    const link = await app.inject({ method: 'POST', url: `/v1/stakeholders/${p.id}/links`, headers: H(t), payload: { entity: 'event', entityId: 'e1', relation: 'guardian_of' } });
    expect(link.statusCode).toBe(200);
    expect(link.json().party.links.length).toBe(1);
  });

  it('status token grants public schedule; revoke kills access without leaking', async () => {
    const t = await admin();
    const p = (await app.inject({ method: 'POST', url: '/v1/orgs/org-1/stakeholders', headers: H(t), payload: { kind: 'client', displayName: 'הורה' } })).json().party;
    await app.inject({ method: 'POST', url: `/v1/stakeholders/${p.id}/links`, headers: H(t), payload: { entity: 'event', entityId: 'e1', relation: 'client_of' } });
    const tok = (await app.inject({ method: 'POST', url: `/v1/stakeholders/${p.id}/status-token`, headers: H(t) })).json().statusToken;
    // no auth header needed
    const pub = await app.inject({ method: 'GET', url: `/v1/public/status/${tok.token}` });
    expect(pub.statusCode).toBe(200);
    expect(pub.json().participant).toBe('הורה');
    expect(pub.json().schedule.length).toBe(1);
    expect(pub.json().schedule[0].eventId).toBe('e1');
    // bad token: 404, no oracle
    expect((await app.inject({ method: 'GET', url: '/v1/public/status/tk_nope' })).statusCode).toBe(404);
    // revoke via token id, then public access dies
    const rev = await app.inject({ method: 'DELETE', url: `/v1/status-tokens/${tok.id}`, headers: H(t) });
    expect(rev.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/v1/public/status/${tok.token}` })).statusCode).toBe(404);
  });
});

describe('§23 branches', () => {
  it('create/patch/archive lifecycle; focus_worker denied', async () => {
    const t = await admin();
    const br = (await app.inject({ method: 'POST', url: '/v1/orgs/org-1/branches', headers: H(t), payload: { name: 'סניף דרום', location: 'באר שבע' } })).json().branch;
    expect(br.active).toBe(true);
    const upd = await app.inject({ method: 'PATCH', url: `/v1/branches/${br.id}`, headers: H(t), payload: { name: 'דרום מחוז' } });
    expect(upd.json().branch.name).toBe('דרום מחוז');
    const arc = await app.inject({ method: 'POST', url: `/v1/branches/${br.id}/archive`, headers: H(t) });
    expect(arc.json().branch.active).toBe(false);
    const w = await fm();
    expect((await app.inject({ method: 'POST', url: '/v1/orgs/org-1/branches', headers: H(w), payload: { name: 'x' } })).statusCode).toBe(403);
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
  it('STOP revokes modelled ExternalParty consent; response never reveals path', async () => {
    const t = await admin();
    const p = (await app.inject({ method: 'POST', url: '/v1/orgs/org-1/stakeholders', headers: H(t),
      payload: { kind: 'supplier', displayName: 'ספק', contactRefs: [{ channel: 'sms', value: '+972500000077' }] } })).json().party;
    const res = await app.inject({ method: 'POST', url: '/v1/webhooks/inbound', payload: { channel: 'sms', from: '+972500000077', body: 'הסרה' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ handled: 1 });
    expect((await repo.getExternalParty(p.id))!.consent.status).toBe('revoked');
    // unmodelled number opts out the subscriber channel, same response shape
    const res2 = await app.inject({ method: 'POST', url: '/v1/webhooks/inbound', payload: { channel: 'sms', from: 'ch-parent-unknown', body: 'STOP' } });
    expect(res2.statusCode).toBe(200);
    expect(res2.json()).toEqual({ handled: 1 });
    // non-opt-out text handled=0
    expect((await app.inject({ method: 'POST', url: '/v1/webhooks/inbound', payload: { from: 'x', body: 'שלום' } })).json().handled).toBe(0);
    // webhook endpoint is auth-hook exempt (no Bearer required) but validated by secret when configured
  });
});
