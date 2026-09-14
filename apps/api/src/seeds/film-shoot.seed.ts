/** DEMO SEED - film-shoot vertical (org-film). Mirrors SeedData shape from
 *  apps/api/src/seed.ts; backend loads with any anchor date D.
 *  Terminology matches profiles.v1.json v1.3 'film-shoot' exactly:
 *  event=יום צילום, task=סצנה, roles=מנהל הפקה/עוזר במאי/איש צוות,
 *  external stakeholders=לקוחות. Rules: window 06:00-22:00, maxShift 60,
 *  quiet 22:00-07:00. */
// Drop-in target: apps/api/src/seeds/film-shoot.seed.ts (imports below match that location).
import type { SeedData } from '../repo/graph-repository.js';
import { hashPasswordPure } from '../auth.js';

export function seedFilmShoot(D: string): SeedData {
  const at = (hhmm: string): string => `${D}T${hhmm}:00+03:00`;
  return {
    orgId: 'org-film',
    users: [
      { userId: 'u-film-admin', orgId: 'org-film', name: 'רוני מנהל הפקה', role: 'admin', scopes: [], email: 'admin@film-demo.local', passwordHash: hashPasswordPure('admin123'), active: true },
      { userId: 'u-film-fm', orgId: 'org-film', name: 'ניר עוזר במאי', role: 'field_manager', scopes: [{ eventId: 'film-ev1', siteId: 'film-site-1' }, { eventId: 'film-ev1', siteId: 'film-site-2' }], email: 'fm@film-demo.local', passwordHash: hashPasswordPure('fm12345'), active: true },
      { userId: 'u-film-gaffer', orgId: 'org-film', name: 'דני תאוראי', role: 'focus_worker', scopes: [{ eventId: 'film-ev1' }], linkedResourceId: 'rf-gaffer', phone: '+972500100101', active: true },
      { userId: 'u-film-sound', orgId: 'org-film', name: 'מיכל סאונד', role: 'focus_worker', scopes: [{ eventId: 'film-ev1' }], linkedResourceId: 'rf-sound', phone: '+972500100102', active: true },
      { userId: 'u-film-camop', orgId: 'org-film', name: 'עומר מצלמן', role: 'focus_worker', scopes: [{ eventId: 'film-ev1' }], linkedResourceId: 'rf-camop', phone: '+972500100103', active: true },
    ],
    channels: [
      { id: 'ch-film-client-1', orgId: 'org-film', address: '+972521100001', label: 'לקוח - מפיק ראשי (ערוץ)' },
      { id: 'ch-film-client-2', orgId: 'org-film', address: '+972521100002', label: 'לקוח - משרד הפקה' },
    ],
    events: [
      { id: 'film-ev1', kind: 'event', orgId: 'org-film', domainProfileId: 'film-shoot', name: 'יום צילום - פרק 4', date: D, timezone: 'Asia/Jerusalem', siteIds: ['film-site-1', 'film-site-2'], status: 'published', version: 1 },
    ],
    resources: [
      { id: 'rf-gaffer', kind: 'resource', eventId: 'film-ev1', resourceKind: 'person', name: 'דני תאוראי', exclusive: true, version: 1 },
      { id: 'rf-sound', kind: 'resource', eventId: 'film-ev1', resourceKind: 'person', name: 'מיכל סאונד', exclusive: true, version: 1 },
      { id: 'rf-camop', kind: 'resource', eventId: 'film-ev1', resourceKind: 'person', name: 'עומר מצלמן', exclusive: true, version: 1 },
      { id: 'rf-cam-a', kind: 'resource', eventId: 'film-ev1', resourceKind: 'equipment', name: 'מצלמה A', exclusive: true, version: 1 },
      { id: 'rf-light-kit', kind: 'resource', eventId: 'film-ev1', resourceKind: 'equipment', name: 'סט תאורה', exclusive: true, version: 1 },
      { id: 'rf-loc1', kind: 'resource', eventId: 'film-ev1', resourceKind: 'location', name: 'לוקיישן 1 - דירת פלטינג', exclusive: true, version: 1 },
      { id: 'rf-loc2', kind: 'resource', eventId: 'film-ev1', resourceKind: 'location', name: 'לוקיישן 2 - גג', exclusive: true, version: 1 },
      { id: 'rf-dept-sound', kind: 'resource', eventId: 'film-ev1', resourceKind: 'group', name: 'מחלקת סאונד', exclusive: false, subscriberChannelIds: ['ch-film-client-1', 'ch-film-client-2'], version: 1 },
    ],
    tasks: [
      { id: 'tf-setup', kind: 'task', eventId: 'film-ev1', siteId: 'film-site-1', name: 'הקמת ציוד', start: at('06:30'), durationMin: 45, status: 'planned', locked: false, assigneeResourceIds: ['rf-gaffer', 'rf-light-kit', 'rf-loc1'], version: 1 },
      { id: 'tf-sc12', kind: 'task', eventId: 'film-ev1', siteId: 'film-site-1', name: 'סצנה 12 - פתיחה', start: at('07:15'), durationMin: 90, status: 'planned', locked: false, assigneeResourceIds: ['rf-camop', 'rf-cam-a', 'rf-gaffer', 'rf-light-kit', 'rf-loc1'], version: 1 },
      { id: 'tf-sc13', kind: 'task', eventId: 'film-ev1', siteId: 'film-site-1', name: 'סצנה 13 - דיאלוג ראשי', start: at('08:45'), durationMin: 90, status: 'planned', locked: false, assigneeResourceIds: ['rf-camop', 'rf-cam-a', 'rf-gaffer', 'rf-sound', 'rf-dept-sound', 'rf-loc1'], version: 1 },
      { id: 'tf-lunch', kind: 'task', eventId: 'film-ev1', siteId: 'film-site-1', name: 'הפסקת צהריים', start: at('11:00'), durationMin: 45, status: 'planned', locked: true, assigneeResourceIds: ['rf-dept-sound'], version: 1 },
      { id: 'tf-sc14', kind: 'task', eventId: 'film-ev1', siteId: 'film-site-1', name: 'סצנה 14 - אקשן', start: at('10:15'), durationMin: 45, status: 'planned', locked: false, assigneeResourceIds: ['rf-camop', 'rf-cam-a', 'rf-gaffer', 'rf-sound', 'rf-loc1'], version: 1 },
      { id: 'tf-move', kind: 'task', eventId: 'film-ev1', siteId: 'film-site-2', name: 'העברת לוקיישן', start: at('13:00'), durationMin: 45, status: 'planned', locked: false, assigneeResourceIds: ['rf-gaffer', 'rf-light-kit', 'rf-cam-a'], version: 1 },
      { id: 'tf-sc21', kind: 'task', eventId: 'film-ev1', siteId: 'film-site-2', name: 'סצנה 21 - סגירה על הגג', start: at('13:45'), durationMin: 90, status: 'planned', locked: false, assigneeResourceIds: ['rf-camop', 'rf-cam-a', 'rf-gaffer', 'rf-sound', 'rf-dept-sound', 'rf-loc2'], version: 1 },
      { id: 'tf-wrap', kind: 'task', eventId: 'film-ev1', siteId: 'film-site-2', name: 'פירוק ציוד', start: at('15:15'), durationMin: 60, status: 'planned', locked: false, assigneeResourceIds: ['rf-gaffer', 'rf-light-kit', 'rf-cam-a'], version: 1 },
    ],
    dependencies: [
      { id: 'df-1', kind: 'depends_on', fromTaskId: 'tf-sc12', toTaskId: 'tf-setup', lagMin: 0, hard: true },
      { id: 'df-2', kind: 'depends_on', fromTaskId: 'tf-sc13', toTaskId: 'tf-sc12', lagMin: 0, hard: true },
      { id: 'df-3', kind: 'depends_on', fromTaskId: 'tf-sc14', toTaskId: 'tf-sc13', lagMin: 0, hard: true },
      { id: 'df-4', kind: 'depends_on', fromTaskId: 'tf-move', toTaskId: 'tf-sc14', lagMin: 0, hard: true },
      { id: 'df-5', kind: 'depends_on', fromTaskId: 'tf-sc21', toTaskId: 'tf-move', lagMin: 0, hard: true },
      { id: 'df-6', kind: 'depends_on', fromTaskId: 'tf-wrap', toTaskId: 'tf-sc21', lagMin: 0, hard: true },
    ],
  };
}

/** DOMINO SCENARIO (film): "השחקן הראשי תקוע בפקק" - ניר עוזר הבמאי מעביר
 *  דיווח: סצנה 13 נדחית ב-30 דקות. המנוע מפיל: סצנה 14, העברת לוקיישן,
 *  סצנה 21, פירוק - כולם +30. הפסקת הצהריים נעולה ולא זזה (הדגמת נעילה).
 *  לקוחות (מנויים על מחלקת סאונד) מקבלים עדכון "הוזז". S-class: עוזר הבמאי
 *  מגיש CR, מנהל ההפקה מאשר - מסך האישורים מוצג. */
