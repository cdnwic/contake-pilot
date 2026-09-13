import type { SeedData } from '../repo/graph-repository.js';
import { hashPasswordPure } from '../auth.js';

/** Camp demo seed (plan 3ח): a rich, realistic camp-day dataset for demos and
 *  pilot dry-runs. Self-contained org (org-camp-demo) so it can be applied
 *  standalone (CONTAKE_SEED=camp-demo) or alongside the QA demo seed.
 *
 *  The graph is built so the LATE-BUS SCENARIO (אוטובוס 3 מתאחר) produces a
 *  visible, non-blocking domino: a +20min delay on the bus-3 morning pickup
 *  (cd-t-bus3) cascades through מפגש בוקר ודגל → ארוחת בוקר → both rotation
 *  rounds (8 dependent tasks), while ארוחת הצהריים stays anchored (locked) and
 *  the afternoon program is untouched. See docs/camp-demo.md. */

export const CAMP_DEMO_ORG_ID = 'org-camp-demo';
export const CAMP_DEMO_EVENT_ID = 'cd-ev1';
export const CAMP_DEMO_LATE_BUS_TASK_ID = 'cd-t-bus3';
export const CAMP_DEMO_LATE_BUS_DELAY_MIN = 20;

export function campDemoSeed(): SeedData {
  const D = '2026-09-14';
  const at = (hhmm: string): string => `${D}T${hhmm}:00+03:00`;
  const orgId = CAMP_DEMO_ORG_ID;
  const ev = CAMP_DEMO_EVENT_ID;
  const site = 'cd-site-1';

  const parents = (group: string, from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({
      id: `cd-ch-${group}-${i + 1}`, orgId,
      address: `+972547${String(from + i).padStart(6, '0')}`,
      label: `הורה ${from + i} (${group === 'a' ? 'דבורה' : group === 'b' ? 'נמלה' : 'צב'})`,
    }));

  return {
    orgId,
    users: [
      { userId: 'cd-admin', orgId, name: 'דנה אוחיון', role: 'admin', scopes: [], email: 'dana@oranim-camp.local', passwordHash: hashPasswordPure('camp-admin-1'), phone: '+972500100001', active: true },
      { userId: 'cd-rakezet', orgId, name: 'רונית לוי', role: 'field_manager', scopes: [{ eventId: ev, siteId: site }], email: 'ronit@oranim-camp.local', passwordHash: hashPasswordPure('camp-fm-1'), phone: '+972500100002', active: true },
      { userId: 'cd-rakez2', orgId, name: 'אבי שרון', role: 'field_manager', scopes: [{ eventId: ev, siteId: site }], email: 'avi@oranim-camp.local', passwordHash: hashPasswordPure('camp-fm-2'), phone: '+972500100003', active: true },
      { userId: 'cd-w1', orgId, name: 'נועה כהן', role: 'focus_worker', scopes: [{ eventId: ev }], linkedResourceId: 'cd-g1', phone: '+972500100011', active: true },
      { userId: 'cd-w2', orgId, name: 'תמר ברק', role: 'focus_worker', scopes: [{ eventId: ev }], linkedResourceId: 'cd-g2', phone: '+972500100012', active: true },
      { userId: 'cd-w3', orgId, name: 'יובל אדרי', role: 'focus_worker', scopes: [{ eventId: ev }], linkedResourceId: 'cd-g3', phone: '+972500100013', active: true },
      { userId: 'cd-w4', orgId, name: 'מאיה זיו', role: 'focus_worker', scopes: [{ eventId: ev }], linkedResourceId: 'cd-g4', phone: '+972500100014', active: true },
      { userId: 'cd-w5', orgId, name: 'עומר נבון', role: 'focus_worker', scopes: [{ eventId: ev }], linkedResourceId: 'cd-g5', phone: '+972500100015', active: true },
      { userId: 'cd-w6', orgId, name: 'הילה רם', role: 'focus_worker', scopes: [{ eventId: ev }], linkedResourceId: 'cd-g6', phone: '+972500100016', active: true },
    ],
    channels: [...parents('a', 101, 112), ...parents('b', 201, 212), ...parents('c', 301, 312)],
    events: [
      { id: ev, kind: 'event', orgId, domainProfileId: 'camp', name: 'יום קייטנה מלא — קייטנת אורנים', date: D, timezone: 'Asia/Jerusalem', siteIds: [site], status: 'published', version: 1 },
    ],
    resources: [
      { id: 'cd-bus1', kind: 'resource', eventId: ev, resourceKind: 'equipment', name: 'אוטובוס 1 (מסלול צפון)', exclusive: true, version: 1 },
      { id: 'cd-bus2', kind: 'resource', eventId: ev, resourceKind: 'equipment', name: 'אוטובוס 2 (מסלול מרכז)', exclusive: true, version: 1 },
      { id: 'cd-bus3', kind: 'resource', eventId: ev, resourceKind: 'equipment', name: 'אוטובוס 3 (מסלול דרום)', exclusive: true, version: 1 },
      { id: 'cd-g1', kind: 'resource', eventId: ev, resourceKind: 'person', name: 'נועה כהן', exclusive: true, version: 1 },
      { id: 'cd-g2', kind: 'resource', eventId: ev, resourceKind: 'person', name: 'תמר ברק', exclusive: true, version: 1 },
      { id: 'cd-g3', kind: 'resource', eventId: ev, resourceKind: 'person', name: 'יובל אדרי', exclusive: true, version: 1 },
      { id: 'cd-g4', kind: 'resource', eventId: ev, resourceKind: 'person', name: 'מאיה זיו', exclusive: true, version: 1 },
      { id: 'cd-g5', kind: 'resource', eventId: ev, resourceKind: 'person', name: 'עומר נבון', exclusive: true, version: 1 },
      { id: 'cd-g6', kind: 'resource', eventId: ev, resourceKind: 'person', name: 'הילה רם', exclusive: true, version: 1 },
      { id: 'cd-pool', kind: 'resource', eventId: ev, resourceKind: 'location', name: 'בריכה', exclusive: true, version: 1 },
      { id: 'cd-kitchen', kind: 'resource', eventId: ev, resourceKind: 'location', name: 'מטבח וחדר אוכל', exclusive: true, version: 1 },
      { id: 'cd-field', kind: 'resource', eventId: ev, resourceKind: 'location', name: 'מגרש ספורט', exclusive: true, version: 1 },
      { id: 'cd-yard', kind: 'resource', eventId: ev, resourceKind: 'location', name: 'חצר משחקים', exclusive: true, version: 1 },
      { id: 'cd-hall', kind: 'resource', eventId: ev, resourceKind: 'location', name: 'אולם', exclusive: true, version: 1 },
      { id: 'cd-grp-a', kind: 'resource', eventId: ev, resourceKind: 'group', name: 'כיתה דבורה', exclusive: false, memberIds: ['cd-g1', 'cd-g4'], subscriberChannelIds: Array.from({ length: 12 }, (_, i) => `cd-ch-a-${i + 1}`), version: 1 },
      { id: 'cd-grp-b', kind: 'resource', eventId: ev, resourceKind: 'group', name: 'כיתה נמלה', exclusive: false, memberIds: ['cd-g2', 'cd-g5'], subscriberChannelIds: Array.from({ length: 12 }, (_, i) => `cd-ch-b-${i + 1}`), version: 1 },
      { id: 'cd-grp-c', kind: 'resource', eventId: ev, resourceKind: 'group', name: 'כיתה צב', exclusive: false, memberIds: ['cd-g3', 'cd-g6'], subscriberChannelIds: Array.from({ length: 12 }, (_, i) => `cd-ch-c-${i + 1}`), version: 1 },
    ],
    tasks: [
      // --- morning pickup routes ---
      { id: 'cd-t-bus1', kind: 'task', eventId: ev, siteId: site, name: 'איסוף בוקר — אוטובוס 1 (מסלול צפון)', start: at('07:00'), durationMin: 45, status: 'planned', locked: false, assigneeResourceIds: ['cd-bus1', 'cd-g1', 'cd-grp-a'], version: 1 },
      { id: 'cd-t-bus2', kind: 'task', eventId: ev, siteId: site, name: 'איסוף בוקר — אוטובוס 2 (מסלול מרכז)', start: at('07:00'), durationMin: 45, status: 'planned', locked: false, assigneeResourceIds: ['cd-bus2', 'cd-g2', 'cd-grp-b'], version: 1 },
      { id: 'cd-t-bus3', kind: 'task', eventId: ev, siteId: site, name: 'איסוף בוקר — אוטובוס 3 (מסלול דרום)', start: at('07:15'), durationMin: 45, status: 'planned', locked: false, assigneeResourceIds: ['cd-bus3', 'cd-g3', 'cd-grp-c'], version: 1 },
      { id: 'cd-t-flag', kind: 'task', eventId: ev, siteId: site, name: 'מפגש בוקר ודגל', start: at('08:00'), durationMin: 15, status: 'planned', locked: false, assigneeResourceIds: ['cd-g1', 'cd-g2', 'cd-g3', 'cd-yard', 'cd-grp-a', 'cd-grp-b', 'cd-grp-c'], version: 1 },
      { id: 'cd-t-breakfast', kind: 'task', eventId: ev, siteId: site, name: 'ארוחת בוקר', start: at('08:15'), durationMin: 30, status: 'planned', locked: false, assigneeResourceIds: ['cd-kitchen', 'cd-grp-a', 'cd-grp-b', 'cd-grp-c'], version: 1 },
      // --- rotation round 1 (09:00) ---
      { id: 'cd-t-pool-a', kind: 'task', eventId: ev, siteId: site, name: 'בריכה — כיתה דבורה', start: at('09:00'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: ['cd-pool', 'cd-g4', 'cd-grp-a'], version: 1 },
      { id: 'cd-t-sport-b', kind: 'task', eventId: ev, siteId: site, name: 'ספורט — כיתה נמלה', start: at('09:00'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: ['cd-field', 'cd-g5', 'cd-grp-b'], version: 1 },
      { id: 'cd-t-art-c', kind: 'task', eventId: ev, siteId: site, name: 'יצירה — כיתה צב', start: at('09:00'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: ['cd-hall', 'cd-g6', 'cd-grp-c'], version: 1 },
      // --- rotation round 2 (10:15) ---
      { id: 'cd-t-sport-a', kind: 'task', eventId: ev, siteId: site, name: 'ספורט — כיתה דבורה', start: at('10:15'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: ['cd-field', 'cd-g5', 'cd-grp-a'], version: 1 },
      { id: 'cd-t-art-b', kind: 'task', eventId: ev, siteId: site, name: 'יצירה — כיתה נמלה', start: at('10:15'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: ['cd-hall', 'cd-g6', 'cd-grp-b'], version: 1 },
      { id: 'cd-t-pool-c', kind: 'task', eventId: ev, siteId: site, name: 'בריכה — כיתה צב', start: at('10:15'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: ['cd-pool', 'cd-g4', 'cd-grp-c'], version: 1 },
      // --- midday ---
      { id: 'cd-t-lunch', kind: 'task', eventId: ev, siteId: site, name: 'ארוחת צהריים חמה', start: at('12:00'), durationMin: 45, status: 'planned', locked: true, assigneeResourceIds: ['cd-kitchen', 'cd-grp-a', 'cd-grp-b', 'cd-grp-c'], version: 1 },
      { id: 'cd-t-rest', kind: 'task', eventId: ev, siteId: site, name: 'מנוחת צהריים וסיפור', start: at('13:00'), durationMin: 30, status: 'planned', locked: false, assigneeResourceIds: ['cd-hall', 'cd-grp-a', 'cd-grp-b', 'cd-grp-c'], version: 1 },
      { id: 'cd-t-field', kind: 'task', eventId: ev, siteId: site, name: 'משחקי שדה גדולים', start: at('13:45'), durationMin: 45, status: 'planned', locked: false, assigneeResourceIds: ['cd-field', 'cd-yard', 'cd-g5', 'cd-grp-a', 'cd-grp-b', 'cd-grp-c'], version: 1 },
      { id: 'cd-t-snack', kind: 'task', eventId: ev, siteId: site, name: 'חטיף אחר הצהריים והתארגנות לנסיעה', start: at('14:45'), durationMin: 30, status: 'planned', locked: false, assigneeResourceIds: ['cd-kitchen', 'cd-grp-a', 'cd-grp-b', 'cd-grp-c'], version: 1 },
      // --- buses back ---
      { id: 'cd-t-back1', kind: 'task', eventId: ev, siteId: site, name: 'פיזור אחר הצהריים — אוטובוס 1 (מסלול צפון)', start: at('15:30'), durationMin: 45, status: 'planned', locked: false, assigneeResourceIds: ['cd-bus1', 'cd-g1', 'cd-grp-a'], version: 1 },
      { id: 'cd-t-back2', kind: 'task', eventId: ev, siteId: site, name: 'פיזור אחר הצהריים — אוטובוס 2 (מסלול מרכז)', start: at('15:30'), durationMin: 45, status: 'planned', locked: false, assigneeResourceIds: ['cd-bus2', 'cd-g2', 'cd-grp-b'], version: 1 },
      { id: 'cd-t-back3', kind: 'task', eventId: ev, siteId: site, name: 'פיזור אחר הצהריים — אוטובוס 3 (מסלול דרום)', start: at('15:45'), durationMin: 45, status: 'planned', locked: false, assigneeResourceIds: ['cd-bus3', 'cd-g3', 'cd-grp-c'], version: 1 },
    ],
    dependencies: [
      { id: 'cd-d-01', kind: 'depends_on', fromTaskId: 'cd-t-flag', toTaskId: 'cd-t-bus1', lagMin: 0, hard: true },
      { id: 'cd-d-02', kind: 'depends_on', fromTaskId: 'cd-t-flag', toTaskId: 'cd-t-bus2', lagMin: 0, hard: true },
      { id: 'cd-d-03', kind: 'depends_on', fromTaskId: 'cd-t-flag', toTaskId: 'cd-t-bus3', lagMin: 0, hard: true },
      { id: 'cd-d-04', kind: 'depends_on', fromTaskId: 'cd-t-breakfast', toTaskId: 'cd-t-flag', lagMin: 0, hard: true },
      { id: 'cd-d-05', kind: 'depends_on', fromTaskId: 'cd-t-pool-a', toTaskId: 'cd-t-breakfast', lagMin: 0, hard: true },
      { id: 'cd-d-06', kind: 'depends_on', fromTaskId: 'cd-t-sport-b', toTaskId: 'cd-t-breakfast', lagMin: 0, hard: true },
      { id: 'cd-d-07', kind: 'depends_on', fromTaskId: 'cd-t-art-c', toTaskId: 'cd-t-breakfast', lagMin: 0, hard: true },
      { id: 'cd-d-08', kind: 'depends_on', fromTaskId: 'cd-t-sport-a', toTaskId: 'cd-t-pool-a', lagMin: 0, hard: true },
      { id: 'cd-d-09', kind: 'depends_on', fromTaskId: 'cd-t-art-b', toTaskId: 'cd-t-sport-b', lagMin: 0, hard: true },
      { id: 'cd-d-10', kind: 'depends_on', fromTaskId: 'cd-t-pool-c', toTaskId: 'cd-t-art-c', lagMin: 0, hard: true },
      { id: 'cd-d-11', kind: 'depends_on', fromTaskId: 'cd-t-lunch', toTaskId: 'cd-t-sport-a', lagMin: 0, hard: true },
      { id: 'cd-d-12', kind: 'depends_on', fromTaskId: 'cd-t-lunch', toTaskId: 'cd-t-art-b', lagMin: 0, hard: true },
      { id: 'cd-d-13', kind: 'depends_on', fromTaskId: 'cd-t-lunch', toTaskId: 'cd-t-pool-c', lagMin: 0, hard: true },
      { id: 'cd-d-14', kind: 'depends_on', fromTaskId: 'cd-t-rest', toTaskId: 'cd-t-lunch', lagMin: 0, hard: true },
      { id: 'cd-d-15', kind: 'depends_on', fromTaskId: 'cd-t-field', toTaskId: 'cd-t-rest', lagMin: 0, hard: true },
      { id: 'cd-d-16', kind: 'depends_on', fromTaskId: 'cd-t-snack', toTaskId: 'cd-t-field', lagMin: 0, hard: true },
      { id: 'cd-d-17', kind: 'depends_on', fromTaskId: 'cd-t-back1', toTaskId: 'cd-t-snack', lagMin: 0, hard: true },
      { id: 'cd-d-18', kind: 'depends_on', fromTaskId: 'cd-t-back2', toTaskId: 'cd-t-snack', lagMin: 0, hard: true },
      { id: 'cd-d-19', kind: 'depends_on', fromTaskId: 'cd-t-back3', toTaskId: 'cd-t-snack', lagMin: 0, hard: true },
    ],
  };
}
