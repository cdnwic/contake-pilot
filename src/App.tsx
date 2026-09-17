import { useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { api, useClientState } from './hooks';
import { useSession, VIEWS } from './state';
import { fmtTime } from './ui';
import { TowerView } from './views/Tower';
import { BuilderView } from './views/Builder';
import { ApprovalsView } from './views/Approvals';
import { IncidentsView } from './views/Incidents';
import { SyncView } from './views/Sync';
import { NotifyBell, NotifyPanel } from './views/NotifyCenter';

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
}

function Shell() {
  const { view, setView, profileId, setProfile, role, setRole, theme, setTheme, toast, clearToast } = useSession();
  const { data } = useClientState();
  const { data: profiles = [] } = useQuery({ queryKey: ['profiles'], queryFn: () => api.getProfiles() });
  const clock = useClock();

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => { document.documentElement.dataset.vertical = profileId; }, [profileId]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(clearToast, 4000);
    return () => clearTimeout(t);
  }, [toast, clearToast]);

  const pendingCount = data?.changes.filter((c) => c.state === 'pending_review').length ?? 0;

  const header = useMemo(() => {
    if (!data) return null;
    const { graph, changes } = data;
    const tz = graph.event.timezone;
    const tasks = [...graph.tasks].filter((t) => t.start).sort((a, b) => Date.parse(a.start!) - Date.parse(b.start!));
    const boardNow = tasks.length ? Date.parse(tasks[0].start!) : Date.now();
    const next = tasks.find((t) => Date.parse(t.start!) > boardNow) ?? null;
    const tminus = next ? Math.max(0, Math.round((Date.parse(next.start!) - boardNow) / 60000)) : null;
    const fmtT = (m: number) => `T-${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const movedIds = new Set(changes.filter((c) => c.state === 'pending_review').flatMap((c) => c.dominoResult.movedTasks.map((m) => m.taskId)));
    const counts = { ok: 0, risk: 0, slip: 0, off: 0 };
    for (const t of graph.tasks) {
      if (t.status === 'delayed') counts.slip += 1;
      else if (t.status === 'done' || t.status === 'cancelled') counts.off += 1;
      else if (movedIds.has(t.id)) counts.risk += 1;
      else counts.ok += 1;
    }
    const dayLabel = new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric', timeZone: tz }).format(new Date(graph.event.date));
    return { graph, next, tminus, fmtT, counts, dayLabel, tz };
  }, [data]);

  return (
    <div className="app">
      <header className="board-header" aria-label="כותרת מגדל הפיקוד">
        <div>
          <div className="event">{data ? data.graph.event.name : '…'}</div>
          <div className="day">{header?.dayLabel ?? ''} · <span className="vlabel">{data?.profile.displayNameHe ?? ''}</span></div>
        </div>
        <div className="clock tnum" role="timer" aria-live="off" aria-label="השעה כעת">{clock}</div>
        {header?.next && (
          <div className="next">הבא: {header.next.name} · <span className="tnum">{header.tminus != null ? header.fmtT(header.tminus) : ''}</span></div>
        )}
        <div className="status-summary" aria-label="סיכום מצב" role="status" aria-live="polite">
          <span className={`light ok${header?.counts.ok === 0 ? ' quiet' : ''}`}><span className="dot" aria-hidden="true"></span>תקין {header?.counts.ok ?? 0}</span>
          <span className={`light risk${(header?.counts.risk ?? 0) === 0 ? ' quiet' : ''}`}><span className="dot" aria-hidden="true"></span>בסיכון {header?.counts.risk ?? 0}</span>
          <span className={`light slip${(header?.counts.slip ?? 0) === 0 ? ' quiet' : ''}`}><span className="dot" aria-hidden="true"></span>חריג {header?.counts.slip ?? 0}</span>
          <span className={`light off${(header?.counts.off ?? 0) === 0 ? ' quiet' : ''}`}><span className="dot" aria-hidden="true"></span>הושלם {header?.counts.off ?? 0}</span>
        </div>
      </header>
      <nav className="navbar" aria-label="ניווט ראשי">
        {VIEWS.map((v) => (
          <button key={v.key} className="nav-tab" aria-current={view === v.key ? 'page' : undefined} onClick={() => setView(v.key)}>
            {v.label}
            {v.key === 'approvals' && pendingCount > 0 ? <span className="cnt alert">{pendingCount}</span> : null}
          </button>
        ))}
      </nav>
      <div className="session-bar">
        <label>פרופיל
          <select value={profileId} onChange={(e) => setProfile(e.target.value)} aria-label="בחירת פרופיל תחום">
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.displayNameHe}</option>)}
          </select>
        </label>
        <label>תפקיד
          <select value={role} onChange={(e) => setRole(e.target.value as typeof role)} aria-label="בחירת תפקיד צפייה">
            <option value="admin">מנהל-על</option>
            <option value="field_manager">מנהל שטח</option>
            <option value="focus_worker">עובד שטח</option>
          </select>
        </label>
        <span className="spacer" />
        <button className="btn ghost" onClick={() => setTheme(theme === 'day' ? 'night' : 'day')} aria-label={`מעבר למצב ${theme === 'day' ? 'לילה' : 'יום'}`} aria-pressed={theme === 'night'}>
          {theme === 'day' ? 'מצב לילה' : 'מצב יום'}
        </button>
        <a className="btn ghost" href={`./focus.html?profile=${profileId}`} aria-label="פתיחת אפליקציית פוקוס מוד בחלון חדש" target="_blank" rel="noreferrer">פוקוס מוד ↗</a>
      </div>
      <main id="main" className="container">
        {view === 'tower' && <TowerView />}
        {view === 'builder' && <BuilderView />}
        {view === 'approvals' && <ApprovalsView />}
        {view === 'incidents' && <IncidentsView />}
        {view === 'sync' && <SyncView />}
      </main>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

export default function App() {
  return <QueryClientProvider client={qc}><Shell /></QueryClientProvider>;
}