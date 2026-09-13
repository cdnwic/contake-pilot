/** QA M3 independent parity probe: the same trigger must render each profile's DISTINCT template. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { AuthService, hashPasswordPure } from '../src/auth.js';
import { MemoryGraphRepository } from '../src/repo/memory.js';
import { createDispatcher, type MessageProvider } from '../src/services/dispatch.js';


// Determinism (QA, same repair as the TL's baseline fix): server-side job BUILD
// reads the real wall clock for quiet hours; pin a daytime Date or these probes
// go red 22:00-07:00 local. Fake ONLY Date - timeouts stay real for backoff probes.
beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-09-14T12:00:00+03:00').getTime(), toFake: ['Date'] }); });
afterEach(() => { vi.useRealTimers(); });

const CASES: [string, string][] = [
  ['camp', 'שלום, '], ['event-production', 'עדכון: '], ['film-shoot', 'עדכון צילום: '],
  ['conference', 'עדכון כנס: '], ['logistics', 'עדכון לוגיסטי: '], ['after-school', 'שלום, '],
];
const D = '2026-09-14';
const okP = (name: 'whatsapp' | 'sms', calls: { to: string; body: string }[]): MessageProvider => ({ name, send: (to, body) => { calls.push({ to, body }); return Promise.resolve({ ok: true as const, retryable: false }); } });

for (const [pid, prefix] of CASES) {
  it(`profile ${pid}: dispatched body carries the profile's distinct template prefix`, async () => {
    const repo = MemoryGraphRepository.seeded({
      orgId: 'org-1',
      users: [{ userId: 'u-admin', orgId: 'org-1', name: 'מ', role: 'admin', scopes: [], email: 'a@x.local', passwordHash: hashPasswordPure('admin123'), active: true }],
      channels: [{ id: 'ch-1', orgId: 'org-1', address: '+972521000001', label: 'חוץ' }],
      events: [], tasks: [], resources: [], dependencies: [],
    });
    const app = buildApp(repo, new AuthService(repo)); await app.ready();
    const admin = (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'a@x.local', password: 'admin123' } })).json().token as string;
    const H = { authorization: `Bearer ${admin}` };
    const ev = await app.inject({ method: 'POST', url: '/v1/events', headers: H, payload: { name: `אירוע ${pid}`, date: D, timezone: 'Asia/Jerusalem', domainProfileId: pid, siteIds: ['s1'] } });
    const eventId = ev.json().applied.event.id;
    const mk = async (resource: Record<string, unknown>) => (await app.inject({ method: 'POST', url: `/v1/events/${eventId}/resources`, headers: H, payload: { resource } })).json().applied.createdId as string;
    const person = await mk({ resourceKind: 'person', name: 'צוות', exclusive: true });
    const group = await mk({ resourceKind: 'group', name: 'קבוצה', exclusive: false, subscriberChannelIds: ['ch-1'] });
    repo.createUser({ userId: 'u-s', orgId: 'org-1', name: 'צוות', role: 'focus_worker', scopes: [{ eventId }], linkedResourceId: person, phone: '+972500000099', active: true });
    const t = await app.inject({ method: 'POST', url: `/v1/events/${eventId}/tasks`, headers: H, payload: { task: { name: 'משימה א', durationMin: 30, siteId: 's1', start: `${D}T14:00:00+03:00`, assigneeResourceIds: [person, group] } } });
    const taskId = t.json().applied.createdId;
    await app.inject({ method: 'POST', url: `/v1/events/${eventId}/publish`, headers: H });
    const mv = await app.inject({ method: 'PATCH', url: `/v1/tasks/${taskId}`, headers: H, payload: { version: 1, move: { newStart: `${D}T14:15:00+03:00` } } });
    expect(mv.statusCode).toBe(200);
    const calls: { to: string; body: string }[] = [];
    let clock = Date.now();
    const d = createDispatcher({ repo, providers: { whatsapp: okP('whatsapp', calls), sms: okP('sms', calls) }, now: () => clock });
    await d.dispatchDue(); clock += 61_000; await d.dispatchDue();
    const bodies = new Set(calls.map(c => c.body));
    console.log(`${pid}: ${calls.length} messages; bodies:`, [...bodies].map(b => b.slice(0, 40)).join(' | '));
    expect(calls.length).toBe(2); // staff + one external
    for (const b of bodies) expect(b.startsWith(prefix), `body for ${pid} must start with "${prefix}"`).toBe(true);
    await app.close();
  });
}
