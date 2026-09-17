/** Mock data for the isolated v2 visual build. Shapes mirror the real
 *  contracts (change requests, domino result, base version) so phase-3
 *  integration swaps the source, not the components. */

export type TaskStatus = 'ok' | 'risk' | 'slip' | 'off';

export interface FeedItem {
  id: string;
  status: TaskStatus;
  flag: 'slip' | 'risk' | 'approve';
  flagLabel: string;
  title: string;
  detail: string;
  action?: { label: string; kind: 'primary' | 'danger-quiet' | 'ghost' };
}

export interface ScheduleRow { time: string; name: string; status: TaskStatus; }

export interface ChangeRequest {
  id: string;
  typeFlag: string;       // machine type, e.g. task.create
  typeKind: 'tasks' | 'resources' | 'deps' | 'publish';
  who: string;
  role: string;
  when: string;
  title: string;
  diff: { k: string; old?: string; neu?: string; plain?: string; mono?: boolean }[];
  domino: { none: boolean; summary: string; items?: string[] };
  baseVersion: number;
  currentVersion: number; // stale when > baseVersion
  stale?: boolean;
}

export const EVENT = {
  name: 'יום קייטנה מלא — קייטנת אורנים',
  sub: 'יום שני, 14.9 · קייטנה',
  vertical: 'camp',
};

export const STATUS_COUNTS = { slip: 6, risk: 1, ok: 11, done: 0 };

export const NEXT_UP = {
  label: 'הבא · איסוף בוקר',
  task: 'אוטובוס 1 (מסלול צפון)',
  tminus: 'T-07:19',
  when: 'יציאה 07:30 · נועה כהן',
  progress: 62,
};

export const FEED: FeedItem[] = [
  {
    id: 'f1', status: 'slip', flag: 'slip', flagLabel: 'חריג · S3',
    title: 'איחור של 15 דקות ב"איסוף בוקר — אוטובוס 1"',
    detail: 'דווח מהשטח · אין אפקט דומינו — רק המשימה עצמה משתנה · גרסת בסיס 9',
    action: { label: 'לכרטיס האישור', kind: 'primary' },
  },
  {
    id: 'f2', status: 'risk', flag: 'approve', flagLabel: 'ממתין לאישור שלך',
    title: 'שינוי שעת ארוחת צהריים — קבוצת דבורה',
    detail: 'המטבח מבקש להקדים מ־12:30 ל־12:00 · דומינו: 2 משימות מושפעות',
    action: { label: 'אישור', kind: 'primary' },
  },
  {
    id: 'f3', status: 'ok', flag: 'approve', flagLabel: 'ממתין לאישור שלך',
    title: 'החלפת מדריך — פעילות פתיחה, חצר מרכזית',
    detail: 'דנה אוחיון במקום יובל בר · אין אפקט דומינו',
    action: { label: 'אישור', kind: 'primary' },
  },
];

export const SCHEDULE: ScheduleRow[] = [
  { time: '07:30', name: 'איסוף בוקר — אוטובוס 1 (מסלול צפון)', status: 'slip' },
  { time: '08:15', name: 'הגעה והתארגנות — רחבת הדגל', status: 'ok' },
  { time: '09:00', name: 'פעילות פתיחה — חצר מרכזית', status: 'ok' },
  { time: '10:30', name: 'בריכה — קבוצות א׳–ג׳ (ציוד: כסאות מטה)', status: 'risk' },
  { time: '12:00', name: 'ארוחת צהריים — חדר אוכל', status: 'ok' },
];

export const CHANGES: ChangeRequest[] = [
  {
    id: 'cr1', typeFlag: 'משימה חדשה · task.create', typeKind: 'tasks',
    who: 'אורן לוי', role: 'מנהל שטח', when: '07:41',
    title: 'בריכה — קבוצות א׳–ג׳ (ציוד: כסאות מטה)',
    diff: [
      { k: 'אתר', plain: 'מתחם הבריכה' },
      { k: 'זמן', plain: '10:30 · 45 דק׳', mono: true },
      { k: 'משויך', plain: 'נועה כהן + 2 מדריכים' },
    ],
    domino: { none: false, summary: 'דומינו: 2 משימות יזוזו (+15 דק׳)', items: ['ארוחת צהריים — חדר אוכל ← 12:30→12:45', 'פעילות אחר״צ — חצר ← 14:00→14:15'] },
    baseVersion: 9, currentVersion: 9,
  },
  {
    id: 'cr2', typeFlag: 'שינוי משאב · resource.update', typeKind: 'resources',
    who: 'נועה כהן', role: 'רכזת', when: '07:33',
    title: 'אוטובוס 2 (מסלול דרום) — הפיכה לבלעדי',
    diff: [
      { k: 'בלעדי', old: 'משותף', neu: 'בלעדי' },
      { k: 'סיבה', plain: 'כפילות הזמנה ביום רביעי' },
    ],
    domino: { none: true, summary: 'אין אפקט דומינו' },
    baseVersion: 9, currentVersion: 9,
  },
  {
    id: 'cr3', typeFlag: 'תלות חדשה · dependency.create', typeKind: 'deps',
    who: 'אורן לוי', role: 'מנהל שטח', when: '07:18',
    title: 'ארוחת צהריים ← הגעה מהבריכה',
    diff: [
      { k: 'השהיה', plain: '10 דק׳', mono: true },
      { k: 'סוג', plain: 'קשיחה (hard) — הדומינו לא יעקוף' },
    ],
    domino: { none: true, summary: 'אין מעגל תלות · אין אפקט מיידי' },
    baseVersion: 9, currentVersion: 9,
  },
  {
    id: 'cr4', typeFlag: 'פג תוקף בסיס · stale', typeKind: 'publish',
    who: 'דני שרון', role: 'מנהל-על', when: 'אתמול',
    title: 'פרסום האירוע · event.publish',
    diff: [{ k: 'משמעות', plain: 'נעילת היום + שידור לבעלי עניין' }],
    domino: { none: true, summary: '' },
    baseVersion: 7, currentVersion: 9, stale: true,
  },
];

export interface BuilderTask { time: string; name: string; sub: string; durPct: number; lock?: boolean; }
export interface BuilderSite { label: string; tasks: BuilderTask[]; }
export const BUILDER_SITES: BuilderSite[] = [
  {
    label: 'רחבת הדגל', tasks: [
      { time: '08:15', name: 'הגעה והתארגנות', sub: 'כל הקבוצות · 20 דק׳', durPct: 33 },
      { time: '09:00', name: 'פעילות פתיחה', sub: 'חצר מרכזית · 45 דק׳', durPct: 75, lock: true },
    ],
  },
  {
    label: 'מתחם הבריכה', tasks: [
      { time: '10:30', name: 'בריכה — קבוצות א׳–ג׳', sub: 'ציוד: כסאות מטה · 45 דק׳', durPct: 75 },
    ],
  },
  {
    label: 'חדר אוכל', tasks: [
      { time: '12:00', name: 'ארוחת צהריים', sub: 'כל הקבוצות · 40 דק׳', durPct: 66 },
    ],
  },
];
export const BUILDER_RESOURCES = [
  { icon: '🚌', name: 'אוטובוס 1 (מסלול צפון)', meta: 'נהג: משה · 45 מקומות', excl: false },
  { icon: '🚌', name: 'אוטובוס 2 (מסלול דרום)', meta: 'נהג: סאמי · 45 מקומות', excl: true },
  { icon: '🎽', name: 'גופיות קבוצה', meta: '120 יח׳ · מחסן מרכזי', excl: false },
  { icon: '🏳', name: 'דגלי קבוצה', meta: '8 יח׳ · רחבת הדגל', excl: false },
];