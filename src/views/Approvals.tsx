import { useApproveChange, useClientState, useRejectChange } from '../hooks';
import { useSession } from '../state';
import { Card, Chip, DominoRail, Empty, fmtTime } from '../ui';

export function ApprovalsView() {
  const { data } = useClientState();
  const { role, showToast } = useSession();
  const approve = useApproveChange();
  const reject = useRejectChange();
  if (!data) return <Empty>טוען…</Empty>;
  const { graph, changes } = data;
  const tz = graph.event.timezone;
  const canDecide = role === 'admin' || (role as string) === 'coordinator';
  const pending = changes.filter((c) => c.state === 'pending_review');
  const decided = changes.filter((c) => c.state !== 'pending_review');

  const onApprove = (id: string) => approve.mutate(id, {
    onSuccess: () => showToast('✅ אושר — הלוח עודכן, עדכונים ממתינים במסך הסנכרון'),
    onError: (e) => showToast(e instanceof Error && e.message === 'stale_base' ? '⚠️ בסיס השינוי לא עדכני (409) — המתן לרענון ואשר שוב' : 'שגיאה באישור'),
  });
  const onReject = (id: string) => reject.mutate(id, { onSuccess: () => showToast('🚫 נדחה — הלוח נשאר ללא שינוי') });

  return (
    <div>
      {!pending.length && <Empty>אין כרטיסי אישור ממתינים. דיווח שטח ≥S1 או עריכת משימה ≥S1 יופיעו כאן.</Empty>}
      {pending.map((c) => {
        const d = c.dominoResult;
        const trigger = graph.tasks.find((t) => t.id === c.proposedChange?.taskId);
        return (
          <Card key={c.id} title="כרטיס אישור" sub={`${c.id} · נוצר ${new Date(c.createdAt).toLocaleTimeString('he-IL')}`}>
            <div className="kv" style={{ marginBottom: 12 }}>
              <div className="stat"><div className="v">{d.maxImpactClass}</div><div className="l">דרגת השפעה</div></div>
              <div className="stat"><div className="v">{d.movedTasks.length}</div><div className="l">משימות זזות</div></div>
              <div className="stat"><div className="v">{d.blockedTaskIds.length}</div><div className="l">קפואות (מאחורי נעילה)</div></div>
              <div className="stat"><div className="v">{d.impacts.filter((i) => i.channelType === 'group').length}</div><div className="l">ערוצי קבוצה</div></div>
            </div>
            <p><b>סיבה:</b> {c.reasonHe}</p>
            {trigger && <p className="meta">טריגר: {trigger.name} · {fmtTime(trigger.start, tz)}</p>}
            <DominoRail graph={graph} domino={d} />
            <p style={{ fontSize: 'var(--text-dense)', color: 'var(--ink-2)' }}>{d.summaryHe}</p>
            {d.conflicts.map((cf, i) => <div key={i} className={`warn ${cf.blocking ? 'slip' : 'risk'}`} role="note">{cf.messageHe}</div>)}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              {canDecide ? (
                <>
                  <button className="btn primary" onClick={() => onApprove(c.id)} disabled={approve.isPending} aria-label={`אישור שינוי ${c.id}`}>✅ אשר והחל על הלוח</button>
                  <button className="btn danger" onClick={() => onReject(c.id)} disabled={reject.isPending} aria-label={`דחיית שינוי ${c.id}`}>🚫 דחה</button>
                </>
              ) : (
                <Chip kind="off" label="אין הרשאת אישור">ממתין לאישור מנהל-על / רכז</Chip>
              )}
            </div>
            {c.proposedChange?.delayMin != null && <p className="meta" style={{ marginTop: 8 }}>איחור מדווח: {c.proposedChange.delayMin} דקות · גרסת בסיס {c.baseGraphVersion}</p>}
          </Card>
        );
      })}
      {decided.length > 0 && (
        <Card title="היסטוריית החלטות" sub={`${decided.length}`}>
          <table className="taskrows">
            <thead><tr><th scope="col">כרטיס</th><th scope="col">סיבה</th><th scope="col">החלטה</th><th scope="col">בסיס</th></tr></thead>
            <tbody>{decided.map((c) => (
              <tr key={c.id}>
                <td className="t">{c.id}</td><td>{c.reasonHe}</td>
                <td>{c.state === 'approved' ? <Chip kind="ok">אושר</Chip> : <Chip kind="off">נדחה</Chip>}</td>
                <td className="t">{c.baseGraphVersion}</td>
              </tr>))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}