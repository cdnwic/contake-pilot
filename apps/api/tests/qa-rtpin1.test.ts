import { expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import { MemoryGraphRepository } from '../src/repo/memory.js';
import { seedDemo } from '../src/seed.js';
import { appEvents } from '../src/services/events.js';

it('RT-PIN-1: report-originated CR emits change.pending + records change_needs_approval job', async () => {
  const repo = MemoryGraphRepository.seeded(seedDemo());
  const app = buildApp(repo, new AuthService(repo));
  await app.ready();
  const events: string[] = [];
  const unsub = appEvents.subscribe(e => events.push(e.type));
  const req = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: '+972500000001' } });
  const w1 = (await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: '+972500000001', code: req.json().devCode } })).json().token as string;
  const r = await app.inject({ method: 'POST', url: '/v1/reports', headers: { authorization: `Bearer ${w1}` }, payload: { taskId: 't1', status: 'delayed', delayMin: 90, clientReportId: 'rtpin1', clientTimestamp: '2026-09-14T08:05:00+03:00' } });
  const cr = r.json().changeRequest;
  console.log('CR:', !!cr, 'events:', events.join(','));
  const jobs = (await repo.listNotificationJobsAll()).filter(j => j.kind === 'change_needs_approval');
  console.log('approval jobs:', jobs.length, 'targets:', jobs[0]?.targets.map(t => `${t.channel}:${t.address}`).join(','));
  unsub(); await app.close();
  expect(cr).toBeTruthy();
  expect(events).toContain('change.pending');
  expect(jobs.length).toBeGreaterThan(0);
  expect(jobs[0]!.targets.every(t => t.channel === 'in_app')).toBe(true); // admins only
});

it('RT-PIN-1 (event.create CR): approval job must now exist (post-fix assertion)', async () => {
  const repo = MemoryGraphRepository.seeded(seedDemo());
  const app = buildApp(repo, new AuthService(repo));
  await app.ready();
  const events: string[] = [];
  const unsub = appEvents.subscribe(e => events.push(e.type));
  const fm = (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'fm@camp.local', password: 'fm12345' } })).json().token as string;
  const r = await app.inject({ method: 'POST', url: '/v1/events', headers: { authorization: `Bearer ${fm}` }, payload: { name: 'אירוע חדש', date: '2026-09-20', timezone: 'Asia/Jerusalem', domainProfileId: 'camp', siteIds: ['site-1'] } });
  const jobs = (await repo.listNotificationJobsAll()).filter(j => j.kind === 'change_needs_approval');
  console.log('event.create -> status', r.statusCode, 'events:', events.join(','), 'approval jobs:', jobs.length);
  unsub(); await app.close();
  expect(events).toContain('change.pending');
  const cr = r.json().changeRequest;
  expect(jobs.length, 'event.create CR must record an approval job (RT-PIN-1)').toBe(1);
  expect(jobs[0]!.eventId).toBe('pending');
  expect(jobs[0]!.targets.map(t => t.address)).toEqual(['u-admin']);
  expect(jobs[0]!.targets.every(t => t.channel === 'in_app')).toBe(true);
  expect(jobs[0]!.idempotencyKey).toContain(cr.id);
});
