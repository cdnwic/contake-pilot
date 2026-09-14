/** DEMO SEED - after-school vertical (org-after). Mirrors SeedData shape.
 *  Terminology matches profiles.v1.json v1.3 'after-school' exactly:
 *  event=יום פעילות, task=חוג, roles=מנהל רשת/רכז סניף/מדריך,
 *  external stakeholders=הורים. Rules: window 14:00-19:00, maxShift 60,
 *  quiet 22:00-07:00. */
// Drop-in target: apps/api/src/seeds/after-school.seed.ts
import type { SeedData } from '../repo/graph-repository.js';
import { hashPasswordPure } from '../auth.js';

export function seedAfterSchool(D: string): SeedData {
  const at = (hhmm: string): string => `${D}T${hhmm}:00+03:00`;
  return {
    orgId: 'org-after',
    users: [
      { userId: 'u-as-admin', orgId: 'org-after', name: 'מיכל מנהלת רשת', role: 'admin', scopes: [], email: 'admin@after-demo.local', passwordHash: hashPasswordPure('admin123'), active: true },
      { userId: 'u-as-fm', orgId: 'org-after', name: 'איתמר רכז סניף', role: 'field_manager', scopes: [{ eventId: 'as-ev1', siteId: 'as-site-1' }], email: 'fm@after-demo.local', passwordHash: hashPasswordPure('fm12345'), active: true },
      { userId: 'u-as-robot', orgId: 'org-after', name: 'שרה מדריכת רובוטיקה', role: 'focus_worker', scopes: [{ eventId: 'as-ev1' }], linkedResourceId: 'ras-robot', phone: '+972500100401', active: true },
      { userId: 'u-as-drama', orgId: 'org-after', name: 'אורי מדריך תיאטרון', role: 'focus_worker', scopes: [{ eventId: 'as-ev1' }], linkedResourceId: 'ras-drama', phone: '+972500100402', active: true },
      { userId: 'u-as-chess', orgId: 'org-after', name: 'ליטל מדריכת שחמט', role: 'focus_worker', scopes: [{ eventId: 'as-ev1' }], linkedResourceId: 'ras-chess', phone: '+972500100403', active: true },
    ],
    channels: [
      { id: 'ch-as-parent-1', orgId: 'org-after', address: '+972524100001', label: 'הורה - חוג רובוטיקה' },
      { id: 'ch-as-parent-2', orgId: 'org-after', address: '+972524100002', label: 'הורה - חוג תיאטרון' },
    ],
    events: [
      { id: 'as-ev1', kind: 'event', orgId: 'org-after', domainProfileId: 'after-school', name: 'יום פעילות - סניף מרכז', date: D, timezone: 'Asia/Jerusalem', siteIds: ['as-site-1'], status: 'published', version: 1 },
    ],
    resources: [
      { id: 'ras-robot', kind: 'resource', eventId: 'as-ev1', resourceKind: 'person', name: 'שרה מדריכת רובוטיקה', exclusive: true, version: 1 },
      { id: 'ras-drama', kind: 'resource', eventId: 'as-ev1', resourceKind: 'person', name: 'אורי מדריך תיאטרון', exclusive: true, version: 1 },
      { id: 'ras-chess', kind: 'resource', eventId: 'as-ev1', resourceKind: 'person', name: 'ליטל מדריכת שחמט', exclusive: true, version: 1 },
      { id: 'ras-kit', kind: 'resource', eventId: 'as-ev1', resourceKind: 'equipment', name: 'ערכת חוג רובוטיקה', exclusive: true, version: 1 },
      { id: 'ras-room-a', kind: 'resource', eventId: 'as-ev1', resourceKind: 'location', name: 'כיתה א', exclusive: true, version: 1 },
      { id: 'ras-room-b', kind: 'resource', eventId: 'as-ev1', resourceKind: 'location', name: 'כיתה ב', exclusive: true, version: 1 },
      { id: 'ras-grp-robot', kind: 'resource', eventId: 'as-ev1', resourceKind: 'group', name: 'קבוצת חוג רובוטיקה', exclusive: false, subscriberChannelIds: ['ch-as-parent-1'], version: 1 },
      { id: 'ras-grp-drama', kind: 'resource', eventId: 'as-ev1', resourceKind: 'group', name: 'קבוצת חוג תיאטרון', exclusive: false, subscriberChannelIds: ['ch-as-parent-2'], version: 1 },
    ],
    tasks: [
      { id: 'tas-1', kind: 'task', eventId: 'as-ev1', siteId: 'as-site-1', name: 'חוג רובוטיקה - מפגש 4', start: at('14:00'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: ['ras-robot', 'ras-kit', 'ras-grp-robot', 'ras-room-a'], version: 1 },
      { id: 'tas-2', kind: 'task', eventId: 'as-ev1', siteId: 'as-site-1', name: 'חוג רובוטיקה - מפגש 4 (המשך)', start: at('15:00'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: ['ras-robot', 'ras-kit', 'ras-grp-robot', 'ras-room-a'], version: 1 },
      { id: 'tas-3', kind: 'task', eventId: 'as-ev1', siteId: 'as-site-1', name: 'חוג תיאטרון', start: at('16:00'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: ['ras-drama', 'ras-grp-drama', 'ras-room-a'], version: 1 },
      { id: 'tas-4', kind: 'task', eventId: 'as-ev1', siteId: 'as-site-1', name: 'חוג שחמט', start: at('16:00'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: ['ras-chess', 'ras-room-b'], version: 1 },
      { id: 'tas-5', kind: 'task', eventId: 'as-ev1', siteId: 'as-site-1', name: 'חוג תיאטרון - חזרה פתוחה להורים', start: at('17:00'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: ['ras-drama', 'ras-grp-drama', 'ras-room-a'], version: 1 },
      { id: 'tas-6', kind: 'task', eventId: 'as-ev1', siteId: 'as-site-1', name: 'סידור חדרים וסיכום יום', start: at('18:00'), durationMin: 30, status: 'planned', locked: false, assigneeResourceIds: ['ras-robot', 'ras-drama', 'ras-chess'], version: 1 },
    ],
    dependencies: [
      { id: 'das-1', kind: 'depends_on', fromTaskId: 'tas-2', toTaskId: 'tas-1', lagMin: 0, hard: true },
      { id: 'das-2', kind: 'depends_on', fromTaskId: 'tas-3', toTaskId: 'tas-2', lagMin: 0, hard: true },
      { id: 'das-3', kind: 'depends_on', fromTaskId: 'tas-5', toTaskId: 'tas-3', lagMin: 0, hard: true },
      { id: 'das-4', kind: 'depends_on', fromTaskId: 'tas-6', toTaskId: 'tas-5', lagMin: 0, hard: true },
    ],
  };
}

/** DOMINO SCENARIO (after-school): "שרה מדריכת הרובוטיקה מאחרת ברכבת" -
 *  איתמר רכז הסניף מעביר דיווח: חוג רובוטיקה נדחה ב-30 דקות. המנוע מפיל:
 *  המשך הרובוטיקה, וכי כיתה א תפוסה יותר זמן - חוג התיאטרון (בכיתה א!) נדחה,
 *  ואחריו החזרה הפתוחה להורים. שחמט בכיתה ב לא מושפע (ראיה שהמנוע מפיל רק מה
 *  שקשור). ההורים של הרובוטיקה ושל התיאטרון מקבלים עדכון "נדחה" - כל קבוצה
 *  רק על החוג שלה. S-class: CR של הרכז, מנהלת הרשת מאשרת. */
