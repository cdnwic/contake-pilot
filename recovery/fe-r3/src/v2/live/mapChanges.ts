/** Contract ChangeRequest -> v2 approval-card view model.
 *  OPEN (TL point d): proposedBy/resolvedBy are raw user ids — no display-name
 *  directory in v13.3. Fallback: the card's who line shows the Hebrew role label;
 *  swap in real names when TL supplies the directory. */
import type {
  ChangeRequest, GraphSnapshot, ProposedChange, ResourceNode, TaskNode,
} from '../../contracts/contracts.v1';

export interface DiffRow { k: string; old?: string; neu?: string; plain?: string; mono?: boolean }
export interface ChangeCardVm {
  id: string;
  typeFlag: string;
  typeKind: 'tasks' | 'resources' | 'deps' | 'publish';
  who: string;
  role: string;
  when: string;
  title: string;
  diff: DiffRow[];
  domino: { none: boolean; summary: string; items?: string[] };
  baseVersion: number;
  currentVersion: number;
  stale: boolean;
}

const ROLE_HE: Record<string, string> = { admin: 'מנהל-על', field_manager: 'מנהל שטח', focus_worker: 'עובד שטח' };

const fmtTime = (iso: string | null | undefined, tz: string): string =>
  !iso ? '--:--' : new Intl.DateTimeFormat('he-IL', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

function kindOf(t: ProposedChange['type']): ChangeCardVm['typeKind'] {
  if (t.startsWith('task.') || t.startsWith('constraint.') || t === 'domino.apply') return 'tasks';
  if (t.startsWith('resource.')) return 'resources';
  if (t.startsWith('dependency.')) return 'deps';
  return 'publish'; // event.*
}

const TYPE_HE: Record<string, string> = {
  'task.create': 'משימה חדשה', 'task.update': 'עדכון משימה', 'task.move': 'הזזת משימה',
  'task.assign': 'שיבוץ משימה', 'task.delete': 'מחיקת משימה',
  'resource.create': 'משאב חדש', 'resource.update': 'שינוי משאב', 'resource.delete': 'מחיקת משאב',
  'dependency.create': 'תלות חדשה', 'dependency.delete': 'מחיקת תלות',
  'constraint.lock': 'נעילת משימה', 'constraint.unlock': 'ביטול נעילה',
  'event.create': 'אירוע חדש', 'event.update': 'עדכון אירוע', 'event.publish': 'פרסום האירוע',
  'domino.apply': 'החלת דומינו',
};

export function mapChange(cr: ChangeRequest, g: GraphSnapshot): ChangeCardVm {
  const tz = g.event.timezone;
  const task = (id: string): TaskNode | undefined => g.tasks.find((t) => t.id === id);
  const res = (id: string): ResourceNode | undefined => g.resources.find((r) => r.id === id);
  const resNames = (ids: string[]) => ids.map((id) => res(id)?.name ?? id).join(' + ') || '—';
  const c = cr.change;
  let title = '';
  const diff: DiffRow[] = [];

  switch (c.type) {
    case 'task.create': {
      title = c.task.name;
      diff.push({ k: 'אתר', plain: res(c.task.siteId)?.name ?? c.task.siteId });
      diff.push({ k: 'זמן', plain: `${fmtTime(c.task.start, tz)} · ${c.task.durationMin} דק׳`, mono: true });
      if (c.task.assigneeResourceIds.length) diff.push({ k: 'משויך', plain: resNames(c.task.assigneeResourceIds) });
      break;
    }
    case 'task.update': {
      const t = task(c.taskId);
      title = t?.name ?? c.taskId;
      if (c.patch.name) diff.push({ k: 'שם', old: t?.name, neu: c.patch.name });
      if (c.patch.durationMin != null) diff.push({ k: 'משך', old: t ? `${t.durationMin} דק׳` : undefined, neu: `${c.patch.durationMin} דק׳`, mono: true });
      if (c.patch.status) diff.push({ k: 'סטטוס', old: t?.status, neu: c.patch.status });
      break;
    }
    case 'task.move': {
      const t = task(c.taskId);
      title = t?.name ?? c.taskId;
      diff.push({ k: 'זמן', old: fmtTime(t?.start, tz), neu: fmtTime(c.newStart, tz), mono: true });
      break;
    }
    case 'task.assign': {
      const t = task(c.taskId);
      title = t?.name ?? c.taskId;
      diff.push({ k: 'משויך', old: t ? resNames(t.assigneeResourceIds) : undefined, neu: resNames(c.assigneeResourceIds) });
      break;
    }
    case 'task.delete': {
      title = task(c.taskId)?.name ?? c.taskId;
      diff.push({ k: 'משמעות', plain: 'המשימה תימחק מהגרף' });
      break;
    }
    case 'resource.create': {
      title = c.resource.name;
      diff.push({ k: 'סוג', plain: c.resource.resourceKind });
      diff.push({ k: 'בלעדי', plain: c.resource.exclusive ? 'בלעדי' : 'משותף' });
      break;
    }
    case 'resource.update': {
      const r = res(c.resourceId);
      title = r?.name ?? c.resourceId;
      if (c.patch.name) diff.push({ k: 'שם', old: r?.name, neu: c.patch.name });
      if (c.patch.exclusive != null) diff.push({ k: 'בלעדי', old: r?.exclusive ? 'בלעדי' : 'משותף', neu: c.patch.exclusive ? 'בלעדי' : 'משותף' });
      break;
    }
    case 'resource.delete': {
      title = res(c.resourceId)?.name ?? c.resourceId;
      diff.push({ k: 'משמעות', plain: 'המשאב יימחק מהאירוע' });
      break;
    }
    case 'dependency.create': {
      const from = task(c.edge.fromTaskId);
      const to = task(c.edge.toTaskId);
      title = `${from?.name ?? c.edge.fromTaskId} ← ${to?.name ?? c.edge.toTaskId}`;
      diff.push({ k: 'השהיה', plain: `${c.edge.lagMin} דק׳`, mono: true });
      diff.push({ k: 'סוג', plain: c.edge.hard ? 'קשיחה (hard) — הדומינו לא יעקוף' : 'רכה' });
      break;
    }
    case 'dependency.delete': {
      const d = g.dependencies.find((x) => x.id === c.dependencyId);
      title = d ? `${task(d.fromTaskId)?.name ?? ''} ← ${task(d.toTaskId)?.name ?? ''}` : c.dependencyId;
      diff.push({ k: 'משמעות', plain: 'התלות תימחק' });
      break;
    }
    case 'constraint.lock':
    case 'constraint.unlock': {
      title = task(c.taskId)?.name ?? c.taskId;
      diff.push({ k: 'משמעות', plain: c.type === 'constraint.lock' ? 'נעילה — הדומינו לא יזיז' : 'ביטול נעילה' });
      break;
    }
    case 'event.publish': {
      title = 'פרסום האירוע · event.publish';
      diff.push({ k: 'משמעות', plain: 'נעילת היום + שידור לבעלי עניין' });
      break;
    }
    case 'event.update': {
      title = g.event.name;
      if (c.patch.name) diff.push({ k: 'שם', old: g.event.name, neu: c.patch.name });
      if (c.patch.date) diff.push({ k: 'תאריך', old: g.event.date, neu: c.patch.date, mono: true });
      break;
    }
    default: {
      title = TYPE_HE[c.type] ?? c.type;
    }
  }

  const moved = cr.dominoResult.movedTasks.map((m) => {
    const name = task(m.taskId)?.name ?? m.taskId;
    return `${name} ← ${fmtTime(m.beforeStart, tz)}→${fmtTime(m.afterStart, tz)}`;
  });

  return {
    id: cr.id,
    typeFlag: `${TYPE_HE[c.type] ?? c.type} · ${c.type}`,
    typeKind: kindOf(c.type),
    who: ROLE_HE[cr.role] ?? cr.role, // OPEN POINT (d): real display name pending user directory
    role: ROLE_HE[cr.role] ?? cr.role,
    when: fmtTime(cr.createdAt, tz),
    title,
    diff,
    domino: moved.length
      ? { none: false, summary: cr.dominoResult.summaryHe, items: moved }
      : { none: true, summary: cr.dominoResult.summaryHe || 'אין אפקט דומינו' },
    baseVersion: cr.baseGraphVersion,
    currentVersion: g.event.version,
    stale: g.event.version > cr.baseGraphVersion,
  };
}

export function mapChanges(crs: ChangeRequest[], g: GraphSnapshot): ChangeCardVm[] {
  return crs.map((cr) => mapChange(cr, g));
}