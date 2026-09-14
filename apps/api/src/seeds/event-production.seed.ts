/** DEMO SEED - event-production vertical (org-events). Mirrors SeedData shape.
 *  Terminology matches profiles.v1.json v1.3 'event-production' exactly:
 *  event=אירוע, task=משימת הפקה, roles=מפיק ראשי/מנהל במה/איש צוות,
 *  external stakeholders=לקוחות. Rules: window 06:00-23:59, maxShift 90,
 *  quiet 22:00-07:00. */
// Drop-in target: apps/api/src/seeds/event-production.seed.ts
import type { SeedData } from '../repo/graph-repository.js';
import { hashPasswordPure } from '../auth.js';

export function seedEventProduction(D: string): SeedData {
  const at = (hhmm: string): string => `${D}T${hhmm}:00+03:00`;
  return {
    orgId: 'org-events',
    users: [
      { userId: 'u-ev-admin', orgId: 'org-events', name: 'שירה מפיקה ראשית', role: 'admin', scopes: [], email: 'admin@events-demo.local', passwordHash: hashPasswordPure('admin123'), active: true },
      { userId: 'u-ev-fm', orgId: 'org-events', name: 'אבי מנהל במה', role: 'field_manager', scopes: [{ eventId: 'ev-ev1', siteId: 'ev-site-1' }], email: 'fm@events-demo.local', passwordHash: hashPasswordPure('fm12345'), active: true },
      { userId: 'u-ev-sound', orgId: 'org-events', name: 'לירון טכנאי הגברה', role: 'focus_worker', scopes: [{ eventId: 'ev-ev1' }], linkedResourceId: 'rev-sound-tech', phone: '+972500100201', active: true },
      { userId: 'u-ev-light', orgId: 'org-events', name: 'טל טכנאית תאורה', role: 'focus_worker', scopes: [{ eventId: 'ev-ev1' }], linkedResourceId: 'rev-light-tech', phone: '+972500100202', active: true },
      { userId: 'u-ev-video', orgId: 'org-events', name: 'גיא טכנאי וידאו', role: 'focus_worker', scopes: [{ eventId: 'ev-ev1' }], linkedResourceId: 'rev-video-tech', phone: '+972500100203', active: true },
    ],
    channels: [
      { id: 'ch-ev-client-1', orgId: 'org-events', address: '+972522100001', label: 'לקוח - מנהל אירועי החברה' },
      { id: 'ch-ev-client-2', orgId: 'org-events', address: '+972522100002', label: 'לקוח - סמנכ"ל תפעול' },
    ],
    events: [
      { id: 'ev-ev1', kind: 'event', orgId: 'org-events', domainProfileId: 'event-production', name: 'אירוע חברה - ערב העובדים השנתי', date: D, timezone: 'Asia/Jerusalem', siteIds: ['ev-site-1'], status: 'published', version: 1 },
    ],
    resources: [
      { id: 'rev-sound-tech', kind: 'resource', eventId: 'ev-ev1', resourceKind: 'person', name: 'לירון טכנאי הגברה', exclusive: true, version: 1 },
      { id: 'rev-light-tech', kind: 'resource', eventId: 'ev-ev1', resourceKind: 'person', name: 'טל טכנאית תאורה', exclusive: true, version: 1 },
      { id: 'rev-video-tech', kind: 'resource', eventId: 'ev-ev1', resourceKind: 'person', name: 'גיא טכנאי וידאו', exclusive: true, version: 1 },
      { id: 'rev-pa', kind: 'resource', eventId: 'ev-ev1', resourceKind: 'equipment', name: 'מערכת הגברה', exclusive: true, version: 1 },
      { id: 'rev-lights', kind: 'resource', eventId: 'ev-ev1', resourceKind: 'equipment', name: 'מערכת תאורה', exclusive: true, version: 1 },
      { id: 'rev-led', kind: 'resource', eventId: 'ev-ev1', resourceKind: 'equipment', name: 'מסכי LED', exclusive: true, version: 1 },
      { id: 'rev-stage', kind: 'resource', eventId: 'ev-ev1', resourceKind: 'location', name: 'במה ראשית', exclusive: true, version: 1 },
      { id: 'rev-crew', kind: 'resource', eventId: 'ev-ev1', resourceKind: 'group', name: 'צוות הקמה', exclusive: false, subscriberChannelIds: ['ch-ev-client-1', 'ch-ev-client-2'], version: 1 },
    ],
    tasks: [
      { id: 'tev-build', kind: 'task', eventId: 'ev-ev1', siteId: 'ev-site-1', name: 'הקמה - במה ומתחם', start: at('08:00'), durationMin: 180, status: 'planned', locked: false, assigneeResourceIds: ['rev-crew', 'rev-stage'], version: 1 },
      { id: 'tev-pa', kind: 'task', eventId: 'ev-ev1', siteId: 'ev-site-1', name: 'התקנת מערכת הגברה', start: at('11:00'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: ['rev-sound-tech', 'rev-pa', 'rev-stage'], version: 1 },
      { id: 'tev-soundcheck', kind: 'task', eventId: 'ev-ev1', siteId: 'ev-site-1', name: "סאונד-צ'ק", start: at('12:00'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: ['rev-sound-tech', 'rev-pa', 'rev-stage'], version: 1 },
      { id: 'tev-lights', kind: 'task', eventId: 'ev-ev1', siteId: 'ev-site-1', name: 'תאורה ומסכים', start: at('13:00'), durationMin: 90, status: 'planned', locked: false, assigneeResourceIds: ['rev-light-tech', 'rev-video-tech', 'rev-lights', 'rev-led', 'rev-stage'], version: 1 },
      { id: 'tev-rehearsal', kind: 'task', eventId: 'ev-ev1', siteId: 'ev-site-1', name: 'חזרה כללית', start: at('14:30'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: ['rev-sound-tech', 'rev-light-tech', 'rev-video-tech', 'rev-pa', 'rev-lights', 'rev-stage'], version: 1 },
      { id: 'tev-break', kind: 'task', eventId: 'ev-ev1', siteId: 'ev-site-1', name: 'הפסקת צוות', start: at('15:30'), durationMin: 30, status: 'planned', locked: true, assigneeResourceIds: ['rev-crew'], version: 1 },
      { id: 'tev-reception', kind: 'task', eventId: 'ev-ev1', siteId: 'ev-site-1', name: 'קבלת פנים', start: at('16:00'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: ['rev-light-tech', 'rev-lights'], version: 1 },
      { id: 'tev-doors', kind: 'task', eventId: 'ev-ev1', siteId: 'ev-site-1', name: 'פתיחת דלתות', start: at('17:00'), durationMin: 30, status: 'planned', locked: false, assigneeResourceIds: ['rev-crew'], version: 1 },
      { id: 'tev-show', kind: 'task', eventId: 'ev-ev1', siteId: 'ev-site-1', name: 'האירוע - מהלך מלא', start: at('17:30'), durationMin: 180, status: 'planned', locked: false, assigneeResourceIds: ['rev-sound-tech', 'rev-light-tech', 'rev-video-tech', 'rev-pa', 'rev-lights', 'rev-led', 'rev-stage'], version: 1 },
    ],
    dependencies: [
      { id: 'dev-1', kind: 'depends_on', fromTaskId: 'tev-pa', toTaskId: 'tev-build', lagMin: 0, hard: true },
      { id: 'dev-2', kind: 'depends_on', fromTaskId: 'tev-soundcheck', toTaskId: 'tev-pa', lagMin: 0, hard: true },
      { id: 'dev-3', kind: 'depends_on', fromTaskId: 'tev-lights', toTaskId: 'tev-build', lagMin: 0, hard: true },
      { id: 'dev-4', kind: 'depends_on', fromTaskId: 'tev-rehearsal', toTaskId: 'tev-soundcheck', lagMin: 0, hard: true },
      { id: 'dev-5', kind: 'depends_on', fromTaskId: 'tev-rehearsal', toTaskId: 'tev-lights', lagMin: 0, hard: true },
      { id: 'dev-6', kind: 'depends_on', fromTaskId: 'tev-reception', toTaskId: 'tev-rehearsal', lagMin: 0, hard: true },
      { id: 'dev-7', kind: 'depends_on', fromTaskId: 'tev-doors', toTaskId: 'tev-reception', lagMin: 0, hard: true },
      { id: 'dev-8', kind: 'depends_on', fromTaskId: 'tev-show', toTaskId: 'tev-doors', lagMin: 0, hard: true },
    ],
  };
}

/** DOMINO SCENARIO (events): "משאית הציוד תקועה בכניסה לעיר" - אבי מנהל הבמה
 *  מעביר דיווח: הקמה נדחית ב-45 דקות. המנוע מפיל: התקנת הגברה, סאונד-צ'ק,
 *  חזרה כללית, קבלת פנים, פתיחת דלתות, האירוע. הפסקת הצוות נעולה. הלקוח
 *  (מנוי על צוות ההקמה) מקבל עדכון "נדחה". S-class: CR מאושר ע"י המפיקה -
 *  מסך האישורים + עדכון לקוח בשתי פעולות. */
