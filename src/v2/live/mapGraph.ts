/** GraphSnapshot -> v2 view models (tower + builder surfaces).
 *  Status derivation v1 (documented fallback, TL review owns the final rule):
 *  delayed->slip, cancelled->off, done->done, planned/active->ok; 'risk' is NOT a
 *  stored task state — a task shows risk when a pending_review CR targets it.
 *  Site labels resolve through resources (TaskNode.siteId -> ResourceNode id). */
import type { GraphSnapshot, TaskNode } from '../../contracts/contracts.v1';
import type { ChangeRequest } from '../../contracts/contracts.v1';

export type TaskStatus = 'ok' | 'risk' | 'slip' | 'off' | 'done';
export interface ScheduleRow { id: string; time: string; name: string; status: TaskStatus; start: string | null }
export interface StatusCounts { slip: number; risk: number; ok: number; done: number }
export interface NextUp { label: string; task: string; when: string; startIso: string; progress: number }
export interface EventInfo { id: string; name: string; sub: string; date: string; timezone: string; version: number }

const HEB_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

export function mapEvent(g: GraphSnapshot, profileLabel?: string): EventInfo {
  const d = new Date(`${g.event.date}T00:00:00`);
  const day = isNaN(d.getTime()) ? '' : `יום ${HEB_DAYS[d.getDay()]}, `;
  const dm = g.event.date.split('-');
  const short = dm.length === 3 ? `${Number(dm[2])}.${Number(dm[1])}` : g.event.date;
  return {
    id: g.event.id,
    name: g.event.name,
    sub: `${day}${short}${profileLabel ? ` · ${profileLabel}` : ''}`,
    date: g.event.date,
    timezone: g.event.timezone,
    version: g.event.version,
  };
}

const fmtTime = (iso: string | null, tz: string): string =>
  iso == null ? '--:--' : new Intl.DateTimeFormat('he-IL', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

function taskStatus(t: TaskNode, pendingTaskIds: Set<string>): TaskStatus {
  if (t.status === 'cancelled') return 'off';
  if (t.status === 'delayed') return 'slip';
  if (t.status === 'done') return 'done';
  if (pendingTaskIds.has(t.id)) return 'risk';
  return 'ok';
}

/** Task ids targeted by a pending_review CR (any change variant carrying a taskId). */
export function pendingTaskIds(crs: ChangeRequest[]): Set<string> {
  const out = new Set<string>();
  for (const cr of crs) {
    if (cr.state !== 'pending_review') continue;
    const c = cr.change as { taskId?: string };
    if (c.taskId) out.add(c.taskId);
  }
  return out;
}

export function mapSchedule(g: GraphSnapshot, pending: Set<string>): ScheduleRow[] {
  return g.tasks
    .filter((t) => t.status !== 'cancelled')
    .slice()
    .sort((a, b) => (a.start ?? '9999').localeCompare(b.start ?? '9999'))
    .map((t) => ({ id: t.id, time: fmtTime(t.start, g.event.timezone), name: t.name, status: taskStatus(t, pending), start: t.start }));
}

export function mapStatusCounts(rows: ScheduleRow[]): StatusCounts {
  const c: StatusCounts = { slip: 0, risk: 0, ok: 0, done: 0 };
  for (const r of rows) {
    if (r.status === 'slip') c.slip++;
    else if (r.status === 'risk') c.risk++;
    else if (r.status === 'done') c.done++;
    else c.ok++; // 'ok' and 'off' both tally as ok-side for the filter chips
  }
  return c;
}

export function mapNextUp(g: GraphSnapshot, rows: ScheduleRow[], now = Date.now()): NextUp | null {
  const upcoming = g.tasks
    .filter((t) => t.start && t.status !== 'cancelled' && t.status !== 'done' && new Date(t.start).getTime() > now)
    .sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''))[0];
  if (!upcoming) return null;
  const starts = rows.map((r) => r.start).filter((s): s is string => !!s).sort();
  const first = starts[0] ? new Date(starts[0]).getTime() : now;
  const last = starts[starts.length - 1] ? new Date(starts[starts.length - 1]).getTime() : now + 1;
  const progress = last > first ? Math.min(100, Math.max(0, Math.round(((now - first) / (last - first)) * 100))) : 0;
  return {
    label: 'הבא',
    task: upcoming.name,
    when: `יציאה ${fmtTime(upcoming.start, g.event.timezone)}`,
    startIso: upcoming.start!,
    progress,
  };
}

export interface BuilderTaskVm { id: string; time: string; name: string; sub: string; durPct: number; lock: boolean; version: number; start: string | null }
export interface BuilderSiteVm { id: string; label: string; tasks: BuilderTaskVm[] }

export function mapBuilderSites(g: GraphSnapshot): BuilderSiteVm[] {
  const siteName = new Map(g.resources.map((r) => [r.id, r.name]));
  const bySite = new Map<string, TaskNode[]>();
  for (const t of g.tasks) {
    if (t.status === 'cancelled') continue;
    const arr = bySite.get(t.siteId) ?? [];
    arr.push(t);
    bySite.set(t.siteId, arr);
  }
  const order = g.event.siteIds.length ? g.event.siteIds : [...bySite.keys()];
  return order
    .filter((sid) => bySite.has(sid))
    .map((sid) => ({
      id: sid,
      label: siteName.get(sid) ?? sid,
      tasks: bySite.get(sid)!
        .sort((a, b) => (a.start ?? '9999').localeCompare(b.start ?? '9999'))
        .map((t) => ({
          id: t.id,
          time: fmtTime(t.start, g.event.timezone),
          name: t.name,
          sub: `${t.durationMin} דק׳`,
          durPct: Math.min(100, Math.round((t.durationMin / 60) * 100)),
          lock: t.locked,
          version: t.version,
          start: t.start,
        })),
    }));
}

export type ResourceKindVm = 'person' | 'equipment' | 'location' | 'group';
export interface BuilderResourceVm { id: string; kind: ResourceKindVm; name: string; meta: string; excl: boolean; version: number }

export function mapBuilderResources(g: GraphSnapshot): BuilderResourceVm[] {
  return g.resources.map((r) => ({
    id: r.id,
    kind: r.resourceKind,
    name: r.name,
    meta: r.memberIds?.length ? `${r.memberIds.length} חברים` : '',
    excl: r.exclusive,
    version: r.version,
  }));
}