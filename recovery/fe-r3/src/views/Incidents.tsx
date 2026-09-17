import { useState } from 'react';
import { useClientState, useSubmitReport } from '../hooks';
import { useSession } from '../state';
import { Card, Chip, Empty, fmtTime } from '../ui';

export function IncidentsView() {
  const { data } = useClientState();
  const { showToast, role } = useSession();
  const submitReport = useSubmitReport();
  const [taskId, setTaskId] = useState<string>('');
  const [status, setStatus] = useState<'done' | 'delayed' | 'issue'>('delayed');
  const [delayMin, setDelayMin] = useState(30);
  const [note, setNote] = useState('');
  if (!data) return <Empty>טוען…</Empty>;
  const { graph, reports } = data;
  const tz = graph.event.timezone;

  const submit = () => {
    if (!taskId) return;
    submitReport.mutate(
      { taskId, status: status === 'issue' ? 'blocked' as const : status, delayMin: status === 'delayed' ? delayMin : undefined, noteHe: note || undefined, clientReportId: crypto.randomUUID() },
      {
        onSuccess: (r) => {
          if (r.duplicate) showToast('הדיווח כבר נקלט בעבר (idempotency)');
          else if (r.outcome === 'pending_review') showToast('📡 נקלט — עבר לאישור מנהל-על (≥S1)');
          else if (r.outcome === 'auto_applied') showToast('📡 נקלט והוחל אוטומטית (S0)');
          else showToast('📡 נקלט');
          setNote('');
        },
      },
    );
  };

  return (
    <div className="builder-grid">
      <Card title="דיווח שטח חדש" sub="זמין גם מהאפליקציה בפוקוס מוד">
        <div className="stack">
          <div className="field"><label htmlFor="r-task">משימה</label>
            <select id="r-task" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
              <option value="">בחר משימה…</option>
              {graph.tasks.map((t) => <option key={t.id} value={t.id}>{fmtTime(t.start, tz)} · {t.name}</option>)}
            </select></div>
          <div className="field"><span className="field label" role="group" aria-label="סטטוס דיווח">סטטוס</span>
            <div style={{ display: 'flex', gap: 6 }}>
              {([['done', '✅ בוצע'], ['delayed', '⏱ איחור'], ['issue', '⚠️ תקלה']] as const).map(([v, l]) => (
                <button type="button" key={v} className={`btn ${status === v ? 'primary' : 'ghost'}`} aria-pressed={status === v} onClick={() => setStatus(v)}>{l}</button>
              ))}
            </div></div>
          {status === 'delayed' && (
            <div className="field"><label htmlFor="r-delay">איחור בדקות</label>
              <input id="r-delay" type="number" min={5} step={5} value={delayMin} onChange={(e) => setDelayMin(Number(e.target.value))} /></div>
          )}
          <div className="field"><label htmlFor="r-note">הערה (אופציונלי)</label>
            <input id="r-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="למשל: האוטובוס תקוע בכביש 6" /></div>
          <button className="btn primary" disabled={!taskId || submitReport.isPending} onClick={submit} aria-label="שליחת דיווח">
            {submitReport.isPending ? 'שולח…' : '📡 שלח דיווח'}
          </button>
          {role === 'focus_worker' && <p className="meta">עובד שטח: הדיווח מופיע אצל המנהלים מיד; שינויים ≥S1 ממתינים לאישור.</p>}
        </div>
      </Card>
      <Card title="יומן דיווחים" sub={`${reports.length} דיווחים`}>
        {!reports.length && <Empty>עדיין לא נקלטו דיווחים.</Empty>}
        <table className="taskrows">
          <thead><tr><th scope="col">שעה</th><th scope="col">משימה</th><th scope="col">דיווח</th><th scope="col">תוצאה</th></tr></thead>
          <tbody>{[...reports].reverse().map((r) => {
            const t = graph.tasks.find((x) => x.id === r.taskId);
            return (
              <tr key={r.clientReportId}>
                <td className="t">{new Date(r.receivedAt ?? r.createdAt).toLocaleTimeString('he-IL')}</td>
                <td>{t?.name ?? r.taskId}</td>
                <td>{r.status === 'delayed' ? `⏱ +${r.delayMin ?? 0}′` : r.status === 'done' ? '✅ בוצע' : '⚠️ תקלה'}{r.noteHe ? ` · ${r.noteHe}` : ''}</td>
                <td>{r.outcome === 'auto_applied' ? <Chip kind="ok">הוחל אוטומטית</Chip> : r.outcome === 'pending_review' ? <Chip kind="risk">ממתין לאישור</Chip> : <Chip kind="off">ללא שינוי</Chip>}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </Card>
    </div>
  );
}