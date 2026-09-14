import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo } from './helpers/repo.js';

let app: FastifyInstance;
let repo: GraphRepository;

const AT = '2026-09-14T';
const move = (hhmm: string): string => `${AT}${hhmm}:00+03:00`;

beforeEach(async () => {
  repo = await makeTestRepo();
  app = buildApp(repo, new AuthService(repo));
  await app.ready();
});

const login = async (email: string, password: string): Promise<string> => {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
};
const otpLogin = async (phone: string): Promise<string> => {
  const req = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone } });
  const code = req.json().devCode as string;
  const res = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
};
const H = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });

describe('auth', () => {
  it('rejects missing/invalid tokens with 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/events' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/events', headers: H('bad.token') })).statusCode).toBe(401);
  });
  it('rejects bad credentials, accepts good ones', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@camp.local', password: 'wrong' } })).statusCode).toBe(401);
    await login('admin@camp.local', 'admin123');
  });
  it('OTP flow works and rate-limits the 6th request (ISO-3)', async () => {
    await otpLogin('+972500000001');
    let last = 0;
    for (let i = 0; i < 6; i++) {
      last = (await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: '+972500000009' } })).statusCode;
    }
    expect(last).toBe(429);
  });
});

describe('E2E-2 flagship slip (admin applies, targeted notifications)', () => {
  it('moves t1 +45, cascades 5 tasks, notifies exactly 3 staff + 28 parents, audits', async () => {
    const token = await login('admin@camp.local', 'admin123');
    const t1 = (await repo.getTask('t1'))!;
    const res = await app.inject({
      method: 'PATCH', url: '/v1/tasks/t1', headers: H(token),
      payload: { version: t1.version, move: { newStart: move('08:15') } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.applied.domino.ok).toBe(true);
    expect(body.applied.domino.movedTasks.map((m: { taskId: string }) => m.taskId).sort()).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(body.applied.domino.summaryHe).toBe('אפקט דומינו: 4 משימות תלויות יזוזו (ארוחת בוקר)');
    expect((await repo.getTask('t6'))!.start).toBe(move('12:00')); // locked, unmoved
    expect((await repo.getTask('t2'))!.start).toBe(move('08:45'));

    const jobs = await repo.listNotificationJobs('e1');
    const targets = jobs.flatMap(j => j.targets);
    const staff = targets.filter(t => t.address.startsWith('+9725000000'));
    const parents = targets.filter(t => t.address.startsWith('+972521'));
    expect(staff.length).toBe(3);
    expect(parents.length).toBe(28);
    expect(targets.length).toBe(31); // recipient-set EQUALITY (AC-NOT-1)

    const auditEntries = (await repo.listAudit('org-1')).filter(a => a.eventId === 'e1');
    expect(auditEntries.length).toBeGreaterThanOrEqual(5);
    expect(auditEntries.every(a => a.actorUserId === 'u-admin' && a.beforeJson !== undefined)).toBe(true);
  });
});

describe('E2E-3/E2E-4 field escalation + reject', () => {
  it('field_manager S3 change becomes pending CR; graph untouched; admin approves atomically', async () => {
    const fm = await login('fm@camp.local', 'fm12345');
    const t1 = (await repo.getTask('t1'))!;
    const res = await app.inject({
      method: 'PATCH', url: '/v1/tasks/t1', headers: H(fm),
      payload: { version: t1.version, move: { newStart: move('08:15') } },
    });
    expect(res.statusCode).toBe(200);
    const cr = res.json().changeRequest;
    expect(cr.state).toBe('pending_review');
    expect(cr.reasonHe).toContain('הורים'); // Stage 1: camp externalStakeholderLabel
    expect((await repo.getTask('t1'))!.start).toBe(move('07:30')); // untouched pre-approval (AC-RBAC-7)
    // no stakeholder notification pre-approval (AC-NOT-5)
    const preJobs = await repo.listNotificationJobs('e1');
    expect(preJobs.every(j => j.kind === 'change_needs_approval')).toBe(true);
    expect(preJobs[0]!.targets.every(t => t.channel === 'in_app')).toBe(true);

    const admin = await login('admin@camp.local', 'admin123');
    const ok = await app.inject({ method: 'POST', url: `/v1/changes/${cr.id}/approve`, headers: H(admin) });
    expect(ok.statusCode).toBe(200);
    expect((await repo.getTask('t2'))!.start).toBe(move('08:45'));
    expect((await repo.getChangeRequest(cr.id))!.state).toBe('approved');
    // double approve => 409 (AC-DOM-6)
    expect((await app.inject({ method: 'POST', url: `/v1/changes/${cr.id}/approve`, headers: H(admin) })).statusCode).toBe(409);
    // audit links the CR
    const linked = (await repo.listAudit('org-1')).filter(a => a.changeRequestId === cr.id);
    expect(linked.length).toBeGreaterThan(0);
  });

  it('reject leaves graph untouched and cannot be approved after', async () => {
    const fm = await login('fm@camp.local', 'fm12345');
    const res = await app.inject({
      method: 'PATCH', url: '/v1/tasks/t1', headers: H(fm),
      payload: { version: 1, move: { newStart: move('08:15') } },
    });
    const cr = res.json().changeRequest;
    const admin = await login('admin@camp.local', 'admin123');
    const rej = await app.inject({ method: 'POST', url: `/v1/changes/${cr.id}/reject`, headers: H(admin), payload: { reasonHe: 'לא מתאים היום' } });
    expect(rej.statusCode).toBe(200);
    expect((await repo.getTask('t1'))!.start).toBe(move('07:30'));
    expect((await repo.listNotificationJobs('e1')).every(j => j.kind === 'change_needs_approval')).toBe(true);
    expect((await app.inject({ method: 'POST', url: `/v1/changes/${cr.id}/approve`, headers: H(admin) })).statusCode).toBe(409);
  });

  it('stale base version => 409, never force-applied (AC-RBAC-6)', async () => {
    const fm = await login('fm@camp.local', 'fm12345');
    const res = await app.inject({
      method: 'PATCH', url: '/v1/tasks/t1', headers: H(fm),
      payload: { version: 1, move: { newStart: move('08:15') } },
    });
    const cr = res.json().changeRequest;
    const admin = await login('admin@camp.local', 'admin123');
    // intervening admin change bumps the graph version
    await app.inject({ method: 'PATCH', url: '/v1/tasks/t7', headers: H(admin), payload: { version: 1, move: { newStart: move('15:00') } } });
    const stale = await app.inject({ method: 'POST', url: `/v1/changes/${cr.id}/approve`, headers: H(admin) });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('STALE_BASE');
    expect((await repo.getTask('t1'))!.start).toBe(move('07:30'));
  });
});

describe('E2E-5 focus loop (minimization, reportApplyRule, dedupe)', () => {
  it('focus worker sees only own tasks; report on other task denied; S0 auto-applies; dedupe', async () => {
    const w1 = await otpLogin('+972500000001'); // linked r-g1
    const graph = (await app.inject({ method: 'GET', url: '/v1/events/e1/graph', headers: H(w1) })).json();
    const taskIds = graph.tasks.map((t: { id: string }) => t.id).sort();
    expect(taskIds).toEqual(['t1', 't2', 't3', 't7']); // own tasks only (AC-RBAC-4)
    expect(graph.dependencies).toEqual([]);
    // report on someone else's task (t4 = מדריך ב)
    const denied = await app.inject({
      method: 'POST', url: '/v1/reports', headers: H(w1),
      payload: { taskId: 't4', status: 'delayed', delayMin: 30, clientReportId: 'r-x1', clientTimestamp: move('09:50') },
    });
    expect(denied.statusCode).toBe(403);
    // own unlocked S0 task auto-applies (reportApplyRule)
    const ok = await app.inject({
      method: 'POST', url: '/v1/reports', headers: H(w1),
      payload: { taskId: 't7', status: 'delayed', delayMin: 30, clientReportId: 'r-1', clientTimestamp: move('14:05') },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().applied.domino.movedTasks.map((m: { taskId: string }) => m.taskId)).toEqual(['t7']);
    expect((await repo.getTask('t7'))!.start).toBe(move('14:30'));
    // double-tap: same clientReportId => one report (AC-FR-5)
    const dup = await app.inject({
      method: 'POST', url: '/v1/reports', headers: H(w1),
      payload: { taskId: 't7', status: 'delayed', delayMin: 30, clientReportId: 'r-1', clientTimestamp: move('14:05') },
    });
    expect(dup.json().deduped).toBe(true);
    expect((await repo.listReports('e1')).filter(r => r.clientReportId === 'r-1').length).toBe(1);
  });

  it('delay report with external impact (S3) becomes pending_review; task unmoved', async () => {
    const w1 = await otpLogin('+972500000001');
    const res = await app.inject({
      method: 'POST', url: '/v1/reports', headers: H(w1),
      payload: { taskId: 't3', status: 'delayed', delayMin: 30, clientReportId: 'r-2', clientTimestamp: move('08:50') },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().changeRequest.state).toBe('pending_review');
    expect((await repo.getTask('t3'))!.start).toBe(move('08:45'));
  });
});

describe('isolation (ISO-1/2/4) + concurrency + cycle guard', () => {
  it('cross-org access is invisible: 404 on graph, own org only in lists', async () => {
    const bAdmin = await login('admin@film.local', 'admin123');
    expect((await app.inject({ method: 'GET', url: '/v1/events/e1/graph', headers: H(bAdmin) })).statusCode).toBe(404);
    const events = (await app.inject({ method: 'GET', url: '/v1/events', headers: H(bAdmin) })).json().events;
    expect(events.map((e: { id: string }) => e.id)).toEqual(['f1']);
    expect((await app.inject({ method: 'GET', url: '/v1/audit?eventId=e1', headers: H(bAdmin) })).json().audit).toEqual([]);
  });
  it('field_manager graph is site-filtered; compute on other site 403s; audit/notifications restricted', async () => {
    const fm = await login('fm@camp.local', 'fm12345');
    const graph = (await app.inject({ method: 'GET', url: '/v1/events/e2/graph', headers: H(fm) })).json();
    expect(graph.tasks.map((t: { id: string }) => t.id)).toEqual(['ta1']); // site-2 absent (AC-ISO-2)
    const compute = await app.inject({
      method: 'POST', url: '/v1/domino/compute', headers: H(fm),
      payload: { eventId: 'e2', change: { type: 'task.move', taskId: 'ta2', newStart: move('10:00') } },
    });
    expect(compute.statusCode).toBe(403);
    const w1 = await otpLogin('+972500000001');
    expect((await app.inject({ method: 'GET', url: '/v1/audit', headers: H(w1) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/notifications?eventId=e1', headers: H(fm) })).statusCode).toBe(403);
  });
  it('optimistic concurrency: stale task version => 409 Hebrew (AC-FR-1)', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const res = await app.inject({
      method: 'PATCH', url: '/v1/tasks/t7', headers: H(admin),
      payload: { version: 99, move: { newStart: move('15:00') } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('VERSION_CONFLICT');
  });
  it('dependency cycle rejected with Hebrew message naming members (AC-GRAPH-1)', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const res = await app.inject({
      method: 'POST', url: '/v1/events/e1/dependencies', headers: H(admin),
      payload: { fromTaskId: 't1', toTaskId: 't5', lagMin: 0, hard: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('DEPENDENCY_CYCLE');
    expect(res.json().error.messageHe).toContain('איסוף באוטובוס');
  });
  it('focus worker cannot touch admin endpoints (server-side only, AC-RBAC-3)', async () => {
    const w1 = await otpLogin('+972500000001');
    expect((await app.inject({ method: 'PATCH', url: '/v1/tasks/t1', headers: H(w1), payload: { version: 1, move: { newStart: move('08:15') } } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/v1/domino/compute', headers: H(w1), payload: { eventId: 'e1', change: { type: 'task.move', taskId: 't1', newStart: move('08:15') } } })).statusCode).toBe(403);
  });
});

describe('M1 review Sev-2 regressions (contracts v1.2)', () => {
  it('event.create CR approval creates the event and re-points the CR', async () => {
    const fm = await login('fm@camp.local', 'fm12345');
    const res = await app.inject({
      method: 'POST', url: '/v1/events', headers: H(fm),
      payload: { name: 'טיול שנתי', date: '2026-10-01', timezone: 'Asia/Jerusalem', domainProfileId: 'camp', siteIds: ['s9'] },
    });
    expect(res.statusCode).toBe(200);
    const cr = res.json().changeRequest;
    expect(cr.state).toBe('pending_review');
    expect(cr.eventId).toBe('pending');

    const admin = await login('admin@camp.local', 'admin123');
    const ok = await app.inject({ method: 'POST', url: `/v1/changes/${cr.id}/approve`, headers: H(admin) });
    expect(ok.statusCode).toBe(200); // was 404 pre-fix
    const resolved = ok.json().changeRequest;
    expect(resolved.state).toBe('approved');
    expect(resolved.eventId).not.toBe('pending');
    // the event now exists and is visible
    const events = (await app.inject({ method: 'GET', url: '/v1/events', headers: H(admin) })).json().events;
    const created = events.find((e: { id: string }) => e.id === resolved.eventId);
    expect(created?.name).toBe('טיול שנתי');
    expect((await repo.getEvent(resolved.eventId))?.orgId).toBe('org-1');
    // audit trail carries the real event id, linked to the CR
    const entries = (await repo.listAudit('org-1')).filter(a => a.changeRequestId === cr.id);
    expect(entries.some(a => a.action === 'event.create' && a.eventId === resolved.eventId)).toBe(true);
    // double approve => 409
    expect((await app.inject({ method: 'POST', url: `/v1/changes/${cr.id}/approve`, headers: H(admin) })).statusCode).toBe(409);
  });

  it('rejection reason is persisted on the CR and visible to the proposer', async () => {
    const fm = await login('fm@camp.local', 'fm12345');
    const res = await app.inject({
      method: 'PATCH', url: '/v1/tasks/t1', headers: H(fm),
      payload: { version: 1, move: { newStart: move('08:15') } },
    });
    const cr = res.json().changeRequest;
    const admin = await login('admin@camp.local', 'admin123');
    const rej = await app.inject({
      method: 'POST', url: `/v1/changes/${cr.id}/reject`, headers: H(admin),
      payload: { reasonHe: 'אין אוטובוס נוסף זמין' },
    });
    expect(rej.statusCode).toBe(200);
    expect(rej.json().changeRequest.rejectionReasonHe).toBe('אין אוטובוס נוסף זמין');
    expect((await repo.getChangeRequest(cr.id))!.rejectionReasonHe).toBe('אין אוטובוס נוסף זמין');
    // proposer (field_manager) sees the reason via the changes list
    const list = (await app.inject({ method: 'GET', url: '/v1/changes?state=rejected', headers: H(fm) })).json().changeRequests;
    const mine = list.find((c: { id: string }) => c.id === cr.id);
    expect(mine?.rejectionReasonHe).toBe('אין אוטובוס נוסף זמין');
    // focus worker proposer path: own CRs are visible to them too
    const w1 = await otpLogin('+972500000001');
    const rep = await app.inject({
      method: 'POST', url: '/v1/reports', headers: H(w1),
      payload: { taskId: 't3', status: 'delayed', delayMin: 30, clientReportId: 'r-9', clientTimestamp: move('08:50') },
    });
    const wcr = rep.json().changeRequest;
    await app.inject({ method: 'POST', url: `/v1/changes/${wcr.id}/reject`, headers: H(admin), payload: { reasonHe: 'נדחה' } });
    const wlist = (await app.inject({ method: 'GET', url: '/v1/changes', headers: H(w1) })).json().changeRequests;
    expect(wlist.find((c: { id: string }) => c.id === wcr.id)?.rejectionReasonHe).toBe('נדחה');
  });
});

describe('QA-M1-3 delete vs cancel on published tasks', () => {
  it('delete of published task with subscribers => 409; cancel emits S3 impact', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const del = await app.inject({ method: 'DELETE', url: '/v1/tasks/t4', headers: H(admin) });
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe('TASK_HAS_SUBSCRIBERS');
    expect(await repo.getTask('t4')).toBeDefined();
    // cancel path works and notifies
    const cancel = await app.inject({
      method: 'PATCH', url: '/v1/tasks/t4', headers: H(admin),
      payload: { version: 1, patch: { status: 'cancelled' } },
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().applied.domino.maxImpactClass).toBe('S3');
    expect((await repo.getTask('t4'))!.status).toBe('cancelled');
  });
  it('delete of draft task without subscribers is allowed', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const res = await app.inject({ method: 'DELETE', url: '/v1/tasks/ta1', headers: H(admin) });
    expect(res.statusCode).toBe(200);
    expect(await repo.getTask('ta1')).toBeUndefined();
  });
});

describe('M2 reassignment fanout (contracts v1.3, spec v1.2 §2א)', () => {
  it('pure task.assign notifies added+removed persons only — zero group/external fanout', async () => {
    const admin = await login('admin@camp.local', 'admin123');
    const t7 = (await repo.getTask('t7'))!;
    expect(t7.assigneeResourceIds).toContain('r-g1');
    const res = await app.inject({
      method: 'PATCH', url: '/v1/tasks/t7', headers: H(admin),
      payload: { version: t7.version, assign: { assigneeResourceIds: ['r-g2'] } },
    });
    expect(res.statusCode).toBe(200);
    const jobs = await repo.listNotificationJobs('e1');
    const assigned = jobs.filter(j => j.kind === 'task_assigned');
    const unassigned = jobs.filter(j => j.kind === 'task_unassigned');
    expect(assigned.length).toBe(1);
    expect(assigned[0]!.targets).toEqual([{ channel: 'whatsapp', address: '+972500000002', recipientLabel: 'מדריך ב' }]);
    expect(assigned[0]!.templateKey).toBe('task_assigned');
    expect(unassigned.length).toBe(1);
    expect(unassigned[0]!.targets).toEqual([{ channel: 'whatsapp', address: '+972500000001', recipientLabel: 'מדריך א' }]);
    // no parent/group targets at all (recipient-set equality, spec: persons only)
    const all = jobs.flatMap(j => j.targets.map(t => t.address));
    expect(all.some(a => a.startsWith('+972521'))).toBe(false);
    expect(jobs.every(j => j.kind === 'task_assigned' || j.kind === 'task_unassigned')).toBe(true);
    // immediate: no quiet-hours hold on staff-internal jobs
    expect(jobs.every(j => j.holdUntil === undefined)).toBe(true);
  });
});
