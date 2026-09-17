/**
 * Seed fixtures: one GraphSnapshot per domain profile, all on the generic schema
 * (QA charter AC-GRAPH-3). Profile packs come from contracts/domain-profiles.v1.json
 * (pinned); the day graphs below are workstream fixtures, extensible by QA.
 * Times are event-local ISO with offset (Asia/Jerusalem = UTC+3 in Aug/Sep 2026).
 */
import type { DependencyEdge, GraphSnapshot, ResourceNode, TaskNode } from '../contracts/contake-core-contracts.v1';
import type { DomainProfile } from '../contracts/contracts.v1';
import { listProfiles } from '../profiles/profiles';

// Runtime profile selection runs on the canonical 7-profile parity layer (src/profiles/,
// byte-identical to profiles.v1.json @ origin/main 23364c1d). The recovered 6-profile snapshot
// src/contracts/domain-profiles.v1.json is PRESERVED UNTOUCHED as recovery evidence
// (R3-DIVERGENCE-LEDGER row 1; sha pinned by src/profiles/profiles-parity.test.ts).
export const PROFILES: DomainProfile[] = listProfiles();

const TZ = 'Asia/Jerusalem';
const D = '2026-08-12';
const t = (hhmm: string) => `${D}T${hhmm}:00+03:00`;

function res(id: string, eventId: string, kind: ResourceNode['resourceKind'], name: string, exclusive: boolean, extra?: Partial<ResourceNode>): ResourceNode {
  return { id, kind: 'resource', eventId, resourceKind: kind, name, exclusive, version: 1, ...extra };
}
function task(id: string, eventId: string, siteId: string, name: string, start: string, durationMin: number, assignees: string[], opts?: Partial<TaskNode>): TaskNode {
  return { id, kind: 'task', eventId, siteId, name, start: t(start), durationMin, status: 'planned', locked: false, assigneeResourceIds: assignees, version: 1, ...opts };
}
function dep(id: string, fromTaskId: string, toTaskId: string, lagMin = 0): DependencyEdge {
  return { id, kind: 'depends_on', fromTaskId, toTaskId, lagMin, hard: true };
}

/* ---------------- camp (flagship golden scenario) ---------------- */
export function seedCamp(): GraphSnapshot {
  const ev = 'ev-camp';
  const resources: ResourceNode[] = [
    res('r-noaa', ev, 'person', 'נועה כהן · מלוות אוטובוס', true),
    res('r-hila', ev, 'person', 'הילה · מדריכת דובדבן', true),
    res('r-yuval', ev, 'person', 'יובל · מדריך פרחים', true),
    res('r-roni', ev, 'person', 'רוני · מדריך ספורט', true),
    res('r-limor', ev, 'person', 'לימור · מדריכת אומנות', true),
    res('r-dana', ev, 'person', 'דנה · צוות בריכה', true),
    res('r-sami', ev, 'person', 'סאמי · צוות מטבח', true),
    res('r-bus2', ev, 'equipment', 'אוטובוס 2', true),
    res('r-sport', ev, 'equipment', 'ערכת ספורט', true),
    res('r-art', ev, 'equipment', 'ערכת יצירה', true),
    res('r-pa', ev, 'equipment', 'מערכת הגברה', true),
    res('r-yard', ev, 'location', 'חצר', true),
    res('r-gym', ev, 'location', 'אולם ספורט', true),
    res('r-artroom', ev, 'location', 'חדר יצירה', true),
    res('r-pool', ev, 'location', 'בריכה', true),
    res('r-dining', ev, 'location', 'חדר אוכל', true),
    res('r-dov', ev, 'group', 'קבוצת דובדבן', false, { capacity: 30, subscriberChannelIds: ['ch-parents-dov'] }),
    res('r-per', ev, 'group', 'קבוצת פרחים', false, { capacity: 30, subscriberChannelIds: ['ch-parents-per'] }),
  ];
  const tasks: TaskNode[] = [
    task('t1', ev, 'site-camp', 'איסוף בוקר — אוטובוס 2', '07:30', 60, ['r-noaa', 'r-bus2', 'r-dov']),
    task('t2', ev, 'site-camp', 'קבלת בוקר', '08:30', 30, ['r-yard', 'r-dov']),
    task('t3', ev, 'site-camp', 'ספורט', '09:00', 60, ['r-roni', 'r-sport', 'r-gym', 'r-dov']),
    task('t4', ev, 'site-camp', 'אומנות', '10:00', 60, ['r-limor', 'r-art', 'r-artroom', 'r-dov']),
    task('t5', ev, 'site-camp', 'הפסקת בוקר', '11:00', 30, ['r-yard', 'r-dov']),
    task('t6', ev, 'site-camp', 'בריכה', '11:30', 60, ['r-dana', 'r-pool', 'r-dov']),
    task('t7', ev, 'site-camp', 'ארוחת צהריים', '12:30', 45, ['r-sami', 'r-dining', 'r-dov', 'r-per'], { locked: true }),
    task('t8', ev, 'site-camp', 'משחק חצר', '13:15', 60, ['r-hila', 'r-yard', 'r-dov']),
    task('t9', ev, 'site-camp', 'מפגש סיכום', '14:15', 45, ['r-hila', 'r-pa', 'r-yard', 'r-dov']),
    task('p1', ev, 'site-camp', 'קבלת בוקר', '08:30', 30, ['r-yuval', 'r-yard', 'r-per']),
    task('p2', ev, 'site-camp', 'אומנות', '09:00', 70, ['r-yuval', 'r-art', 'r-artroom', 'r-per']),
    task('p3', ev, 'site-camp', 'בריכה', '10:10', 80, ['r-dana', 'r-pool', 'r-per']),
    task('p4', ev, 'site-camp', 'משחקי ספורט', '12:30', 90, ['r-roni', 'r-yuval', 'r-sport', 'r-gym', 'r-per']),
    task('p5', ev, 'site-camp', 'מפגש סיכום', '14:15', 45, ['r-yuval', 'r-yard', 'r-per']),
    task('t10', ev, 'site-camp', 'פיזור והסעות', '15:00', 30, ['r-noaa', 'r-hila', 'r-yuval', 'r-bus2', 'r-dov', 'r-per'], { locked: true }),
  ];
  const dependencies: DependencyEdge[] = [
    dep('d1', 't2', 't1'), dep('d2', 't3', 't2'), dep('d3', 't4', 't3'), dep('d4', 't5', 't4'),
    dep('d5', 't6', 't5'), dep('d6', 't8', 't7'), dep('d7', 't9', 't8'),
    dep('d8', 'p2', 'p1'), dep('d9', 'p3', 'p2'), dep('d10', 'p4', 't7'), dep('d11', 'p5', 'p4'),
  ];
  return {
    event: { id: ev, kind: 'event', orgId: 'org-avivim', domainProfileId: 'camp', name: 'קייטנת ״אביבים״ · יום רביעי', date: D, timezone: TZ, siteIds: ['site-camp'], status: 'published', version: 1 },
    tasks, resources, dependencies,
  };
}

/* ---------------- event-production ---------------- */
export function seedEventProduction(): GraphSnapshot {
  const ev = 'ev-prod';
  const resources: ResourceNode[] = [
    res('e-david', ev, 'person', 'דוד · מפיק ראשי', true),
    res('e-avi', ev, 'person', 'אבי · טכנאי סאונד', true),
    res('e-nir', ev, 'person', 'ניר · טכנאי תאורה', true),
    res('e-ronit', ev, 'person', 'רונית · קייטרינג', true),
    res('e-miki', ev, 'person', 'מיקי · סדרן קבלה', true),
    res('e-sound', ev, 'equipment', 'מערכת סאונד', true),
    res('e-light', ev, 'equipment', 'תאורת במה', true),
    res('e-led', ev, 'equipment', 'מסך LED', true),
    res('e-tables', ev, 'equipment', 'שולחנות קבלה', true),
    res('e-stage', ev, 'location', 'במה ראשית', true),
    res('e-lobby', ev, 'location', 'אולם קבלה', true),
    res('e-crew', ev, 'group', 'צוות הפקה', false),
    res('e-vip', ev, 'group', 'אורחי VIP', false, { capacity: 40, subscriberChannelIds: ['ch-vip'] }),
  ];
  const tasks: TaskNode[] = [
    task('e1', ev, 'site-hall', 'הקמת במה', '08:00', 120, ['e-nir', 'e-avi', 'e-light', 'e-sound', 'e-stage', 'e-crew']),
    task('e2', ev, 'site-hall', 'סאונד־צ׳ק', '10:00', 45, ['e-avi', 'e-sound', 'e-stage', 'e-crew']),
    task('e3', ev, 'site-hall', 'תאורה סופית ומסך', '10:45', 45, ['e-nir', 'e-led', 'e-light', 'e-stage', 'e-crew']),
    task('e4', ev, 'site-hall', 'פתיחת דלתות VIP', '18:00', 30, ['e-miki', 'e-ronit', 'e-tables', 'e-lobby', 'e-vip'], { locked: true }),
  ];
  return {
    event: { id: ev, kind: 'event', orgId: 'org-orvkol', domainProfileId: 'event-production', name: 'אירוע השקה · קליינט מדיה', date: D, timezone: TZ, siteIds: ['site-hall'], status: 'published', version: 1 },
    tasks, resources, dependencies: [dep('e-d1', 'e2', 'e1'), dep('e-d2', 'e3', 'e2')],
  };
}

/* ---------------- film-shoot ---------------- */
export function seedFilm(): GraphSnapshot {
  const ev = 'ev-film';
  const resources: ResourceNode[] = [
    res('f-orit', ev, 'person', 'אורית · במאית', true),
    res('f-tal', ev, 'person', 'טל · צלם ראשי', true),
    res('f-guy', ev, 'person', 'גיא · סאונדמן', true),
    res('f-shani', ev, 'person', 'שני · ראש צוות תאורה', true),
    res('f-lior', ev, 'person', 'ליאור · הפקה', true),
    res('f-cama', ev, 'equipment', 'מצלמה A', true),
    res('f-camb', ev, 'equipment', 'מצלמה B', true),
    res('f-crane', ev, 'equipment', 'מנוף', true),
    res('f-lightkit', ev, 'equipment', 'ערכת תאורה', true),
    res('f-loc1', ev, 'location', 'לוקיישן 1', true),
    res('f-loc2', ev, 'location', 'לוקיישן 2', true),
    res('f-base', ev, 'location', 'בסיס הפקה', true),
    res('f-crew', ev, 'group', 'צוות הפקה', false),
    res('f-cast', ev, 'group', 'שחקנים', false, { subscriberChannelIds: ['ch-cast'] }),
  ];
  const tasks: TaskNode[] = [
    task('f1', ev, 'site-set', 'הקמת תאורה · לוקיישן 1', '07:00', 90, ['f-shani', 'f-lightkit', 'f-loc1', 'f-crew']),
    task('f2', ev, 'site-set', 'צילום סצנה 12', '08:30', 150, ['f-orit', 'f-tal', 'f-guy', 'f-cama', 'f-loc1', 'f-cast']),
    task('f3', ev, 'site-set', 'העברת ציוד ללוקיישן 2', '11:00', 60, ['f-shani', 'f-lior', 'f-camb', 'f-crane', 'f-loc2', 'f-crew']),
    task('f4', ev, 'site-set', 'הפסקת ארוחה', '13:00', 45, ['f-base', 'f-crew', 'f-cast'], { locked: true }),
    task('f5', ev, 'site-set', 'צילום סצנה 13', '13:45', 120, ['f-orit', 'f-tal', 'f-camb', 'f-loc2', 'f-cast']),
  ];
  return {
    event: { id: ev, kind: 'event', orgId: 'org-frame', domainProfileId: 'film-shoot', name: 'יום צילום 3 · סדרת ״המעבר״', date: D, timezone: TZ, siteIds: ['site-set'], status: 'published', version: 1 },
    tasks, resources, dependencies: [dep('f-d1', 'f2', 'f1'), dep('f-d2', 'f3', 'f2'), dep('f-d3', 'f5', 'f4')],
  };
}

/* ---------------- conference ---------------- */
export function seedConference(): GraphSnapshot {
  const ev = 'ev-conf';
  const resources: ResourceNode[] = [
    res('c-michal', ev, 'person', 'מיכל · מפיקת כנס', true),
    res('c-omer', ev, 'person', 'עומר · מפעיל טכני', true),
    res('c-lev', ev, 'person', 'ד״ר לב · מרצה ראשי', true),
    res('c-noam', ev, 'person', 'נעם · מנחה סדנאות', true),
    res('c-proj', ev, 'equipment', 'מקרן', true),
    res('c-mics', ev, 'equipment', 'מיקרופונים', true),
    res('c-reg', ev, 'equipment', 'שולחן רישום', true),
    res('c-hall', ev, 'location', 'אולם מרכזי', true),
    res('c-workshop', ev, 'location', 'חדר סדנאות', true),
    res('c-lobby', ev, 'location', 'לובי', true),
    res('c-tracka', ev, 'group', 'משתתפים מסלול א', false, { capacity: 120, subscriberChannelIds: ['ch-tracka'] }),
    res('c-trackb', ev, 'group', 'משתתפים מסלול ב', false, { capacity: 95, subscriberChannelIds: ['ch-trackb'] }),
  ];
  const tasks: TaskNode[] = [
    task('c1', ev, 'site-center', 'התקנת מקרן וסאונד', '08:00', 90, ['c-omer', 'c-proj', 'c-mics', 'c-hall']),
    task('c2', ev, 'site-center', 'רישום וקפה', '09:30', 30, ['c-michal', 'c-reg', 'c-lobby', 'c-tracka', 'c-trackb']),
    task('c3', ev, 'site-center', 'הרצאת פתיחה', '10:00', 60, ['c-lev', 'c-proj', 'c-mics', 'c-hall', 'c-tracka', 'c-trackb'], { locked: true }),
    task('c4', ev, 'site-center', 'סדנאות מקבילות', '11:00', 90, ['c-noam', 'c-workshop', 'c-trackb']),
  ];
  return {
    event: { id: ev, kind: 'event', orgId: 'org-tzomet', domainProfileId: 'conference', name: 'כנס ״צומת״ 2026', date: D, timezone: TZ, siteIds: ['site-center'], status: 'published', version: 1 },
    tasks, resources, dependencies: [dep('c-d1', 'c3', 'c1'), dep('c-d2', 'c3', 'c2'), dep('c-d3', 'c4', 'c3')],
  };
}

/* ---------------- logistics ---------------- */
export function seedLogistics(): GraphSnapshot {
  const ev = 'ev-logi';
  const resources: ResourceNode[] = [
    res('l-avi', ev, 'person', 'אבי · נהג א', true),
    res('l-samir', ev, 'person', 'סמיר · נהג ב', true),
    res('l-haim', ev, 'person', 'חיים · מוביל', true),
    res('l-rut', ev, 'person', 'רות · בקרת איכות', true),
    res('l-truck1', ev, 'equipment', 'משאית 1', true),
    res('l-truck2', ev, 'equipment', 'משאית 2', true),
    res('l-fork', ev, 'equipment', 'מלגזה', true),
    res('l-wh', ev, 'location', 'מחסן מרכזי', true),
    res('l-north', ev, 'location', 'נקודת פריקה צפון', true),
    res('l-south', ev, 'location', 'נקודת פריקה דרום', true),
    res('l-rn', ev, 'group', 'מסלול צפון', false, { subscriberChannelIds: ['ch-cust-n'] }),
    res('l-rs', ev, 'group', 'מסלול דרום', false, { subscriberChannelIds: ['ch-cust-s'] }),
  ];
  const tasks: TaskNode[] = [
    task('l1', ev, 'site-wh', 'העמסת משאית 1', '07:00', 60, ['l-haim', 'l-truck1', 'l-fork', 'l-wh', 'l-rn']),
    task('l2', ev, 'site-wh', 'נסיעה לצפון', '08:00', 150, ['l-avi', 'l-truck1', 'l-rn']),
    task('l3', ev, 'site-wh', 'פריקה · נקודה צפון', '10:30', 60, ['l-avi', 'l-rut', 'l-truck1', 'l-north', 'l-rn']),
    task('l4', ev, 'site-wh', 'חלון מסירה ללקוח — צפון', '11:30', 60, ['l-north', 'l-rn'], { locked: true }),
    task('l5', ev, 'site-wh', 'העמסת משאית 2', '07:30', 45, ['l-haim', 'l-truck2', 'l-fork', 'l-wh', 'l-rs']),
    task('l6', ev, 'site-wh', 'נסיעה לדרום', '08:15', 120, ['l-samir', 'l-truck2', 'l-rs']),
  ];
  return {
    event: { id: ev, kind: 'event', orgId: 'org-kavham', domainProfileId: 'logistics', name: 'יום חלוקה · מרכז', date: D, timezone: TZ, siteIds: ['site-wh'], status: 'published', version: 1 },
    tasks, resources, dependencies: [dep('l-d1', 'l2', 'l1'), dep('l-d2', 'l3', 'l2'), dep('l-d3', 'l6', 'l5')],
  };
}

/* ---------------- after-school (two sites: S2 demo) ---------------- */
export function seedAfterSchool(): GraphSnapshot {
  const ev = 'ev-edu';
  const resources: ResourceNode[] = [
    res('u-avi', ev, 'person', 'אבי · מדריך ג׳ודו', true),
    res('u-mor', ev, 'person', 'מור · מדריכת דרמה', true),
    res('u-shira', ev, 'person', 'שירה · רכזת צפון', true),
    res('u-alon', ev, 'person', 'אלון · רכז דרום', true),
    res('u-mats', ev, 'equipment', 'מזרני ג׳ודו', true),
    res('u-costumes', ev, 'equipment', 'תלבושות דרמה', true),
    res('u-halln', ev, 'location', 'אולם צפון', true),
    res('u-dramarn', ev, 'location', 'כיתת דרמה צפון', true),
    res('u-halls', ev, 'location', 'אולם דרום', true),
    res('u-jc', ev, 'group', 'ג׳ודו ילדים', false, { capacity: 22, subscriberChannelIds: ['ch-judo-kids'] }),
    res('u-jt', ev, 'group', 'ג׳ודו נוער', false, { capacity: 18, subscriberChannelIds: ['ch-judo-teens'] }),
    res('u-dr', ev, 'group', 'דרמה ילדים', false, { capacity: 16, subscriberChannelIds: ['ch-drama-kids'] }),
  ];
  const tasks: TaskNode[] = [
    task('u1', ev, 'site-north', 'פריסת מזרנים והכנה · צפון', '15:00', 60, ['u-avi', 'u-mats', 'u-halln']),
    task('u2', ev, 'site-north', 'ג׳ודו ילדים · צפון', '16:00', 90, ['u-avi', 'u-mats', 'u-halln', 'u-jc']),
    task('u3', ev, 'site-north', 'דרמה ילדים · צפון', '16:00', 90, ['u-mor', 'u-costumes', 'u-dramarn', 'u-dr']),
    task('u4', ev, 'site-north', 'נסיעה לסניף דרום', '17:30', 30, ['u-avi']),
    task('u5', ev, 'site-south', 'ג׳ודו נוער · דרום', '18:00', 90, ['u-avi', 'u-mats', 'u-halls', 'u-jt']),
    task('u6', ev, 'site-south', 'סיום ואיסוף · דרום', '19:30', 30, ['u-alon', 'u-halls', 'u-jt'], { locked: true }),
  ];
  return {
    event: { id: ev, kind: 'event', orgId: 'org-madregot', domainProfileId: 'after-school', name: 'רשת חוגי ״מדרגות״ · יום שלישי', date: D, timezone: TZ, siteIds: ['site-north', 'site-south'], status: 'published', version: 1 },
    tasks, resources, dependencies: [dep('u-d1', 'u2', 'u1'), dep('u-d2', 'u4', 'u2'), dep('u-d3', 'u5', 'u4')],
  };
}


/* ---------------- education (canonical parity layer, authored-new fixture 2026-09-17) ----------------
 * Vocabulary/labels/catalog from canonical profiles.v1.json @ origin/main 23364c1d (education entry);
 * day graph is a new deterministic mock fixture, not recovered content. */
export function seedEducation(): GraphSnapshot {
  const ev = 'ev-school';
  const resources: ResourceNode[] = [
    res('t-asnat', ev, 'person', 'אסנת · מורה למתמטיקה', true),
    res('t-david', ev, 'person', 'דוד · מורה למדעים', true),
    res('t-ravit', ev, 'person', 'רוית · מורה לספורט', true),
    res('t-comp2', ev, 'location', 'חדר מחשבים 2', true),
    res('t-gym', ev, 'location', 'אולם ספורט', true),
    res('t-lib', ev, 'location', 'ספרייה', true),
    res('t-h1', ev, 'group', 'כיתה ח׳1', false, { capacity: 28, subscriberChannelIds: ['ch-grade-h1'] }),
    res('t-h2', ev, 'group', 'כיתה ח׳2', false, { capacity: 26, subscriberChannelIds: ['ch-grade-h2'] }),
  ];
  const tasks: TaskNode[] = [
    task('s1', ev, 'site-main', 'שיעור מתמטיקה · ח׳1', '08:00', 45, ['t-asnat', 't-h1', 't-comp2']),
    task('s2', ev, 'site-main', 'שיעור מתמטיקה · ח׳2', '09:00', 45, ['t-asnat', 't-h2', 't-comp2']),
    task('s3', ev, 'site-main', 'מבחן מדעים · ח׳1', '10:00', 90, ['t-david', 't-h1', 't-comp2']),
    task('s4', ev, 'site-main', 'שיעור ספורט · ח׳2', '08:00', 45, ['t-ravit', 't-h2', 't-gym']),
    task('s5', ev, 'site-main', 'שיעור ספרייה · ח׳1', '11:45', 45, ['t-asnat', 't-h1', 't-lib'], { locked: true }),
  ];
  return {
    event: { id: ev, kind: 'event', orgId: 'org-ilanot', domainProfileId: 'education', name: 'בית ספר ״אילנות״ · יום לימודים', date: D, timezone: TZ, siteIds: ['site-main'], status: 'published', version: 1 },
    tasks, resources, dependencies: [dep('s-d1', 's2', 's1'), dep('s-d2', 's3', 's2'), dep('s-d3', 's5', 's3')],
  };
}

export const SEEDERS: Record<string, () => GraphSnapshot> = {
  camp: seedCamp,
  'event-production': seedEventProduction,
  'film-shoot': seedFilm,
  conference: seedConference,
  logistics: seedLogistics,
  'after-school': seedAfterSchool,
  education: seedEducation,
};

/** Subscriber channels (mock): label + reach count + channel, per group channel id. */
export interface SubscriberChannel { id: string; label: string; count: number; channel: 'whatsapp' | 'sms'; }
export const SUBSCRIBER_CHANNELS: Record<string, SubscriberChannel> = {
  'ch-parents-dov': { id: 'ch-parents-dov', label: 'הורי קבוצת דובדבן', count: 28, channel: 'whatsapp' },
  'ch-parents-per': { id: 'ch-parents-per', label: 'הורי קבוצת פרחים', count: 24, channel: 'whatsapp' },
  'ch-vip': { id: 'ch-vip', label: 'אורחי VIP', count: 40, channel: 'whatsapp' },
  'ch-cast': { id: 'ch-cast', label: 'שחקנים', count: 9, channel: 'whatsapp' },
  'ch-tracka': { id: 'ch-tracka', label: 'משתתפים מסלול א', count: 120, channel: 'whatsapp' },
  'ch-trackb': { id: 'ch-trackb', label: 'משתתפים מסלול ב', count: 95, channel: 'whatsapp' },
  'ch-cust-n': { id: 'ch-cust-n', label: 'לקוח — צפון (חלון מסירה)', count: 1, channel: 'sms' },
  'ch-cust-s': { id: 'ch-cust-s', label: 'לקוח — דרום (חלון מסירה)', count: 1, channel: 'sms' },
  'ch-judo-kids': { id: 'ch-judo-kids', label: 'הורי ג׳ודו ילדים', count: 22, channel: 'whatsapp' },
  'ch-judo-teens': { id: 'ch-judo-teens', label: 'הורי ג׳ודו נוער', count: 18, channel: 'whatsapp' },
  'ch-grade-h1': { id: 'ch-grade-h1', label: 'הורי כיתה ח׳1', count: 26, channel: 'whatsapp' },
  'ch-grade-h2': { id: 'ch-grade-h2', label: 'הורי כיתה ח׳2', count: 24, channel: 'whatsapp' },
  'ch-drama-kids': { id: 'ch-drama-kids', label: 'הורי דרמה ילדים', count: 16, channel: 'whatsapp' },
};

/** Demo field incident per profile (drives the flagship flow in the UI). */
export interface DemoIncident { taskId: string; delayMin: number; reporter: string; title: string; detail: string; reportedAt: string; }
export const DEMO_INCIDENTS: Record<string, DemoIncident> = {
  camp: { taskId: 't1', delayMin: 45, reporter: 'נועה כהן · מלוות אוטובוס', title: 'אוטובוס 2 (קבוצת דובדבן) מתעכב ב־45 דקות', detail: 'דווח מהשטח · הגעה משוערת לקייטנה 09:15', reportedAt: '08:05' },
  'event-production': { taskId: 'e1', delayMin: 45, reporter: 'דוד · מפיק ראשי', title: 'משלוח הציוד התעכב — הקמת הבמה נדחית ב־45 דקות', detail: 'הסאונד־צ׳ק והתאורה נדחים בהתאם', reportedAt: '08:20' },
  'film-shoot': { taskId: 'f1', delayMin: 30, reporter: 'שני · ראש צוות תאורה', title: 'גנרטור לא הגיע — הקמת התאורה מתעכבת ב־30 דקות', detail: 'סצנה 12 תידחה; הארוחה נשארת 13:00', reportedAt: '07:10' },
  conference: { taskId: 'c1', delayMin: 20, reporter: 'עומר · מפעיל טכני', title: 'המקרן הראשי התקלקל — התקנה מתעכבת ב־20 דקות', detail: 'הרצאת הפתיחה נעולה ל־10:00 — נדרש פתרון', reportedAt: '08:15' },
  logistics: { taskId: 'l1', delayMin: 20, reporter: 'חיים · מוביל', title: 'מלגזה בתיקון — העמסת משאית 1 מתעכבת ב־20 דקות', detail: 'חלון המסירה ללקוח צפון נשמר', reportedAt: '07:05' },
  'after-school': { taskId: 'u1', delayMin: 30, reporter: 'שירה · רכזת צפון', title: 'אבי המדריך תקוע בפקק — ההכנה מתעכבת ב־30 דקות', detail: 'אפקט דומינו חוצה־סניפים — דרוש אישור מנהל-על', reportedAt: '15:05' },
};