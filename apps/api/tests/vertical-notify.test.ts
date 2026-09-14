/** Stage 1 proof (QA gate): externalStakeholderLabel flows through the REAL
 *  notify path per vertical - field_manager S3 proposal carries the label in
 *  the CR signoff text, and approving produces actual group-subscriber
 *  notification jobs rendered from the VERTICAL profile's templates. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import type { SeedData } from '../src/repo/graph-repository.js';
import { makeTestRepoFrom } from './helpers/repo.js';
import { createDispatcher, renderTemplate, TEMPLATE_PARAMS, type MessageProvider } from '../src/services/dispatch.js';
import { getProfile } from '@contake/core';
import { seedFilmShoot } from '../src/seeds/film-shoot.seed.js';
import { seedEventProduction } from '../src/seeds/event-production.seed.js';
import { seedEducation } from '../src/seeds/education.seed.js';

const D = '2026-09-14';
const H = (t: string) => ({ authorization: `Bearer ${t}` });

let app: FastifyInstance;
let repo: GraphRepository;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-14T12:00:00+03:00').getTime(), toFake: ['Date'] });
});
afterEach(async () => { await app.close(); vi.useRealTimers(); });

const login = async (email: string, password: string): Promise<string> => {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
};

const cases: Array<{
  name: string; seed: SeedData; profileId: string; label: string;
  fmEmail: string; adminEmail: string; taskId: string; newStart: string; channels: string[];
}> = [
  { name: 'film-shoot', seed: seedFilmShoot(D), profileId: 'film-shoot', label: 'לקוחות',
    fmEmail: 'fm@film-demo.local', adminEmail: 'admin@film-demo.local', taskId: 'tf-sc13',
    newStart: `${D}T08:30:00+03:00`, channels: ['+972521100001', '+972521100002'] },
  { name: 'event-production', seed: seedEventProduction(D), profileId: 'event-production', label: 'לקוחות',
    fmEmail: 'fm@events-demo.local', adminEmail: 'admin@events-demo.local', taskId: 'tev-doors',
    newStart: `${D}T17:15:00+03:00`, channels: [] }, // filled from seed below
  { name: 'education', seed: seedEducation(D), profileId: 'education', label: 'הורים',
    fmEmail: 'fm@edu-demo.local', adminEmail: 'admin@edu-demo.local', taskId: 'tedu-6',
    newStart: `${D}T13:00:00+03:00`, channels: [] },
];
for (const c of cases) {
  if (c.channels.length === 0) c.channels = c.seed.channels.map(ch => ch.address);
}

describe('Stage 1 proof: per-vertical external-stakeholder notify path (QA gate)', () => {
  for (const c of cases) {
    it(`${c.name}: S3 proposal names ${c.label}; approve -> external jobs in vertical vocabulary`, async () => {
      repo = await makeTestRepoFrom(c.seed);
      app = buildApp(repo, new AuthService(repo));
      const fm = await login(c.fmEmail, 'fm12345');
      const admin = await login(c.adminEmail, 'admin123');
      const task = (await repo.getTask(c.taskId))!;
      // field_manager proposes: S3 (subscribed group on the moved/cascaded set)
      const res = await app.inject({ method: 'PATCH', url: `/v1/tasks/${c.taskId}`, headers: H(fm), payload: { version: task.version, move: { newStart: c.newStart } } });
      expect(res.statusCode).toBe(200);
      const cr = res.json().changeRequest;
      expect(cr, `expected pending CR for ${c.name}`).toBeTruthy();
      expect(cr.dominoResult.maxImpactClass).toBe('S3');
      expect(cr.reasonHe).toContain(c.label); // signoff text carries the profile's stakeholder label
      // admin approves -> applied -> notification jobs
      const ok = await app.inject({ method: 'POST', url: `/v1/changes/${cr.id}/approve`, headers: H(admin) });
      expect(ok.statusCode).toBe(200);
      const jobs = await repo.listNotificationJobs(task.eventId);
      const external = jobs.filter(j => j.idempotencyKey.endsWith('+external'));
      expect(external.length, 'external group-subscriber job exists').toBeGreaterThan(0);
      const targets = external.flatMap(j => j.targets.map(t => t.address));
      for (const ch of c.channels) expect(targets).toContain(ch);
      // rendered from the VERTICAL profile's template, never camp vocabulary
      const calls: { to: string; body: string }[] = [];
      const provider: MessageProvider = { name: 'whatsapp', send: (to, body) => { calls.push({ to, body }); return Promise.resolve({ ok: true, providerMessageId: 'x', retryable: false }); } };
      let clock = Date.now();
      const d = createDispatcher({ repo, providers: { whatsapp: provider, sms: provider }, now: () => clock });
      await d.dispatchDue();
      clock += 61_000;
      await d.dispatchDue();
      const extCall = calls.find(call => c.channels.includes(call.to));
      expect(extCall, 'a subscriber channel received a rendered message').toBeTruthy();
      const vertical = getProfile(c.profileId);
      const expected = renderTemplate(
        (vertical.notificationTemplates as Record<string, string>)[external[0]!.templateKey] ?? '',
        external[0]!.params, TEMPLATE_PARAMS[external[0]!.templateKey] ?? []);
      expect(extCall!.body).toBe(expected);
      const campRender = renderTemplate(
        (getProfile('camp').notificationTemplates as Record<string, string>)[external[0]!.templateKey] ?? '',
        external[0]!.params, TEMPLATE_PARAMS[external[0]!.templateKey] ?? []);
      if (campRender !== expected) expect(extCall!.body).not.toBe(campRender); // no camp leak when templates differ
    });
  }
});
