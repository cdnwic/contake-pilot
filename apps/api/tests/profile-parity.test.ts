import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo, makeTestRepoFrom } from './helpers/repo.js';
import { hashPasswordPure } from '../src/auth.js';
import { createDispatcher, renderTemplate, TEMPLATE_PARAMS, type MessageProvider } from '../src/services/dispatch.js';
import { getProfile } from '@contake/core';

const PROFILES = ['camp', 'event-production', 'film-shoot', 'conference', 'logistics', 'after-school'];
const D = '2026-09-14';
const at = (hhmm: string): string => `${D}T${hhmm}:00+03:00`;

let app: FastifyInstance;
let repo: GraphRepository;

const login = async (email: string, password: string): Promise<string> => {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
};
const H = (token: string) => ({ authorization: `Bearer ${token}` });

const okProvider = (name: 'whatsapp' | 'sms', calls: { to: string; body: string }[]): MessageProvider => ({
  name,
  send: (to, body) => { calls.push({ to, body }); return Promise.resolve({ ok: true, providerMessageId: `${name}-x`, retryable: false }); },
});

/** Full API-level flow for one profile: event -> resources -> tasks -> dependency
 *  -> publish -> flagship move. Times sit inside ALL profiles' working windows. */
const runProfileFlow = async (pid: string): Promise<{ eventId: string; admin: string }> => {
  repo = await makeTestRepoFrom({
    orgId: 'org-1',
    users: [
      { userId: 'u-admin', orgId: 'org-1', name: 'מנהל', role: 'admin', scopes: [], email: 'admin@x.local', passwordHash: hashPasswordPure('admin123'), active: true },
    ],
    channels: [
      { id: 'ch-x1', orgId: 'org-1', address: '+972521000001', label: 'חוץ 1' },
      { id: 'ch-x2', orgId: 'org-1', address: '+972521000002', label: 'חוץ 2' },
    ],
    events: [], tasks: [], resources: [], dependencies: [],
  });
  app = buildApp(repo, new AuthService(repo));
  await app.ready();
  const admin = await login('admin@x.local', 'admin123');

  const ev = await app.inject({
    method: 'POST', url: '/v1/events', headers: H(admin),
    payload: { name: `אירוע ${pid}`, date: D, timezone: 'Asia/Jerusalem', domainProfileId: pid, siteIds: ['s1'] },
  });
  expect(ev.statusCode).toBe(200);
  const eventId = ev.json().applied.event.id as string;

  const mk = async (resource: Record<string, unknown>): Promise<string> => {
    const res = await app.inject({ method: 'POST', url: `/v1/events/${eventId}/resources`, headers: H(admin), payload: { resource } });
    expect(res.statusCode).toBe(200);
    return res.json().applied.createdId as string;
  };
  const personId = await mk({ resourceKind: 'person', name: 'איש צוות', exclusive: true });
  const groupId = await mk({ resourceKind: 'group', name: 'קבוצה', exclusive: false, subscriberChannelIds: ['ch-x1', 'ch-x2'] });

  await repo.createUser({ userId: 'u-staff', orgId: 'org-1', name: 'איש צוות', role: 'focus_worker', scopes: [{ eventId }], linkedResourceId: personId, phone: '+972500000099', active: true });

  const taskIds: string[] = [];
  for (const [name, start] of [['משימה א', at('14:00')], ['משימה ב', at('14:30')]] as const) {
    const res = await app.inject({
      method: 'POST', url: `/v1/events/${eventId}/tasks`, headers: H(admin),
      payload: { task: { name, durationMin: 30, siteId: 's1', start, dependsOn: [], constraints: [], status: 'planned', assigneeResourceIds: [personId, groupId] } },
    });
    expect(res.statusCode).toBe(200);
    taskIds.push(res.json().applied.createdId as string);
  }
  const dep = await app.inject({
    method: 'POST', url: `/v1/events/${eventId}/dependencies`, headers: H(admin),
    payload: { fromTaskId: taskIds[1], toTaskId: taskIds[0], lagMin: 0, hard: true },
  });
  expect(dep.statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url: `/v1/events/${eventId}/publish`, headers: H(admin) })).statusCode).toBe(200);

  const move = await app.inject({
    method: 'PATCH', url: `/v1/tasks/${taskIds[0]}`, headers: H(admin),
    payload: { version: 1, move: { newStart: at('14:15') } },
  });
  expect(move.statusCode).toBe(200);
  // (a) domino impact class per profile rules: subscribed-group move classifies S3 everywhere
  expect(move.json().applied.domino.ok).toBe(true);
  expect(move.json().applied.domino.maxImpactClass).toBe('S3');
  return { eventId, admin };
};

describe('M3-QA-1: all-six-profile API parity', () => {
  beforeEach(() => {
    // Determinism: the flow's job build reads the wall clock for quiet hours; pin a
    // daytime Date so sections (b)/(c) behave identically at any run time. Section
    // (d) re-fakes to 23:30 itself for the quiet-hours assertions.
    vi.useFakeTimers({ now: new Date('2026-09-14T12:00:00+03:00').getTime(), toFake: ['Date'] });
  });
  afterEach(() => { vi.useRealTimers(); });

  for (const pid of PROFILES) {
    it(`profile ${pid}: move -> domino S3, exact recipients, profile-rendered bodies, quiet-hours split`, async () => {
      const { eventId } = await runProfileFlow(pid);
      const profile = getProfile(pid);

      // (b) recipient set = staff + that event's external stakeholder channels only
      const jobs = (await repo.listNotificationJobsAll()).filter(j => j.eventId === eventId && j.kind === 'task_moved');
      const internal = jobs.filter(j => !j.idempotencyKey.endsWith('+external'));
      const external = jobs.filter(j => j.idempotencyKey.endsWith('+external'));
      expect(internal.length).toBe(1);
      expect(external.length).toBe(1);
      expect(internal[0]!.targets.map(t => t.address)).toEqual(['+972500000099']);
      expect(new Set(external[0]!.targets.map(t => t.address))).toEqual(new Set(['+972521000001', '+972521000002']));

      // (c) bodies render from THAT profile's notificationTemplates
      const calls: { to: string; body: string }[] = [];
      let clock = Date.now();
      const d = createDispatcher({ repo, providers: { whatsapp: okProvider('whatsapp', calls), sms: okProvider('sms', calls) }, now: () => clock });
      await d.dispatchDue();
      clock += 61_000;
      await d.dispatchDue();
      expect(new Set(calls.map(c => c.to))).toEqual(new Set(['+972500000099', '+972521000001', '+972521000002']));
      const expected = renderTemplate(profile.notificationTemplates['task_moved'] ?? '', {
        taskName: 'משימה א', newStart: at('14:15'),
      }, TEMPLATE_PARAMS['task_moved'] ?? []);
      for (const c of calls) expect(c.body).toContain(expected);

      // (d) quiet-hours split per profile rules: inside the profile's quiet window,
      // external is held to window end, internal never held (fake wall clock 23:30).
      const beforeIds = new Set((await repo.listNotificationJobsAll()).map(j => j.id));
      vi.setSystemTime(new Date('2026-09-11T23:30:00+03:00').getTime()); // timers already faked in beforeEach; re-calling useFakeTimers does not re-base
      const tasks = (await repo.snapshot(eventId))!.tasks;
      const t1 = tasks.find(t => t.name === 'משימה א')!;
      const { admin } = { admin: await login('admin@x.local', 'admin123') };
      const move2 = await app.inject({
        method: 'PATCH', url: `/v1/tasks/${t1.id}`, headers: H(admin),
        payload: { version: t1.version, move: { newStart: at('14:45') } },
      });
      expect(move2.statusCode).toBe(200);
      const jobs2 = (await repo.listNotificationJobsAll()).filter(j => j.eventId === eventId && j.kind === 'task_moved' && !beforeIds.has(j.id));
      const internal2 = jobs2.filter(j => !j.idempotencyKey.endsWith('+external'));
      const external2 = jobs2.filter(j => j.idempotencyKey.endsWith('+external'));
      expect(internal2.every(j => j.holdUntil === undefined)).toBe(true);
      expect(external2.length).toBeGreaterThan(0);
      for (const j of external2) {
        expect(j.holdUntil).toBeDefined();
        expect(j.holdUntil!.endsWith(`T${profile.rules.quietHours?.endHHMM ?? '07:00'}:00+03:00`)).toBe(true);
      }
      vi.useRealTimers();
    });
  }

  it('all 7 template keys RENDER (not just exist) for every profile', () => {
    const keys = ['task_moved', 'task_delayed', 'task_cancelled', 'task_assigned', 'task_unassigned', 'change_needs_approval', 'digest_multi_change'];
    for (const pid of PROFILES) {
      const p = getProfile(pid);
      for (const k of keys) {
        const params = Object.fromEntries((TEMPLATE_PARAMS[k] ?? []).map(n => [n, 'דוגמה']));
        const body = renderTemplate(p.notificationTemplates[k as keyof typeof p.notificationTemplates] ?? '', params, TEMPLATE_PARAMS[k] ?? []);
        expect(body.length, `${pid}/${k}`).toBeGreaterThan(0);
        expect(body, `${pid}/${k}`).not.toContain('{{');
      }
    }
  });

  it('cross-org leak: org-A change produces zero notification jobs in org-B', async () => {
    repo = await makeTestRepo();
    app = buildApp(repo, new AuthService(repo));
    await app.ready();
    const admin = await login('admin@camp.local', 'admin123');
    const res = await app.inject({ method: 'PATCH', url: '/v1/tasks/t7', headers: H(admin), payload: { version: 1, move: { newStart: at('15:00') } } });
    expect(res.statusCode).toBe(200);
    const jobs = await repo.listNotificationJobsAll();
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every(j => j.eventId === 'e1')).toBe(true);
    expect(jobs.some(j => j.eventId === 'f1')).toBe(false); // org-2's film event
  });
});
