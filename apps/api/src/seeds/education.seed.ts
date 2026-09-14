/** DEMO SEED - education vertical (org-edu). Mirrors SeedData shape.
 *  Terminology matches profiles.v1.json v1.3 'education' exactly:
 *  event=יום לימודים, task=שיעור, roles=מנהל בית ספר/רכז שכבה/מורה,
 *  external stakeholders=הורים. Rules: window 08:00-16:00, maxShift 90,
 *  quiet 21:00-07:00. */
// Drop-in target: apps/api/src/seeds/education.seed.ts
import type { SeedData } from '../repo/graph-repository.js';
import { hashPasswordPure } from '../auth.js';

export function seedEducation(D: string): SeedData {
  const at = (hhmm: string): string => `${D}T${hhmm}:00+03:00`;
  return {
    orgId: 'org-edu',
    users: [
      { userId: 'u-edu-admin', orgId: 'org-edu', name: 'אורית מנהלת בית ספר', role: 'admin', scopes: [], email: 'admin@edu-demo.local', passwordHash: hashPasswordPure('admin123'), active: true },
      { userId: 'u-edu-fm', orgId: 'org-edu', name: 'חיים רכז שכבה ט', role: 'field_manager', scopes: [{ eventId: 'edu-ev1', siteId: 'edu-site-1' }], email: 'fm@edu-demo.local', passwordHash: hashPasswordPure('fm12345'), active: true },
      { userId: 'u-edu-math', orgId: 'org-edu', name: 'דליה מורה למתמטיקה', role: 'focus_worker', scopes: [{ eventId: 'edu-ev1' }], linkedResourceId: 'redu-math', phone: '+972500100301', active: true },
      { userId: 'u-edu-eng', orgId: 'org-edu', name: 'יונתן מורה לאנגלית', role: 'focus_worker', scopes: [{ eventId: 'edu-ev1' }], linkedResourceId: 'redu-eng', phone: '+972500100302', active: true },
      { userId: 'u-edu-gym', orgId: 'org-edu', name: 'נעמי מורה לספורט', role: 'focus_worker', scopes: [{ eventId: 'edu-ev1' }], linkedResourceId: 'redu-gym', phone: '+972500100303', active: true },
    ],
    channels: [
      { id: 'ch-edu-parent-1', orgId: 'org-edu', address: '+972523100001', label: 'הורה - ועד כיתה ט2' },
      { id: 'ch-edu-parent-2', orgId: 'org-edu', address: '+972523100002', label: 'הורה - נציגת הורים' },
    ],
    events: [
      { id: 'edu-ev1', kind: 'event', orgId: 'org-edu', domainProfileId: 'education', name: 'יום לימודים - שכבה ט', date: D, timezone: 'Asia/Jerusalem', siteIds: ['edu-site-1'], status: 'published', version: 1 },
    ],
    resources: [
      { id: 'redu-math', kind: 'resource', eventId: 'edu-ev1', resourceKind: 'person', name: 'דליה מורה למתמטיקה', exclusive: true, version: 1 },
      { id: 'redu-eng', kind: 'resource', eventId: 'edu-ev1', resourceKind: 'person', name: 'יונתן מורה לאנגלית', exclusive: true, version: 1 },
      { id: 'redu-gym', kind: 'resource', eventId: 'edu-ev1', resourceKind: 'person', name: 'נעמי מורה לספורט', exclusive: true, version: 1 },
      { id: 'redu-comp', kind: 'resource', eventId: 'edu-ev1', resourceKind: 'location', name: 'חדר מחשבים', exclusive: true, version: 1 },
      { id: 'redu-hall', kind: 'resource', eventId: 'edu-ev1', resourceKind: 'location', name: 'אולם ספורט', exclusive: true, version: 1 },
      { id: 'redu-room12', kind: 'resource', eventId: 'edu-ev1', resourceKind: 'location', name: 'כיתה ט2', exclusive: true, version: 1 },
      { id: 'redu-class', kind: 'resource', eventId: 'edu-ev1', resourceKind: 'group', name: 'כיתה ט2', exclusive: false, subscriberChannelIds: ['ch-edu-parent-1', 'ch-edu-parent-2'], version: 1 },
    ],
    tasks: [
      { id: 'tedu-1', kind: 'task', eventId: 'edu-ev1', siteId: 'edu-site-1', name: 'שיעור 1 - מתמטיקה', start: at('08:00'), durationMin: 45, status: 'planned', locked: false, assigneeResourceIds: ['redu-math', 'redu-class', 'redu-room12'], version: 1 },
      { id: 'tedu-2', kind: 'task', eventId: 'edu-ev1', siteId: 'edu-site-1', name: 'שיעור 2 - מתמטיקה (המשך)', start: at('08:45'), durationMin: 45, status: 'planned', locked: false, assigneeResourceIds: ['redu-math', 'redu-class', 'redu-room12'], version: 1 },
      { id: 'tedu-break', kind: 'task', eventId: 'edu-ev1', siteId: 'edu-site-1', name: 'הפסקה', start: at('09:30'), durationMin: 20, status: 'planned', locked: true, assigneeResourceIds: ['redu-class'], version: 1 },
      { id: 'tedu-3', kind: 'task', eventId: 'edu-ev1', siteId: 'edu-site-1', name: 'שיעור 3 - אנגלית', start: at('09:50'), durationMin: 45, status: 'planned', locked: false, assigneeResourceIds: ['redu-eng', 'redu-class', 'redu-room12'], version: 1 },
      { id: 'tedu-4', kind: 'task', eventId: 'edu-ev1', siteId: 'edu-site-1', name: 'שיעור 4 - מעבדה בחדר מחשבים', start: at('10:35'), durationMin: 45, status: 'planned', locked: false, assigneeResourceIds: ['redu-eng', 'redu-class', 'redu-comp'], version: 1 },
      { id: 'tedu-lunch', kind: 'task', eventId: 'edu-ev1', siteId: 'edu-site-1', name: 'ארוחת צהריים', start: at('11:20'), durationMin: 40, status: 'planned', locked: true, assigneeResourceIds: ['redu-class'], version: 1 },
      { id: 'tedu-5', kind: 'task', eventId: 'edu-ev1', siteId: 'edu-site-1', name: 'שיעור 5 - ספורט', start: at('12:00'), durationMin: 45, status: 'planned', locked: false, assigneeResourceIds: ['redu-gym', 'redu-class', 'redu-hall'], version: 1 },
      { id: 'tedu-6', kind: 'task', eventId: 'edu-ev1', siteId: 'edu-site-1', name: 'שיעור 6 - שעת חינוך', start: at('12:45'), durationMin: 45, status: 'planned', locked: false, assigneeResourceIds: ['redu-gym', 'redu-class', 'redu-room12'], version: 1 },
    ],
    dependencies: [
      { id: 'dedu-1', kind: 'depends_on', fromTaskId: 'tedu-2', toTaskId: 'tedu-1', lagMin: 0, hard: true },
      { id: 'dedu-2', kind: 'depends_on', fromTaskId: 'tedu-3', toTaskId: 'tedu-2', lagMin: 0, hard: true },
      { id: 'dedu-3', kind: 'depends_on', fromTaskId: 'tedu-4', toTaskId: 'tedu-3', lagMin: 0, hard: true },
      { id: 'dedu-4', kind: 'depends_on', fromTaskId: 'tedu-5', toTaskId: 'tedu-4', lagMin: 0, hard: true },
      { id: 'dedu-5', kind: 'depends_on', fromTaskId: 'tedu-6', toTaskId: 'tedu-5', lagMin: 0, hard: true },
    ],
  };
}

/** DOMINO SCENARIO (education): "דליה מורת המתמטיקה חולה - יגיעה רק ב-09:00" -
 *  חיים רכז השכבה מעביר דיווח: שיעור 1 נדחה ב-60 דקות. המנוע מפיל: שיעור 2,
 *  אנגלית, חדר מחשבים, ספורט, שעת חינוך - כולם זזים. ההפסקה וארוחת הצהריים
 *  נעולות (מערכת בית-ספרית אמיתית) - נראה שהמנוע מכבד נעילה. ההורים מקבלים
 *  עדכון "נדחה". S-class: CR של הרכז, המנהלת מאשרת. */
