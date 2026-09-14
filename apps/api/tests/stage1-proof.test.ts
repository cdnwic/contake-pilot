import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService, hashPasswordPure } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepoFrom } from './helpers/repo.js';
import { createDispatcher, type MessageProvider } from '../src/services/dispatch.js';
import { getProfile, PROFILES_VERSION } from '@contake/core';
import { reasonFor } from '../src/services/changes.js';

let app: FastifyInstance;
let repo: GraphRepository;

const adminUser = { userId: 'u-admin', orgId: 'org-1', name: 'מנהל', role: 'admin' as const, scopes: [], email: 'admin@x.local', passwordHash: hashPasswordPure('admin123'), active: true };

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date('2026-09-14T12:00:00+03:00').getTime(), toFake: ['Date'] });
  repo = await makeTestRepoFrom({ orgId: 'org-1', users: [adminUser], channels: [], events: [], resources: [], tasks: [], dependencies: [] });
  app = buildApp(repo, new AuthService(repo));
});
afterEach(async () => { await app.close(); vi.useRealTimers(); });

const H = (t: string) => ({ authorization: `Bearer ${t}` });
const adminLogin = async (): Promise<string> => {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@x.local', password: 'admin123' } });
  return res.json().token as string;
};

describe('Stage 1 proof: GET /v1/profiles wire contract (QA gate)', () => {
  // Authenticated boundary preserved: registry metadata rides the session.
  it('returns {version, profiles} with registry v1.3 and all 7 profiles', async () => {
    const anon = await app.inject({ method: 'GET', url: '/v1/profiles' });
    expect(anon.statusCode).toBe(401); // unauthenticated stays out
    const res = await app.inject({ method: 'GET', url: '/v1/profiles', headers: H(await adminLogin()) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.version).toBe('1.3');
    expect(body.version).toBe(PROFILES_VERSION);
    expect(body.profiles.map((p: { id: string }) => p.id).sort()).toEqual(
      ['after-school', 'camp', 'conference', 'education', 'event-production', 'film-shoot', 'logistics'].sort());
  });

  it('every profile carries all plural label fields', async () => {
    const { profiles } = (await app.inject({ method: 'GET', url: '/v1/profiles', headers: H(await adminLogin()) })).json();
    for (const p of profiles) {
      expect(p.labels.eventPlural, `${p.id}.eventPlural`).toBeTruthy();
      expect(p.labels.taskPlural, `${p.id}.taskPlural`).toBeTruthy();
      for (const k of ['person', 'equipment', 'location', 'group']) {
        expect(p.labels.resourcePlural[k], `${p.id}.resourcePlural.${k}`).toBeTruthy();
      }
      for (const r of ['admin', 'field_manager', 'focus_worker']) {
        expect(p.labels.rolePlural[r], `${p.id}.rolePlural.${r}`).toBeTruthy();
      }
    }
  });

  it('chrome is camp-only', async () => {
    const { profiles } = (await app.inject({ method: 'GET', url: '/v1/profiles', headers: H(await adminLogin()) })).json();
    for (const p of profiles) {
      if (p.id === 'camp') expect(p.labels.chrome).toEqual({ tower: 'מגדל', focus: 'ריכוז', approvals: 'אישורים', builder: 'בונה' });
      else expect(p.labels.chrome, `${p.id} must not carry camp chrome`).toBeUndefined();
    }
  });
});

describe('Stage 1 proof: domainProfileId gate on event create (QA gate)', () => {
  const base = { name: 'אירוע', date: '2026-09-15', timezone: 'Asia/Jerusalem', siteIds: ['s1'] };
  it('missing domainProfileId -> 400 with Hebrew messageHe', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/events', headers: H(await adminLogin()), payload: base });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.messageHe).toBe('חסרים שדות חובה: name, date, timezone, domainProfileId, siteIds');
  });
  it('unknown domainProfileId -> 400 UNKNOWN_PROFILE with Hebrew messageHe (distinct contract)', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/events', headers: H(await adminLogin()), payload: { ...base, domainProfileId: 'no-such-profile' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('UNKNOWN_PROFILE');
    expect(res.json().error.messageHe).toBe('פרופיל תחום לא מוכר');
    // distinct failure contracts -> distinct messages (equality N/A by design)
    const missing = await app.inject({ method: 'POST', url: '/v1/events', headers: H(await adminLogin()), payload: base });
    expect(res.json().error.messageHe).not.toBe(missing.json().error.messageHe);
  });
  it('valid camp profile still creates (regression)', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/events', headers: H(await adminLogin()), payload: { ...base, domainProfileId: 'camp' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied.event.domainProfileId).toBe('camp');
  });
});

describe('Stage 1 proof: dispatch fail-loud on corrupt profile (QA gate)', () => {
  it('unresolvable event profile throws, sends nothing, never falls back to camp vocabulary', async () => {
    await repo.createEvent({ id: 'ev-corrupt', kind: 'event', orgId: 'org-1', domainProfileId: 'corrupt-profile', name: 'x', date: '2026-09-14', timezone: 'Asia/Jerusalem', siteIds: ['s1'], status: 'published', version: 1 });
    await repo.createNotificationJob({
      id: 'job-corrupt', eventId: 'ev-corrupt', kind: 'task_moved',
      targets: [{ channel: 'whatsapp', address: '+972521000009', recipientLabel: 'x' }],
      templateKey: 'task_moved', params: { taskName: 't', newStart: '2026-09-14T10:00:00+03:00' },
      idempotencyKey: 'ev-corrupt+crx+task_moved', batchWindowSec: 60,
      createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    const calls: { to: string; body: string }[] = [];
    const provider: MessageProvider = { name: 'whatsapp', send: (to, body) => { calls.push({ to, body }); return Promise.resolve({ ok: true, providerMessageId: 'x', retryable: false }); } };
    const d = createDispatcher({ repo, providers: { whatsapp: provider, sms: provider } });
    // QA gate: worker-boundary error-monitor evidence, THEN fail loud.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let err: Error | undefined;
    try { await d.dispatchDue(); } catch (e) { err = e as Error; }
    expect(err, 'dispatch must fail loud on corrupt profile').toBeTruthy();
    expect(err!.message).toContain('corrupt-profile');
    expect(err!.message.includes('camp')).toBe(false); // no silent camp fallback
    expect(calls).toEqual([]); // nothing dispatched
    const logged = errSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(logged).toContain('[dispatch] FATAL');
    expect(logged).toContain('ev-corrupt');
    expect(logged).toContain('corrupt-profile');
    expect(logged.includes('camp fallback refused')).toBe(true);
    errSpy.mockRestore();
  });
});

describe('Stage 1 proof: seeded externalStakeholderLabel sign-off (QA gate)', () => {
  it('film-shoot / event-production / education labels flow into S3 reason text', () => {
    expect(getProfile('film-shoot').rules.externalStakeholderLabel).toBe('לקוחות');
    expect(getProfile('event-production').rules.externalStakeholderLabel).toBe('לקוחות');
    expect(getProfile('education').rules.externalStakeholderLabel).toBe('הורים');
    expect(reasonFor('S3', 'task.move', getProfile('film-shoot'))).toContain('לקוחות');
    expect(reasonFor('S3', 'task.move', getProfile('education'))).toContain('הורים');
    expect(reasonFor('S3', 'task.move')).toContain('בעלי עניין חיצוניים'); // generic fallback intact
  });
});
