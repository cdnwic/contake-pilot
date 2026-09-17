import { useState } from 'react';
import { api, useClientState, useDemoIncident, useSubmitReport } from '../hooks';
import { useSession } from '../state';
import { Card, Chip, DayGrid, DominoRail, Empty, TaskListView, fmtTime } from '../ui';

export function TowerView() {
  const { data } = useClientState();
  const { role, showToast, setView, highlightTaskId } = useSession();
  const submitReport = useSubmitReport();
  const incident = useDemoIncident();
  const [listMode, setListMode] = useState(false);
  if (!data) return <Empty>טוען…</Empty>;
  const { graph, changes, pendingNotifications } = data;
  const tz = graph.event.timezone;
  const pendingCr = changes.find((c) => c.state === 'pending_review' && c.dominoResult.movedTasks.length > 0);
  const delayed = graph.tasks.filter((t) => t.status === 'delayed');
  const movedIds = pendingCr ? undefined : undefined;

  const reportIncident = () => {
    if (!incident) return;
    submitReport.mutate(
      { taskId: incident.taskId, status: 'delayed', delayMin: incident.delayMin, noteHe: incident.detail, clientReportId: `demo-${data.profile.id}-${incident.taskId}` },
      {
        onSuccess: (r) => {
          if (r.duplicate) showToast('הדיווח כבר נקלט בעבר (idempotency)');
          else if (r.outcome === 'pending_review') showToast('📡 הדיווח נקלט — ממתין לאישור מנהל-על');
          else if (r.outcome === 'auto_applied') showToast('📡 הדיווח נקלט והוחל אוטומטית (S0)');
          else showToast('📡 הדיווח נקלט');
        },
      },
    );
  };

  return (
    <div>
      {pendingCr && (
        <div className="alert" role="alert">
          <span aria-hidden="true">⚠️</span>
          <div>
            <b>{pendingCr.reasonHe}</b>
            <div className="meta">דווח מהשטח · דרגת השפעה {pendingCr.dominoResult.maxImpactClass} · גרסת בסיס {pendingCr.baseGraphVersion}</div>
          </div>
          <button className="btn primary" onClick={() => setView('approvals')} aria-label="מעבר לכרטיס האישור">לכרטיס האישור ←</button>
        </div>
      )}
      <div className="tower-grid">
        <Card title="לוח זמנים יומי" sub={`${graph.tasks.length} משימות · ${graph.resources.filter((r) => r.resourceKind === 'group').length} קבוצות`}
          actions={
            <span style={{ display: 'flex', gap: 8 }}>
              <button className="btn ghost" onClick={() => setListMode((v) => !v)} aria-pressed={listMode} aria-label="מעבר בין תרשים לרשימה">{listMode ? '📊 תרשים' : '📋 תצוגת רשימה'}</button>
              {incident && role !== 'focus_worker' && !pendingCr && (
                <button className="btn danger" onClick={reportIncident} disabled={submitReport.isPending} aria-label={`סימולציית דיווח שטח: ${incident.title}`}>
                  📡 דווח: {incident.title.split('—')[0]}
                </button>
              )}
            </span>
          }>
          <div className="kv" style={{ marginBottom: 12 }}>
            <div className="stat"><div className="v">{graph.tasks.filter((t) => t.status !== 'delayed').length}</div><div className="l">תקין</div></div>
            <div className="stat"><div className="v">{delayed.length}</div><div className="l">חריג</div></div>
            <div className="stat"><div className="v">{changes.filter((c) => c.state === 'pending_review').length}</div><div className="l">ממתינים לאישור</div></div>
            <div className="stat"><div className="v">{pendingNotifications.length}</div><div className="l">עדכונים ממתינים</div></div>
          </div>
          {listMode ? <TaskListView graph={graph} /> : <DayGrid graph={graph} nowMin={8 * 60 + 7} />}
          {pendingCr && (
            <div style={{ marginTop: 12 }}>
              <DominoRail graph={graph} domino={pendingCr.dominoResult} />
              <p style={{ fontSize: 'var(--text-dense)', color: 'var(--ink-2)' }}>
                {pendingCr.dominoResult.summaryHe} · <Chip kind="impact" label="דרגת השפעה">{pendingCr.dominoResult.maxImpactClass}</Chip>
                {pendingCr.dominoResult.blockedTaskIds.length > 0 && <> · ❄️ {pendingCr.dominoResult.blockedTaskIds.length} משימות קפואות מאחורי נעילה</>}
              </p>
              {pendingCr.dominoResult.conflicts.map((c, i) => <div key={i} className={`warn ${c.blocking ? 'slip' : 'risk'}`}>{c.messageHe}</div>)}
            </div>
          )}
        </Card>
        <Card title="מה קורה עכשיו" sub="שעה · עכשיו · הבא · מה זז">
          <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 'var(--text-dense)' }}>
            {[...graph.tasks].sort((a, b) => Date.parse(a.start!) - Date.parse(b.start!)).slice(0, 6).map((t) => (
              <li key={t.id} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <time className="tnum" dateTime={t.start!} style={{ color: 'var(--ink-3)' }}>{fmtTime(t.start, tz)}</time>
                <bdi style={{ fontWeight: 600 }}>{t.name}</bdi>
                {t.locked && <span aria-label="נעולה">🔒</span>}
                {t.status === 'delayed' ? <Chip kind="slip">חריג</Chip> : <Chip kind="ok">תקין</Chip>}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}