/** DEMO SEED - conference vertical (org-conf). Mirrors SeedData shape.
 *  Terminology matches profiles.v1.json v1.3 'conference' exactly:
 *  event=כנס, task=מושב, roles=מנהל כנס/אחראי אולם/מפעיל,
 *  external stakeholders=משתתפים. Rules: window 08:00-20:00, maxShift 45,
 *  quiet 22:00-07:00. */
// Drop-in target: apps/api/src/seeds/conference.seed.ts
import type { SeedData } from '../repo/graph-repository.js';
import { hashPasswordPure } from '../auth.js';

export function seedConference(D: string): SeedData {
  const at = (hhmm: string): string => `${D}T${hhmm}:00+03:00`;
  return {
    orgId: 'org-conf',
    users: [
      { userId: 'u-conf-admin', orgId: 'org-conf', name: 'יעל מנהלת כנס', role: 'admin', scopes: [], email: 'admin@conf-demo.local', passwordHash: hashPasswordPure('admin123'), active: true },
      { userId: 'u-conf-fm', orgId: 'org-conf', name: 'בועז אחראי אולם', role: 'field_manager', scopes: [{ eventId: 'conf-ev1', siteId: 'conf-site-1' }], email: 'fm@conf-demo.local', passwordHash: hashPasswordPure('fm12345'), active: true },
      { userId: 'u-conf-tech1', orgId: 'org-conf', name: 'עדי מפעיל אולם A', role: 'focus_worker', scopes: [{ eventId: 'conf-ev1' }], linkedResourceId: 'rconf-tech1', phone: '+972500100501', active: true },
      { userId: 'u-conf-tech2', orgId: 'org-conf', name: 'נווה מפעיל אולם B', role: 'focus_worker', scopes: [{ eventId: 'conf-ev1' }], linkedResourceId: 'rconf-tech2', phone: '+972500100502', active: true },
    ],
    channels: [
      { id: 'ch-conf-part-1', orgId: 'org-conf', address: '+972525100001', label: 'משתתף - נרשם לכנס' },
      { id: 'ch-conf-part-2', orgId: 'org-conf', address: '+972525100002', label: 'משתתפת - נרשמה לכנס' },
    ],
    events: [
      { id: 'conf-ev1', kind: 'event', orgId: 'org-conf', domainProfileId: 'conference', name: 'כנס הטכנולוגיה השנתי', date: D, timezone: 'Asia/Jerusalem', siteIds: ['conf-site-1'], status: 'published', version: 1 },
    ],
    resources: [
      { id: 'rconf-tech1', kind: 'resource', eventId: 'conf-ev1', resourceKind: 'person', name: 'עדי מפעיל אולם A', exclusive: true, version: 1 },
      { id: 'rconf-tech2', kind: 'resource', eventId: 'conf-ev1', resourceKind: 'person', name: 'נווה מפעיל אולם B', exclusive: true, version: 1 },
      { id: 'rconf-projector', kind: 'resource', eventId: 'conf-ev1', resourceKind: 'equipment', name: 'מקרן ראשי', exclusive: true, version: 1 },
      { id: 'rconf-hall-a', kind: 'resource', eventId: 'conf-ev1', resourceKind: 'location', name: 'אולם מרכזי', exclusive: true, version: 1 },
      { id: 'rconf-hall-b', kind: 'resource', eventId: 'conf-ev1', resourceKind: 'location', name: 'אולם מקביל', exclusive: true, version: 1 },
      { id: 'rconf-track', kind: 'resource', eventId: 'conf-ev1', resourceKind: 'group', name: 'מסלול משתתפים', exclusive: false, subscriberChannelIds: ['ch-conf-part-1', 'ch-conf-part-2'], version: 1 },
    ],
    tasks: [
      { id: 'tconf-setup', kind: 'task', eventId: 'conf-ev1', siteId: 'conf-site-1', name: 'הכנת אולם מרכזי', start: at('08:00'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: ['rconf-tech1', 'rconf-projector', 'rconf-hall-a'], version: 1 },
      { id: 'tconf-keynote', kind: 'task', eventId: 'conf-ev1', siteId: 'conf-site-1', name: 'הרצאת פתיחה', start: at('09:00'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: ['rconf-tech1', 'rconf-projector', 'rconf-hall-a', 'rconf-track'], version: 1 },
      { id: 'tconf-s1', kind: 'task', eventId: 'conf-ev1', siteId: 'conf-site-1', name: 'מושב 1 - AI בישראל', start: at('10:00'), durationMin: 45, status: 'planned', locked: false, assigneeResourceIds: ['rconf-tech1', 'rconf-hall-a', 'rconf-track'], version: 1 },
      { id: 'tconf-s2', kind: 'task', eventId: 'conf-ev1', siteId: 'conf-site-1', name: 'מושב 2 - סייבר', start: at('11:00'), durationMin: 45, status: 'planned', locked: false, assigneeResourceIds: ['rconf-tech1', 'rconf-hall-a', 'rconf-track'], version: 1 },
      { id: 'tconf-parallel', kind: 'task', eventId: 'conf-ev1', siteId: 'conf-site-1', name: 'מושב מקביל - סטארטאפים (אולם B)', start: at('11:00'), durationMin: 45, status: 'planned', locked: false, assigneeResourceIds: ['rconf-tech2', 'rconf-hall-b'], version: 1 },
      { id: 'tconf-lunch', kind: 'task', eventId: 'conf-ev1', siteId: 'conf-site-1', name: 'הפסקת צהריים', start: at('12:00'), durationMin: 60, status: 'planned', locked: true, assigneeResourceIds: ['rconf-track'], version: 1 },
      { id: 'tconf-panel', kind: 'task', eventId: 'conf-ev1', siteId: 'conf-site-1', name: 'פאנל מסכם', start: at('13:00'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: ['rconf-tech1', 'rconf-tech2', 'rconf-projector', 'rconf-hall-a', 'rconf-track'], version: 1 },
    ],
    dependencies: [
      { id: 'dconf-1', kind: 'depends_on', fromTaskId: 'tconf-keynote', toTaskId: 'tconf-setup', lagMin: 0, hard: true },
      { id: 'dconf-2', kind: 'depends_on', fromTaskId: 'tconf-s1', toTaskId: 'tconf-keynote', lagMin: 0, hard: true },
      { id: 'dconf-3', kind: 'depends_on', fromTaskId: 'tconf-s2', toTaskId: 'tconf-s1', lagMin: 0, hard: true },
      { id: 'dconf-4', kind: 'depends_on', fromTaskId: 'tconf-panel', toTaskId: 'tconf-s2', lagMin: 0, hard: true },
    ],
  };
}

/** DOMINO SCENARIO (conference): "המרצה הראשי נתקע בנתב"ג" - בועז אחראי האולם
 *  מעביר דיווח: הרצאת הפתיחה נדחית ב-30 דקות. המנוע מפיל: מושב 1, מושב 2,
 *  הפאנל - כולם +30. המושב המקביל באולם B לא מושפע (מפעיל נפרד, אולם נפרד -
 *  ראיה לדיוק המנוע). הפסקת הצהריים נעולה ולא זזה - המנוע מסמן את הקונפליקט
 *  (blocked semantics per corpus) במקום לדרוס נעילה. המשתתפים מקבלים עדכון "נדחה". S-class: CR של אחראי האולם, מנהלת
 *  הכנס מאשרת. */
