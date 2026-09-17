/** Shared Board components (design language v0.2). Hebrew aria labels from day one (QA F1). */
import type { ReactNode } from 'react';
import type { DominoResult, GraphSnapshot, TaskNode } from './contracts/contake-core-contracts.v1.1';

export const fmtTime = (iso: string | null, tz: string): string =>
  iso == null ? '—' : new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(new Date(iso));

export const endOf = (t: TaskNode): string | null =>
  t.start == null ? null : new Date(Date.parse(t.start) + t.durationMin * 60000).toISOString();

export function Chip({ kind, children, label }: { kind: 'ok' | 'risk' | 'slip' | 'off' | 'impact'; children: ReactNode; label?: string }) {
  return <span className={`chip ${kind}`} aria-label={label}>{children}</span>;
}

export function Card({ title, sub, children, actions }: { title: string; sub?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      <div className="card-h">{title}{sub ? <span className="sub">· {sub}</span> : null}<span style={{ marginInlineStart: 'auto' }}>{actions}</span></div>
      <div className="card-b">{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** Day Grid (design §6.5): time ruler + task bars per row, RTL flow. */
export function DayGrid({ graph, movedIds, slipIds, nowMin }: {
  graph: GraphSnapshot; movedIds?: Set<string>; slipIds?: Set<string>; nowMin?: number;
}) {
  const tz = graph.event.timezone;
  const starts = graph.tasks.map((t) => Date.parse(t.start!));
  const min0 = Math.floor(Math.min(...starts) / 60000 / 30) * 30;
  const ends = graph.tasks.map((t) => Date.parse(t.start!) + t.durationMin * 60000);
  const min1 = Math.ceil(Math.max(...ends) / 60000 / 30) * 30;
  const pct = (m: number) => ((m - min0) / (min1 - min0)) * 100;
  const toMin = (iso: string) => {
    const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(new Date(iso));
    const [h, m] = parts.split(':').map(Number);
    return h * 60 + m;
  };
  const rows: Array<{ id: string; label: string; sub: string; tasks: TaskNode[] }> = [];
  const grouped = new Map<string, TaskNode[]>();
  for (const t of graph.tasks) {
    const grp = t.assigneeResourceIds
      .map((r) => graph.resources.find((x) => x.id === r))
      .find((r) => r?.resourceKind === 'group');
    const key = grp?.id ?? 'misc';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(t);
  }
  for (const [gid, tasks] of grouped) {
    const g = graph.resources.find((x) => x.id === gid);
    rows.push({ id: gid, label: g?.name ?? 'כללי', sub: g?.resourceKind === 'group' ? 'קבוצה' : '', tasks: [...tasks].sort((a, b) => Date.parse(a.start!) - Date.parse(b.start!)) });
  }
  // shared exclusive locations as resource rows
  for (const r of graph.resources.filter((x) => x.resourceKind === 'location' && x.exclusive)) {
    const tasks = graph.tasks.filter((t) => t.assigneeResourceIds.includes(r.id));
    if (tasks.length) rows.push({ id: r.id, label: r.name, sub: 'משאב משותף', tasks: [...tasks].sort((a, b) => Date.parse(a.start!) - Date.parse(b.start!)) });
  }
  const ticks: number[] = [];
  for (let m = min0; m <= min1; m += 60) ticks.push(m);
  // REWRITE-FIX (r3): ticks are epoch-minutes; render wall-clock HH:MM in the event
  //  timezone (r2.1 printed epoch-minute arithmetic — era-skew regression vs RC).
  const hhmm = (m: number) => fmtTime(new Date(m * 60000).toISOString(), tz);
  return (
    <div className="daygrid" role="img" aria-label="תרשים לוח זמנים יומי — זמין גם כרשימה במעבר לתצוגת רשימה">
      <div className="dg-inner">
        <div className="dg-ruler" aria-hidden="true">
          {ticks.map((m) => <span key={m} className="dg-tick" style={{ insetInlineStart: `${pct(m)}%` }}><bdi>{hhmm(m)}</bdi></span>)}
        </div>
        {rows.map((row) => (
          <div className="dg-row" key={row.id}>
            <div className="dg-label">{row.label}<small>{row.sub}</small></div>
            <div className="dg-track">
              {nowMin != null && <div className="dg-now" style={{ insetInlineStart: `${pct(nowMin)}%` }} data-time={hhmm(nowMin)} />}
              {row.tasks.map((t) => {
                const s = toMin(t.start!);
                const e = s + t.durationMin;
                const cls = ['dg-bar'];
                if (t.locked) cls.push('locked');
                if (movedIds?.has(t.id)) cls.push('moved');
                if (slipIds?.has(t.id) || t.status === 'delayed') cls.push('slip');
                return (
                  <span key={t.id} className={cls.join(' ')} style={{ insetInlineStart: `${pct(s)}%`, width: `${pct(e) - pct(s)}%` }}
                    title={`${t.name} · ${fmtTime(t.start, tz)}–${fmtTime(endOf(t), tz)}`}>
                    {t.name}{t.locked ? ' 🔒' : ''}
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Task schedule as an accessible list (charter §11 text alternative). */
export function TaskListView({ graph, movedIds }: { graph: GraphSnapshot; movedIds?: Set<string> }) {
  const tz = graph.event.timezone;
  const resName = (id: string) => graph.resources.find((r) => r.id === id)?.name ?? id;
  const tasks = [...graph.tasks].sort((a, b) => Date.parse(a.start!) - Date.parse(b.start!));
  return (
    <table className="taskrows">
      <thead><tr><th scope="col">התחלה</th><th scope="col">סיום</th><th scope="col">משימה</th><th scope="col">שיוך</th><th scope="col">סטטוס</th></tr></thead>
      <tbody>
        {tasks.map((t) => (
          <tr key={t.id}>
            <td className="t"><time dateTime={t.start!}>{fmtTime(t.start, tz)}</time></td>
            <td className="t"><time dateTime={endOf(t)!}>{fmtTime(endOf(t), tz)}</time></td>
            <td>{t.locked ? <span className="lockbar">{t.name} 🔒</span> : t.name}</td>
            <td>{t.assigneeResourceIds.filter((id) => ['person', 'location'].includes(graph.resources.find((r) => r.id === id)?.resourceKind ?? '')).map(resName).join(' · ')}</td>
            <td>{movedIds?.has(t.id) ? <Chip kind="risk">הוזז</Chip> : t.status === 'delayed' ? <Chip kind="slip">חריג</Chip> : t.locked ? <Chip kind="off">נעול 🔒</Chip> : <Chip kind="ok">תקין</Chip>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Domino Rail (design §6.4) — dependency chain as stations; <768px collapses to list via CSS. */
export function DominoRail({ graph, domino }: { graph: GraphSnapshot; domino: DominoResult }) {
  const tz = graph.event.timezone;
  const moved = new Map(domino.movedTasks.map((m) => [m.taskId, m]));
  const blocked = new Set(domino.blockedTaskIds);
  const lockConflicts = new Set(domino.conflicts.filter((c) => c.code === 'LOCK_VIOLATION').flatMap((c) => c.taskIds));
  const stations = [...graph.tasks]
    .filter((t) => moved.has(t.id) || blocked.has(t.id) || lockConflicts.has(t.id))
    .sort((a, b) => Date.parse(a.start!) - Date.parse(b.start!));
  if (!stations.length) return null;
  const shift = (id: string) => {
    const m = moved.get(id);
    if (!m || !m.beforeStart) return null;
    return Math.round((Date.parse(m.afterStart) - Date.parse(m.beforeStart)) / 60000);
  };
  return (
    <div className="rail" role="list" aria-label="שרשרת אפקט הדומינו">
      <div className="rail-track">
        {stations.map((t, i) => {
          const d = shift(t.id);
          const cls = ['station'];
          if (lockConflicts.has(t.id) || blocked.has(t.id)) cls.push('locked');
          else if (d != null && d > 0) cls.push('moved');
          if (t.status === 'delayed') cls.push('slip');
          return (
            <span key={t.id} style={{ display: 'contents' }}>
              {i > 0 && <span className={`rail-seg ${lockConflicts.has(t.id) ? 'conflict' : ''}`} aria-hidden="true" />}
              <span className={cls.join(' ')} role="listitem" aria-label={`${t.name}${d != null && d > 0 ? `, זזה ${d} דקות` : ''}${t.locked ? ', נעולה' : ''}`}>
                <span className="node" aria-hidden="true" />
                <span className="nm"><bdi>{t.name}</bdi>{t.locked ? ' 🔒' : ''}</span>
                <span className="tm">{fmtTime(t.start, tz)}</span>
                {d != null && d > 0 && <span className="off">+{d}′</span>}
                {blocked.has(t.id) && <span className="off">קפוא — ממתין לפתרון</span>}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
export const LockIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);
