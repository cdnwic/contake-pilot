/** DEMO SEED - logistics vertical (org-log). Mirrors SeedData shape.
 *  Terminology matches profiles.v1.json v1.3 'logistics' exactly:
 *  event=פרויקט הקמה, task=משימת הקמה, roles=מנהל פרויקט/מנהל אתר/עובד,
 *  external stakeholders=לקוחות. Rules: window 06:00-20:00, maxShift 180,
 *  quiet 22:00-07:00. */
// Drop-in target: apps/api/src/seeds/logistics.seed.ts
import type { SeedData } from '../repo/graph-repository.js';
import { hashPasswordPure } from '../auth.js';

export function seedLogistics(D: string): SeedData {
  const at = (hhmm: string): string => `${D}T${hhmm}:00+03:00`;
  return {
    orgId: 'org-log',
    users: [
      { userId: 'u-log-admin', orgId: 'org-log', name: 'אלון מנהל פרויקט', role: 'admin', scopes: [], email: 'admin@log-demo.local', passwordHash: hashPasswordPure('admin123'), active: true },
      { userId: 'u-log-fm', orgId: 'org-log', name: 'רינה מנהלת אתר', role: 'field_manager', scopes: [{ eventId: 'log-ev1', siteId: 'log-site-1' }], email: 'fm@log-demo.local', passwordHash: hashPasswordPure('fm12345'), active: true },
      { userId: 'u-log-w1', orgId: 'org-log', name: 'סמי רכבן 1', role: 'focus_worker', scopes: [{ eventId: 'log-ev1' }], linkedResourceId: 'rlog-w1', phone: '+972500100601', active: true },
      { userId: 'u-log-w2', orgId: 'org-log', name: 'כפיר רכבן 2', role: 'focus_worker', scopes: [{ eventId: 'log-ev1' }], linkedResourceId: 'rlog-w2', phone: '+972500100602', active: true },
      { userId: 'u-log-w3', orgId: 'org-log', name: 'אוהד מנהח', role: 'focus_worker', scopes: [{ eventId: 'log-ev1' }], linkedResourceId: 'rlog-w3', phone: '+972500100603', active: true },
    ],
    channels: [
      { id: 'ch-log-client-1', orgId: 'org-log', address: '+972526100001', label: 'לקוח - מנהל תפעול (מארח)' },
      { id: 'ch-log-client-2', orgId: 'org-log', address: '+972526100002', label: 'לקוח - רכז לוגיסטיקה (מארח)' },
    ],
    events: [
      { id: 'log-ev1', kind: 'event', orgId: 'org-log', domainProfileId: 'logistics', name: 'פרויקט הקמה - סוכה עירונית', date: D, timezone: 'Asia/Jerusalem', siteIds: ['log-site-1'], status: 'published', version: 1 },
    ],
    resources: [
      { id: 'rlog-w1', kind: 'resource', eventId: 'log-ev1', resourceKind: 'person', name: 'סמי רכבן 1', exclusive: true, version: 1 },
      { id: 'rlog-w2', kind: 'resource', eventId: 'log-ev1', resourceKind: 'person', name: 'כפיר רכבן 2', exclusive: true, version: 1 },
      { id: 'rlog-w3', kind: 'resource', eventId: 'log-ev1', resourceKind: 'person', name: 'אוהד מנהח', exclusive: true, version: 1 },
      { id: 'rlog-truck', kind: 'resource', eventId: 'log-ev1', resourceKind: 'equipment', name: 'משאית 1 - פריקה', exclusive: true, version: 1 },
      { id: 'rlog-crane', kind: 'resource', eventId: 'log-ev1', resourceKind: 'equipment', name: 'מנוף נייד', exclusive: true, version: 1 },
      { id: 'rlog-site', kind: 'resource', eventId: 'log-ev1', resourceKind: 'location', name: 'אתר A - כיכר העיר', exclusive: true, version: 1 },
      { id: 'rlog-crew', kind: 'resource', eventId: 'log-ev1', resourceKind: 'group', name: 'צוות הקמה', exclusive: false, subscriberChannelIds: ['ch-log-client-1', 'ch-log-client-2'], version: 1 },
    ],
    tasks: [
      { id: 'tlog-haul', kind: 'task', eventId: 'log-ev1', siteId: 'log-site-1', name: 'הובלה - מחסן לאתר', start: at('06:00'), durationMin: 120, status: 'planned', locked: false, assigneeResourceIds: ['rlog-truck', 'rlog-w3', 'rlog-crew'], version: 1 },
      { id: 'tlog-unload', kind: 'task', eventId: 'log-ev1', siteId: 'log-site-1', name: 'פריקה וסימון מתחם', start: at('08:00'), durationMin: 90, status: 'planned', locked: false, assigneeResourceIds: ['rlog-w1', 'rlog-w2', 'rlog-truck', 'rlog-site'], version: 1 },
      { id: 'tlog-frame', kind: 'task', eventId: 'log-ev1', siteId: 'log-site-1', name: 'הרכבת שלד', start: at('09:30'), durationMin: 180, status: 'planned', locked: false, assigneeResourceIds: ['rlog-w1', 'rlog-w2', 'rlog-crane', 'rlog-site', 'rlog-crew'], version: 1 },
      { id: 'tlog-lunch', kind: 'task', eventId: 'log-ev1', siteId: 'log-site-1', name: 'הפסקת צהריים', start: at('12:30'), durationMin: 30, status: 'planned', locked: true, assigneeResourceIds: ['rlog-crew'], version: 1 },
      { id: 'tlog-roof', kind: 'task', eventId: 'log-ev1', siteId: 'log-site-1', name: 'התקנת קירוי', start: at('13:00'), durationMin: 120, status: 'planned', locked: false, assigneeResourceIds: ['rlog-w1', 'rlog-w2', 'rlog-crane', 'rlog-site'], version: 1 },
      { id: 'tlog-safety', kind: 'task', eventId: 'log-ev1', siteId: 'log-site-1', name: 'בדיקת בטיחות וחתימה', start: at('15:00'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: ['rlog-w3', 'rlog-site', 'rlog-crew'], version: 1 },
      { id: 'tlog-handover', kind: 'task', eventId: 'log-ev1', siteId: 'log-site-1', name: 'מסירה ללקוח', start: at('16:00'), durationMin: 45, status: 'planned', locked: false, assigneeResourceIds: ['rlog-crew'], version: 1 },
    ],
    dependencies: [
      { id: 'dlog-1', kind: 'depends_on', fromTaskId: 'tlog-unload', toTaskId: 'tlog-haul', lagMin: 0, hard: true },
      { id: 'dlog-2', kind: 'depends_on', fromTaskId: 'tlog-frame', toTaskId: 'tlog-unload', lagMin: 0, hard: true },
      { id: 'dlog-3', kind: 'depends_on', fromTaskId: 'tlog-roof', toTaskId: 'tlog-frame', lagMin: 0, hard: true },
      { id: 'dlog-4', kind: 'depends_on', fromTaskId: 'tlog-safety', toTaskId: 'tlog-roof', lagMin: 0, hard: true },
      { id: 'dlog-5', kind: 'depends_on', fromTaskId: 'tlog-handover', toTaskId: 'tlog-safety', lagMin: 0, hard: true },
    ],
  };
}

/** DOMINO SCENARIO (logistics): "המשאית נעצרת במשטרה - איחור של שעה" -
 *  רינה מנהלת האתר מעבירה דיווח: ההובלה נדחית ב-60 דקות. המנוע מפיל: פריקה,
 *  שלד, קירוי, בדיקת בטיחות, מסירה - כולם +60. הפסקת הצהריים נעולה ולא זזה -
 *  קונפליקט מסומן, לא נדרס. הלקוח המארח מקבל עדכון "נדחה" על מסירה משוערת
 *  חדשה. maxShift 180: הרכבת השלד בדיוק בגבול - רגישות הכללים גלויה.
 *  S-class: CR של מנהלת האתר, מנהל הפרויקט מאשר. */
