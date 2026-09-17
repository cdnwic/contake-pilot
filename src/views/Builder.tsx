import { useState } from 'react';
import { useClientState, useDeleteTask, useSaveTask } from '../hooks';
import { useSession } from '../state';
import { Card, Chip, Empty, fmtTime } from '../ui';
import type { ResourceNode, TaskNode } from '../contracts/contake-core-contracts.v1.1';

export function BuilderView() {
  const { data } = useClientState();
  const { role, showToast, profileId } = useSession();
  const saveTask = useSaveTask();
  const deleteTask = useDeleteTask();
  const [editing, setEditing] = useState<TaskNode | null>(null);
  const [creating, setCreating] = useState(false);
  if (!data) return <Empty>טוען…</Empty>;
  const { graph } = data;
  const tz = graph.event.timezone;
  const canEdit = role !== 'focus_worker';
  const tasks = [...graph.tasks].sort((a, b) => Date.parse(a.start ?? '') - Date.parse(b.start ?? ''));
  const nameOf = (id: string) => tasks.find((x) => x.id === id)?.name ?? id;
  const predsOf = (id: string) => graph.dependencies.filter((d) => d.fromTaskId === id).map((d) => nameOf(d.toTaskId));
  const succsOf = (id: string) => graph.dependencies.filter((d) => d.toTaskId === id).map((d) => nameOf(d.fromTaskId));

  const startCreate = () => {
    const last = tasks[tasks.length - 1];
    setEditing({
      id: 'new', kind: 'task', eventId: graph.event.id, siteId: graph.event.siteIds[0], name: '',
      start: last?.start ? new Date(Date.parse(last.start) + last.durationMin * 60000).toISOString() : null,
      durationMin: 30, status: 'planned', locked: false, assigneeResourceIds: [], version: 1,
    });
    setCreating(true);
  };

  return (
    <div className="builder-grid">
      <Card title="מבנה האירוע" sub={`${tasks.length} משימות · ${graph.dependencies.length} תלויות`}
        actions={canEdit ? <button className="btn primary" onClick={startCreate} aria-label="הוספת משימה חדשה">＋ משימה חדשה</button> : undefined}>
        {role === 'field_manager' && <div className="warn risk" role="note">מנהל שטח: שינויים בנעילה/זמנים מעל S0 ישלחו אוטומטית לאישור מנהל-על.</div>}
        <table className="taskrows">
          <thead><tr><th scope="col">שעה</th><th scope="col">משימה</th><th scope="col">דק׳</th><th scope="col">תלוי ב</th><th scope="col">מזיז</th><th scope="col">סטטוס</th>{canEdit && <th scope="col"></th>}</tr></thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id}>
                <td className="t"><time dateTime={t.start ?? ''}>{fmtTime(t.start, tz)}</time></td>
                <td>{t.locked ? `🔒 ${t.name}` : t.name}</td>
                <td className="t">{t.durationMin}</td>
                <td>{predsOf(t.id).join(', ') || '—'}</td>
                <td>{succsOf(t.id).join(', ') || '—'}</td>
                <td>{t.locked ? <Chip kind="off">נעול</Chip> : t.status === 'delayed' ? <Chip kind="slip">חריג</Chip> : <Chip kind="ok">{t.status === 'done' ? 'בוצע' : 'מתוכנן'}</Chip>}</td>
                {canEdit && (
                  <td style={{ display: 'flex', gap: 6 }}>
                    <button className="btn ghost" aria-label={`עריכת ${t.name}`} onClick={() => { setEditing(t); setCreating(false); }}>✏️</button>
                    <button className="btn ghost danger" aria-label={`מחיקת ${t.name}`} onClick={() => deleteTask.mutate(t.id, { onSuccess: (r) => showToast(r.outcome === 'pending_review' ? '📨 נשלח לאישור מנהל-על' : '🗑 המשימה נמחקה') })}>🗑</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="meta" style={{ marginTop: 8 }}>עריכת תלויות: בקרוב — התלויות נטענות מגרף הבסיס (DAG מאומת בשרת).</p>
      </Card>
      {editing && (
        <TaskEditor
          key={`${editing.id}-${profileId}`}
          task={editing}
          creating={creating}
          resources={graph.resources}
          onClose={() => setEditing(null)}
          onSave={(draft) => {
            saveTask.mutate(
              { taskId: creating ? null : editing.id, draft },
              {
                onSuccess: (r) => {
                  setEditing(null);
                  showToast(r.outcome === 'pending_review' ? '📨 נשלח לאישור מנהל-על' : r.outcome === 'denied' ? `⛔ ${r.messageHe}` : '💾 נשמר');
                },
                onError: (e) => showToast(`שגיאה: ${e instanceof Error ? e.message : 'unknown'}`),
              },
            );
          }}
        />
      )}
    </div>
  );
}

function TaskEditor({ task, creating, resources, onClose, onSave }: {
  task: TaskNode; creating: boolean;
  resources: ResourceNode[];
  onClose: () => void;
  onSave: (draft: Partial<TaskNode> & { name: string }) => void;
}) {
  const [name, setName] = useState(task.name);
  const [time, setTime] = useState(task.start ? task.start.slice(11, 16) : '09:00');
  const [duration, setDuration] = useState(task.durationMin);
  const [locked, setLocked] = useState(task.locked);
  const [assignees, setAssignees] = useState<string[]>(task.assigneeResourceIds);
  const dayBase = (task.start ?? new Date().toISOString()).slice(0, 10);
  const toggle = (id: string) => setAssignees((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));

  return (
    <Card title={creating ? 'משימה חדשה' : `עריכה: ${task.name}`}>
      <form className="stack" onSubmit={(e) => {
        e.preventDefault();
        onSave({ name, start: `${dayBase}T${time}:00`, durationMin: Number(duration), locked, assigneeResourceIds: assignees });
      }}>
        <div className="field"><label htmlFor="t-name">שם משימה</label>
          <input id="t-name" value={name} onChange={(e) => setName(e.target.value)} required /></div>
        <div className="grid2">
          <div className="field"><label htmlFor="t-time">שעת התחלה</label>
            <input id="t-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} required /></div>
          <div className="field"><label htmlFor="t-dur">משך (דקות)</label>
            <input id="t-dur" type="number" min={5} step={5} value={duration} onChange={(e) => setDuration(Number(e.target.value))} required /></div>
        </div>
        <div className="field"><span className="field label" role="group" aria-label="שיוך משאבים">שיוך</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {resources.filter((r) => r.resourceKind !== 'group').map((r) => (
              <button type="button" key={r.id} className={`btn ${assignees.includes(r.id) ? 'primary' : 'ghost'}`} aria-pressed={assignees.includes(r.id)}
                onClick={() => toggle(r.id)}>{r.name}</button>
            ))}
          </div>
        </div>
        <div className="field" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input id="t-lock" type="checkbox" checked={locked} onChange={(e) => setLocked(e.target.checked)} />
          <label htmlFor="t-lock">🔒 משימה נעולה (לא תזוז; תלויים יקפאו מאחוריה — שינוי דורש אישור)</label>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" type="submit" disabled={!name.trim()}>{creating ? 'צור משימה' : 'שמור שינויים'}</button>
          <button className="btn ghost" type="button" onClick={onClose}>ביטול</button>
        </div>
      </form>
    </Card>
  );
}