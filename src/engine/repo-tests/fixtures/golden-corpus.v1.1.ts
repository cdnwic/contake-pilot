/**
 * Contake QA — Golden Domino Corpus v1.0 (2026-09-11)
 * Executable fixtures against contracts v1 (`computeDomino`).
 * Each scenario: graph + change + profile + expected DominoResult invariants.
 * Convention note (open, flagged in G0 critique D1): `movedTasks` includes the
 * trigger per contracts comment; summaryHe N is asserted as DEPENDENT count
 * (excluding trigger) pending spec confirmation.
 */
import type {
  GraphSnapshot, TaskNode, ResourceNode, DependencyEdge,
  ProposedChange, DomainProfile, DominoResult, Impact,
} from '../../../contracts/contake-core-contracts.v1.1';

const T = 'Asia/Jerusalem';
const D = '2026-09-14'; // a Monday
const at = (hhmm: string) => `${D}T${hhmm}:00+03:00`;

// ---- Flagship camp graph: bus-delay scenario ------------------------------
// t1 pickup(bus) -> t2 breakfast -> t3 activity -> t4 pool -> t5 sports -> t6 lunch(LOCKED 12:00)
const campResources: ResourceNode[] = [
  { id: 'r-bus',   kind: 'resource', eventId: 'e1', resourceKind: 'equipment', name: 'אוטובוס',  exclusive: true,  version: 1 },
  { id: 'r-g1',    kind: 'resource', eventId: 'e1', resourceKind: 'person',    name: 'מדריך א', exclusive: true,  version: 1 },
  { id: 'r-g2',    kind: 'resource', eventId: 'e1', resourceKind: 'person',    name: 'מדריך ב', exclusive: true,  version: 1 },
  { id: 'r-g3',    kind: 'resource', eventId: 'e1', resourceKind: 'person',    name: 'מדריך ג', exclusive: true,  version: 1 },
  { id: 'r-pool',  kind: 'resource', eventId: 'e1', resourceKind: 'location',  name: 'בריכה',   exclusive: true,  version: 1 },
  { id: 'r-gym',   kind: 'resource', eventId: 'e1', resourceKind: 'location',  name: 'חדר ספורט', exclusive: true, version: 1 },
  { id: 'r-grp',   kind: 'resource', eventId: 'e1', resourceKind: 'group',     name: 'חוג גיבורים', exclusive: false, capacity: 30,
    subscriberChannelIds: Array.from({ length: 28 }, (_, i) => `ch-parent-${i + 1}`), version: 1 },
];
const mkTask = (id: string, name: string, start: string, durationMin: number, assignees: string[], locked = false): TaskNode =>
  ({ id, kind: 'task', eventId: 'e1', siteId: 'site-1', name, start: at(start), durationMin, status: 'planned', locked, assigneeResourceIds: assignees, version: 1 });
const campTasks: TaskNode[] = [
  mkTask('t1', 'איסוף באוטובוס', '07:30', 30, ['r-bus', 'r-g1', 'r-grp']),
  mkTask('t2', 'ארוחת בוקר',     '08:00', 45, ['r-g1', 'r-grp']),
  mkTask('t3', 'פעילות חוג',     '08:45', 60, ['r-g1', 'r-grp', 'r-gym']),
  mkTask('t4', 'בריכה',          '09:45', 60, ['r-g2', 'r-grp', 'r-pool']),
  mkTask('t5', 'ספורט',          '10:45', 30, ['r-g3', 'r-grp', 'r-gym']),
  mkTask('t6', 'ארוחת צהריים',   '12:00', 45, ['r-grp'], true), // hard lock
];
const campDeps: DependencyEdge[] = [
  { id: 'd1', kind: 'depends_on', fromTaskId: 't2', toTaskId: 't1', lagMin: 0, hard: true },
  { id: 'd2', kind: 'depends_on', fromTaskId: 't3', toTaskId: 't2', lagMin: 0, hard: true },
  { id: 'd3', kind: 'depends_on', fromTaskId: 't4', toTaskId: 't3', lagMin: 0, hard: true },
  { id: 'd4', kind: 'depends_on', fromTaskId: 't5', toTaskId: 't4', lagMin: 0, hard: true },
  { id: 'd5', kind: 'depends_on', fromTaskId: 't6', toTaskId: 't5', lagMin: 0, hard: true },
];
const campGraph = (tasks: TaskNode[] = campTasks): GraphSnapshot => ({
  event: { id: 'e1', kind: 'event', orgId: 'org-1', domainProfileId: 'camp', name: 'יום קייטנה', date: D, timezone: T, siteIds: ['site-1'], version: 1, status: 'published' },
  tasks, resources: campResources, dependencies: campDeps,
});

// ---- Scenario definitions ---------------------------------------------------
export interface GoldenScenario {
  id: string;
  title: string;
  graph: GraphSnapshot;
  change: ProposedChange;
  profileId: string;
  expect: {
    moved?: Array<{ taskId: string; afterStart: string }>;   // exact expected set (order-insensitive assert)
    blockedTaskIds?: string[];                                // D1: lock-anchored dependents, keep times, no notify
    ok?: boolean;                                             // false iff >=1 blocking conflict
    conflictCodes?: string[];                                 // expected blocking conflict codes
    conflictTaskIds?: string[];
    maxImpactClass?: 'S0' | 'S1' | 'S2' | 'S3';
    affectedPersonIds?: string[];                             // union over impacts
    affectedGroupIds?: string[];
    externalRecipientCount?: number;                          // dedup subscriberChannelIds of affected groups
    lockedMoved?: boolean;                                    // MUST be false in every scenario
    summaryHe?: string;
  };
}

export const scenarios: GoldenScenario[] = [
  {
    id: 'G1-bus-delay-flagship',
    title: 'אוטובוס מאחר 45ד — 5 פעילויות זזות, נעילה נשמרת, 3 מדריכים + 28 הורים',
    graph: campGraph(),
    change: { type: 'task.move', taskId: 't1', newStart: at('08:15') },
    profileId: 'camp',
    expect: {
      moved: [
        { taskId: 't1', afterStart: at('08:15') },
        { taskId: 't2', afterStart: at('08:45') },
        { taskId: 't3', afterStart: at('09:30') },
        { taskId: 't4', afterStart: at('10:30') },
        { taskId: 't5', afterStart: at('11:30') },
      ],
      conflictCodes: [],
      ok: true,
      maxImpactClass: 'S3',
      affectedPersonIds: ['r-g1', 'r-g2', 'r-g3'],
      affectedGroupIds: ['r-grp'],
      externalRecipientCount: 28,
      lockedMoved: false,
      summaryHe: 'אפקט דומינו: 4 משימות תלויות יזוזו (ארוחת בוקר)',
    },
  },
  {
    id: 'G2-lock-mid-chain',
    title: 'נעילה באמצע שרשרת → LOCK_VIOLATION blocking, t5 blocked (D1 pinned v1.1)',
    graph: campGraph(campTasks.map(t => t.id === 't4' ? { ...t, locked: true } : t)),
    change: { type: 'task.move', taskId: 't1', newStart: at('08:15') },
    profileId: 'camp',
    expect: {
      conflictCodes: ['LOCK_VIOLATION'],
      conflictTaskIds: ['t4'],
      lockedMoved: false,
      ok: false,                       // blocking conflict => nothing applies, nobody notified
      moved: [                          // upstream of the lock still computed in the proposal
        { taskId: 't1', afterStart: at('08:15') },
        { taskId: 't2', afterStart: at('08:45') },
        { taskId: 't3', afterStart: at('09:30') },
      ],
      blockedTaskIds: ['t5'],           // lock-anchored dependent: keeps 10:45, never in movedTasks
    },
  },
  {
    id: 'G3-double-booking',
    title: 'בריכה בלעדית משובצת לשני חוגים חופפים → DOUBLE_BOOKING',
    graph: (() => {
      const g = campGraph();
      g.resources = [...campResources, { id: 'r-grp2', kind: 'resource', eventId: 'e1', resourceKind: 'group', name: 'חוג אלופים', exclusive: false, capacity: 25, subscriberChannelIds: ['ch-parent-x1'], version: 1 }];
      g.tasks = [...campTasks, mkTask('t7', 'בריכה — אלופים', '09:45', 60, ['r-g2', 'r-grp2', 'r-pool'])];
      return g;
    })(),
    change: { type: 'task.move', taskId: 't1', newStart: at('08:15') }, // t4 moves to 10:30, t7 stays 09:45-10:45 -> overlap on r-pool
    profileId: 'camp',
    expect: { conflictCodes: ['DOUBLE_BOOKING'], ok: false, lockedMoved: false },
  },
  {
    id: 'G4-cross-domain-film',
    title: 'אותו תרחיש בפרופיל יום צילום — פלט זהה מבנית, מילון שונה',
    graph: campGraph(), // runner re-labels via film-shoot profile; structural equality asserted
    change: { type: 'task.move', taskId: 't1', newStart: at('08:15') },
    profileId: 'film-shoot',
    expect: {
      moved: [
        { taskId: 't1', afterStart: at('08:15') },
        { taskId: 't2', afterStart: at('08:45') },
        { taskId: 't3', afterStart: at('09:30') },
        { taskId: 't4', afterStart: at('10:30') },
        { taskId: 't5', afterStart: at('11:30') },
      ],
      maxImpactClass: 'S3',
      ok: true,
      lockedMoved: false,
    },
  },
  {
    id: 'G5-max-shift-exceeded',
    title: 'הזזה מצטברת מעל maxShiftMin=120 (קייטנה) → MAX_SHIFT_EXCEEDED',
    graph: campGraph(),
    change: { type: 'task.move', taskId: 't1', newStart: at('10:00') }, // +150 min
    profileId: 'camp',
    expect: { conflictCodes: ['MAX_SHIFT_EXCEEDED'], ok: false, lockedMoved: false },
  },
  {
    id: 'G6-determinism',
    title: 'דטרמיניזם: 50 הרצות עם סדר קלט מעורב → פלט קנוני זהה',
    graph: campGraph(),
    change: { type: 'task.move', taskId: 't1', newStart: at('08:15') },
    profileId: 'camp',
    expect: { lockedMoved: false }, // runner asserts byte-identical canonical JSON across 50 shuffled runs
  },
];

// ---- Runner (executes once @contake/core lands) -----------------------------
export function assertScenario(result: DominoResult, s: GoldenScenario): string[] {
  const errs: string[] = [];
  const e = s.expect;
  const norm = (a: Array<{ taskId: string }>) => [...a].map(x => x.taskId).sort();
  if (e.moved) {
    const got = new Map(result.movedTasks.map(m => [m.taskId, m.afterStart]));
    if (norm(result.movedTasks).join() !== norm(e.moved).join())
      errs.push(`moved set: got [${norm(result.movedTasks)}] want [${norm(e.moved)}]`);
    for (const m of e.moved) if (got.get(m.taskId) !== m.afterStart)
      errs.push(`${m.taskId}: got ${got.get(m.taskId)} want ${m.afterStart}`);
  }
  if (e.ok !== undefined && result.ok !== e.ok)
    errs.push(`ok: got ${result.ok} want ${e.ok}`);
  if (e.blockedTaskIds) {
    const blocked = [...result.blockedTaskIds].sort();
    if (blocked.join() !== [...e.blockedTaskIds].sort().join())
      errs.push(`blockedTaskIds: got [${blocked}] want [${e.blockedTaskIds}]`);
    for (const b of e.blockedTaskIds) {
      if (result.movedTasks.some(m => m.taskId === b))
        errs.push(`SEV-1: blocked task ${b} appears in movedTasks`);
      if (result.impacts.some(i => i.taskId === b))
        errs.push(`SEV-1: blocked task ${b} generates an impact (would notify)`);
    }
  }
  if (e.conflictCodes) {
    const codes = result.conflicts.map(c => c.code).sort();
    if (codes.join() !== [...e.conflictCodes].sort().join())
      errs.push(`conflicts: got [${codes}] want [${e.conflictCodes}]`);
  }
  if (e.conflictTaskIds) {
    const ids = [...new Set(result.conflicts.flatMap(c => c.taskIds))].sort();
    if (ids.join() !== [...e.conflictTaskIds].sort().join())
      errs.push(`conflict taskIds: got [${ids}] want [${e.conflictTaskIds}]`);
  }
  if (e.maxImpactClass && result.maxImpactClass !== e.maxImpactClass)
    errs.push(`maxImpactClass: got ${result.maxImpactClass} want ${e.maxImpactClass}`);
  if (e.affectedPersonIds) {
    const persons = [...new Set(result.impacts.flatMap((i: Impact) => i.affectedResourceIds))]
      .filter(id => ['r-g1', 'r-g2', 'r-g3'].includes(id)).sort();
    if (persons.join() !== [...e.affectedPersonIds].sort().join())
      errs.push(`affected persons: got [${persons}] want [${e.affectedPersonIds}]`);
  }
  if (e.externalRecipientCount !== undefined) {
    const grpIds = new Set(result.impacts.flatMap((i: Impact) => i.affectedGroupIds));
    const n = s.graph.resources.filter(r => grpIds.has(r.id))
      .reduce((acc, r) => acc + (r.subscriberChannelIds?.length ?? 0), 0);
    if (n !== e.externalRecipientCount) errs.push(`external recipients: got ${n} want ${e.externalRecipientCount}`);
  }
  if (e.lockedMoved === false) {
    const lockedIds = new Set(s.graph.tasks.filter(t => t.locked).map(t => t.id));
    for (const m of result.movedTasks) if (lockedIds.has(m.taskId))
      errs.push(`SEV-1: locked task ${m.taskId} was moved`);
  }
  if (e.summaryHe && result.summaryHe !== e.summaryHe)
    errs.push(`summaryHe: got "${result.summaryHe}" want "${e.summaryHe}"`);
  return errs;
}
