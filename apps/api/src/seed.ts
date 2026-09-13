import type { GraphRepository, SeedData } from './repo/graph-repository.js';
import { hashPasswordPure } from './auth.js';

/** Demo seed: golden-corpus camp graph (org-1) + film-shoot org-2 for isolation
 *  sweeps + a two-site event for site-scope tests. Mirrors QA fixtures. */
export function seedDemo(): SeedData {
  const D = '2026-09-14';
  const at = (hhmm: string): string => `${D}T${hhmm}:00+03:00`;
  return {
    orgId: 'org-1',
    users: [
      { userId: 'u-admin', orgId: 'org-1', name: 'דנה מנהלת', role: 'admin', scopes: [], email: 'admin@camp.local', passwordHash: hashPasswordPure('admin123'), active: true },
      { userId: 'u-fm', orgId: 'org-1', name: 'יוסי רכז', role: 'field_manager', scopes: [{ eventId: 'e1', siteId: 'site-1' }, { eventId: 'e2', siteId: 'site-1' }], email: 'fm@camp.local', passwordHash: hashPasswordPure('fm12345'), active: true },
      { userId: 'u-w1', orgId: 'org-1', name: 'מדריך א', role: 'focus_worker', scopes: [{ eventId: 'e1' }], linkedResourceId: 'r-g1', phone: '+972500000001', active: true },
      { userId: 'u-w2', orgId: 'org-1', name: 'מדריך ב', role: 'focus_worker', scopes: [{ eventId: 'e1' }], linkedResourceId: 'r-g2', phone: '+972500000002', active: true },
      { userId: 'u-w3', orgId: 'org-1', name: 'מדריך ג', role: 'focus_worker', scopes: [{ eventId: 'e1' }], linkedResourceId: 'r-g3', phone: '+972500000003', active: true },
      { userId: 'u-admin-b', orgId: 'org-2', name: 'מפיק ב', role: 'admin', scopes: [], email: 'admin@film.local', passwordHash: hashPasswordPure('admin123'), active: true },
    ],
    channels: Array.from({ length: 28 }, (_, i) => ({
      id: `ch-parent-${i + 1}`, orgId: 'org-1',
      address: `+9725210${String(i + 1).padStart(4, '0')}`, label: `הורה ${i + 1}`,
    })),
    events: [
      { id: 'e1', kind: 'event', orgId: 'org-1', domainProfileId: 'camp', name: 'יום קייטנה', date: D, timezone: 'Asia/Jerusalem', siteIds: ['site-1'], status: 'published', version: 1 },
      { id: 'e2', kind: 'event', orgId: 'org-1', domainProfileId: 'camp', name: 'יום שני אתרים', date: D, timezone: 'Asia/Jerusalem', siteIds: ['site-1', 'site-2'], status: 'draft', version: 1 },
      { id: 'f1', kind: 'event', orgId: 'org-2', domainProfileId: 'film-shoot', name: 'יום צילום', date: D, timezone: 'Asia/Jerusalem', siteIds: ['site-b1'], status: 'draft', version: 1 },
    ],
    resources: [
      { id: 'r-bus', kind: 'resource', eventId: 'e1', resourceKind: 'equipment', name: 'אוטובוס', exclusive: true, version: 1 },
      { id: 'r-g1', kind: 'resource', eventId: 'e1', resourceKind: 'person', name: 'מדריך א', exclusive: true, version: 1 },
      { id: 'r-g2', kind: 'resource', eventId: 'e1', resourceKind: 'person', name: 'מדריך ב', exclusive: true, version: 1 },
      { id: 'r-g3', kind: 'resource', eventId: 'e1', resourceKind: 'person', name: 'מדריך ג', exclusive: true, version: 1 },
      { id: 'r-pool', kind: 'resource', eventId: 'e1', resourceKind: 'location', name: 'בריכה', exclusive: true, version: 1 },
      { id: 'r-gym', kind: 'resource', eventId: 'e1', resourceKind: 'location', name: 'חדר ספורט', exclusive: true, version: 1 },
      { id: 'r-grp', kind: 'resource', eventId: 'e1', resourceKind: 'group', name: 'חוג גיבורים', exclusive: false, subscriberChannelIds: Array.from({ length: 28 }, (_, i) => `ch-parent-${i + 1}`), version: 1 },
      { id: 're2-g1', kind: 'resource', eventId: 'e2', resourceKind: 'person', name: 'מדריך א', exclusive: true, version: 1 },
      { id: 're2-hall', kind: 'resource', eventId: 'e2', resourceKind: 'location', name: 'אולם', exclusive: true, version: 1 },
      { id: 'rf-cam', kind: 'resource', eventId: 'f1', resourceKind: 'equipment', name: 'מצלמה A', exclusive: true, version: 1 },
    ],
    tasks: [
      { id: 't1', kind: 'task', eventId: 'e1', siteId: 'site-1', name: 'איסוף באוטובוס', start: at('07:30'), durationMin: 30, status: 'planned', locked: false, assigneeResourceIds: ['r-bus', 'r-g1', 'r-grp'], version: 1 },
      { id: 't2', kind: 'task', eventId: 'e1', siteId: 'site-1', name: 'ארוחת בוקר', start: at('08:00'), durationMin: 45, status: 'planned', locked: false, assigneeResourceIds: ['r-g1', 'r-grp'], version: 1 },
      { id: 't3', kind: 'task', eventId: 'e1', siteId: 'site-1', name: 'פעילות חוג', start: at('08:45'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: ['r-g1', 'r-grp', 'r-gym'], version: 1 },
      { id: 't4', kind: 'task', eventId: 'e1', siteId: 'site-1', name: 'בריכה', start: at('09:45'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: ['r-g2', 'r-grp', 'r-pool'], version: 1 },
      { id: 't5', kind: 'task', eventId: 'e1', siteId: 'site-1', name: 'ספורט', start: at('10:45'), durationMin: 30, status: 'planned', locked: false, assigneeResourceIds: ['r-g3', 'r-grp', 'r-gym'], version: 1 },
      { id: 't6', kind: 'task', eventId: 'e1', siteId: 'site-1', name: 'ארוחת צהריים', start: at('12:00'), durationMin: 45, status: 'planned', locked: true, assigneeResourceIds: ['r-grp'], version: 1 },
      { id: 't7', kind: 'task', eventId: 'e1', siteId: 'site-1', name: 'משימת בודד', start: at('14:00'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: ['r-g1'], version: 1 },
      { id: 'ta1', kind: 'task', eventId: 'e2', siteId: 'site-1', name: 'פעילות אתר 1', start: at('09:00'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: ['re2-g1', 're2-hall'], version: 1 },
      { id: 'ta2', kind: 'task', eventId: 'e2', siteId: 'site-2', name: 'פעילות אתר 2', start: at('09:00'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: ['re2-hall'], version: 1 },
      { id: 'tf1', kind: 'task', eventId: 'f1', siteId: 'site-b1', name: 'סצנה 1', start: at('08:00'), durationMin: 90, status: 'planned', locked: false, assigneeResourceIds: ['rf-cam'], version: 1 },
    ],
    dependencies: [
      { id: 'd1', kind: 'depends_on', fromTaskId: 't2', toTaskId: 't1', lagMin: 0, hard: true },
      { id: 'd2', kind: 'depends_on', fromTaskId: 't3', toTaskId: 't2', lagMin: 0, hard: true },
      { id: 'd3', kind: 'depends_on', fromTaskId: 't4', toTaskId: 't3', lagMin: 0, hard: true },
      { id: 'd4', kind: 'depends_on', fromTaskId: 't5', toTaskId: 't4', lagMin: 0, hard: true },
      { id: 'd5', kind: 'depends_on', fromTaskId: 't6', toTaskId: 't5', lagMin: 0, hard: true },
    ],
  };
}

/** PR-1: adapter-neutral seeding (Postgres start on an empty database). */
export async function applySeed(repo: GraphRepository, data: SeedData): Promise<void> {
  for (const u of data.users) await repo.createUser(u);
  for (const c of data.channels) await repo.createChannel(c);
  for (const e of data.events) await repo.createEvent(e);
  for (const r of data.resources) await repo.createResource(r);
  for (const t of data.tasks) await repo.createTask(t);
  for (const d of data.dependencies) await repo.createDependency(d);
}
