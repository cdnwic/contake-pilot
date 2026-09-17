/** PR-3 (plan §3ה): interactive notification center. Feed synthesized client-side
 *  (no new endpoints); actions run through the single dispatcher; handled-state
 *  reconciles via frames — the dispatcher never mutates the local graph. */
import { useMemo } from 'react';
import { useSession } from '../state';
import { useClientState, usePrincipal, api } from '../hooks';
import { badgeCount, synthesizeFeed, type NotificationItem } from '../notify/center';
import { actionsFor, actionLabel, dispatchAction, liveDeps } from '../notify/dispatcher';
import type { ClientState } from '../api/mockApi';
import type { Principal } from '../contracts/contake-core-contracts.v1.1';
import { useQueryClient } from '@tanstack/react-query';
import { LockIcon } from '../ui';

function relTime(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (m < 1) return 'עכשיו';
  if (m < 60) return `לפני ${m} דק׳`;
  const h = Math.floor(m / 60);
  return h < 24 ? `לפני ${h} שע׳` : `לפני ${Math.floor(h / 24)} ימים`;
}

function BellIcon() {
  return (
    <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
      <path d="M7 1.5a4 4 0 0 0-4 4v2.2L1.8 9.9a.6.6 0 0 0 .5.9h9.4a.6.6 0 0 0 .5-.9L11 7.7V5.5a4 4 0 0 0-4-4Z" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.6 12a1.5 1.5 0 0 0 2.8 0" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function NotifyBell() {
  const { notifyOpen, setNotifyOpen } = useSession();
  const { data } = useClientState();
  const { notifyFailures, sessionReports } = useSession();
  const items = useMemo(
    () => (data ? synthesizeFeed(data, notifyFailures.map((f) => ({ ...f, at: new Date().toISOString() })), sessionReports) : []),
    [data, notifyFailures, sessionReports]);
  const n = badgeCount(items);
  return (
    <button className="nav-tab bell" aria-label={`מרכז עדכונים${n ? `, ${n} ממתינים` : ''}`} aria-expanded={notifyOpen} onClick={() => setNotifyOpen(!notifyOpen)}>
      <BellIcon />
      {n > 0 && <span className="cnt alert" aria-hidden="true">{n}</span>}
    </button>
  );
}

function Item({ item }: { item: NotificationItem }) {
  const { role, inFlight, lockItem, unlockItem, showToast, ackSupported, setAckSupported, setNotifyOpen, setView, setHighlightTask, profileId } = useSession();
  const principal = usePrincipal();
  const qc = useQueryClient();
  const locked = inFlight.includes(item.id);
  const resync = () => { void qc.invalidateQueries({ queryKey: ['client-state', profileId, role] }); };
  const deps = liveDeps(profileId, {
    isLocked: (id: string) => useSession.getState().inFlight.includes(id),
    lock: lockItem, unlock: unlockItem, toast: showToast, resync,
  });
  // Ack lane gated on the live endpoint (contracts v1.8): a 404 marks it unsupported
  // for the session and hides the lane — no dead buttons.
  deps.ackNotifyJob = async (jobId, p) => {
    try {
      await api.ackNotifyJob(profileId, jobId, p);
      return { acknowledgedBy: p.userId, acknowledgedAt: new Date().toISOString() };
    } catch (e) {
      if ((e as { status?: number }).status === 404) { setAckSupported(false); throw new Error('נקודת האישור טרם פעילה בשרת'); }
      throw e;
    }
  };
  const run = (a: 'approve' | 'reject' | 'ack') => { void dispatchAction(item, a, principal, deps); };
  const acts = role === 'admin' ? actionsFor(item, ackSupported !== false) : [];
  const jump = () => {
    if (item.taskId) setHighlightTask(item.taskId);
    setView('tower');
    setNotifyOpen(false);
  };
  const kindChip = item.kind === 'change_pending' ? 'ממתין לאישור' : item.kind === 'change_resolved' ? 'טופל' : item.kind === 'job_failed' ? 'כשל שליחה' : 'דיווח';
  return (
    <li className={`nt-item ${item.severity}`}>
      <div className="nt-head">
        <span className={`chip ${item.severity === 'critical' ? 'slip' : item.severity === 'action' ? 'risk' : 'off'}`}>{kindChip}</span>
        <span className="nt-time tnum">{relTime(item.at)}</span>
      </div>
      <div className="nt-title">{item.titleHe}</div>
      {item.bodyHe && <div className="nt-body">{item.bodyHe}</div>}
      {item.handledBy && <div className="nt-handled"><LockIcon /> טופל על ידי {item.handledBy}{item.handledAt ? ` · ${relTime(item.handledAt)}` : ''}</div>}
      <div className="nt-actions">
        {acts.map((a) => (
          <button key={a} className={`btn ${a === 'approve' ? 'primary' : a === 'ack' ? 'outline' : 'ghost'}`} disabled={locked} aria-busy={locked} onClick={() => run(a)}>
            {locked ? 'מעבד…' : actionLabel(a)}
          </button>
        ))}
        {item.taskId && <button className="btn ghost" onClick={jump}>צפה במגדל</button>}
        {item.taskId && <a className="btn ghost" href={`./focus.html?profile=${profileId}&task=${item.taskId}`} target="_blank" rel="noreferrer">פתח בפוקוס ↗</a>}
      </div>
    </li>
  );
}

export function NotifyPanel() {
  const { notifyOpen, setNotifyOpen } = useSession();
  const { data } = useClientState();
  const { notifyFailures, sessionReports } = useSession();
  const items = useMemo(
    () => (data ? synthesizeFeed(data, notifyFailures.map((f) => ({ ...f, at: new Date().toISOString() })), sessionReports) : []),
    [data, notifyFailures, sessionReports]);
  if (!notifyOpen) return null;
  return (
    <section className="nt-panel" aria-label="מרכז עדכונים">
      <div className="nt-panel-head">
        <h2>עדכונים</h2>
        <button className="btn ghost" onClick={() => setNotifyOpen(false)} aria-label="סגירת מרכז העדכונים">סגור ✕</button>
      </div>
      {items.length === 0 ? <p className="nt-empty">אין עדכונים כרגע.</p> : (
        <ul className="nt-list">{items.map((i) => <Item key={i.id} item={i} />)}</ul>
      )}
    </section>
  );
}