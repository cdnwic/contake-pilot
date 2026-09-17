/** Focus Mode (§6.6) — separate app: full-bleed card, 56px clock, exactly two 64px actions.
 *  Fixture: the focus worker's own minimized graph via the same adapter (mock default, ?api=live for M1.1). */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../fonts.css';
import '../tokens.css';
import '../styles.css';
import * as api from '../api/client';
import { fmtTime } from '../ui';
import type { ClientState } from '../api/mockApi';

const params = new URLSearchParams(location.search);
const profileId = params.get('profile') ?? 'camp';

type Stage =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'report' }
  | { kind: 'sent'; what: string }
  | { kind: 'error'; message: string };

const REASONS = [
  { id: 'delay', label: 'איחור', status: 'delayed' as const },
  { id: 'gear', label: 'תקלה בציוד', status: 'blocked' as const },
  { id: 'other', label: 'בעיה אחרת', status: 'blocked' as const },
];

function FocusApp() {
  const [state, setState] = useState<ClientState | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  const [reason, setReason] = useState<string | null>(null);
  const [delayMin, setDelayMin] = useState(15);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    api.getClientState(profileId, 'focus_worker')
      .then((s) => { setState(s); setStage({ kind: 'ready' }); })
      .catch((e) => setStage({ kind: 'error', message: e instanceof Error ? e.message : 'שגיאה' }));
  }, []);

  useEffect(() => { document.documentElement.dataset.vertical = profileId; }, []);

  if (stage.kind === 'error') return <div className="focus-app"><main className="focus-card"><p role="alert">שגיאה בטעינה: {stage.message}</p></main></div>;
  if (!state) return <div className="focus-app"><main className="focus-card"><p>טוען…</p></main></div>;

  const { graph, profile } = state;
  const tz = graph.event.timezone;
  const task = [...graph.tasks].sort((a, b) => Date.parse(a.start ?? '') - Date.parse(b.start ?? ''))[0];
  if (!task) return <div className="focus-app"><main className="focus-card"><p>אין משימה משובצת אליך כרגע.</p></main></div>;

  const place = task.assigneeResourceIds.map((id) => graph.resources.find((r) => r.id === id)).find((r) => r?.resourceKind === 'location')?.name;
  const people = task.assigneeResourceIds.map((id) => graph.resources.find((r) => r.id === id)).filter((r) => r?.resourceKind === 'person').map((r) => r!.name);
  const gear = task.assigneeResourceIds.map((id) => graph.resources.find((r) => r.id === id)).filter((r) => r?.resourceKind === 'equipment').map((r) => r!.name);

  const submit = async (status: 'on_track' | 'delayed' | 'blocked') => {
    setSending(true);
    try {
      const r = await api.submitReport(profileId, {
        taskId: task.id, status,
        delayMin: status === 'delayed' ? delayMin : undefined,
        noteHe: note || undefined,
        clientReportId: crypto.randomUUID(),
      }, api.principalFor(profileId, 'focus_worker'));
      setStage({ kind: 'sent', what: r.outcome === 'pending_review' ? 'הדיווח הועבר לאישור מנהל-על' : r.outcome === 'auto_applied' ? 'הדיווח נקלט והוחל' : 'הדיווח נקלט' });
    } catch (e) {
      setStage({ kind: 'error', message: e instanceof Error ? e.message : 'שגיאה בשליחה' });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="focus-app">
      <main className="focus-card">
        {stage.kind === 'sent' ? (
          <div className="focus-confirm" role="status">
            <h1>{stage.what}</h1>
            <p className="place">אפשר להמשיך — המגדל קיבל את הדיווח.</p>
            <button className="btn outline field" onClick={() => { setStage({ kind: 'ready' }); setNote(''); setReason(null); }} aria-label="חזרה למשימה">חזרה למשימה</button>
          </div>
        ) : stage.kind === 'report' ? (
          <>
            <div>
              <p className="focus-kicker">דיווח על בעיה · {task.name}</p>
              <h1>מה קרה?</h1>
            </div>
            <div className="focus-reasons" role="group" aria-label="סיבת הבעיה">
              {REASONS.map((r) => (
                <button key={r.id} type="button" className={`btn ${reason === r.id ? 'primary' : 'outline'} field`} aria-pressed={reason === r.id} onClick={() => setReason(r.id)}>{r.label}</button>
              ))}
            </div>
            {reason === 'delay' && (
              <div className="field"><label htmlFor="f-delay">בכמה דקות?</label>
                <input id="f-delay" type="number" min={5} step={5} value={delayMin} onChange={(e) => setDelayMin(Number(e.target.value))} dir="ltr" /></div>
            )}
            <div className="field"><label htmlFor="f-note">פירוט (אופציונלי)</label>
              <input id="f-note" dir="auto" value={note} onChange={(e) => setNote(e.target.value)} placeholder="למשל: האוטובוס תקוע בפקק" /></div>
            <div className="focus-actions">
              <button className="btn slip-solid field" disabled={!reason || sending} onClick={() => submit(reason === 'delay' ? 'delayed' : 'blocked')} aria-label="שליחת הדיווח למגדל הפיקוד">
                {sending ? 'שולח…' : 'שלח דיווח'}
              </button>
              <button className="btn ghost field" onClick={() => setStage({ kind: 'ready' })} aria-label="ביטול וחזרה">ביטול</button>
            </div>
          </>
        ) : (
          <>
            <div>
              <p className="focus-kicker">המשימה שלך עכשיו · {profile.displayNameHe}</p>
              <h1><bdi>{task.name}</bdi></h1>
              <p className="place">{[place, people.length ? `עם ${people.join(', ')}` : null].filter(Boolean).join(' · ')}</p>
            </div>
            <div className="fclock tnum" aria-label={`שעת תחילת המשימה ${fmtTime(task.start, tz)}`}>{fmtTime(task.start, tz)}</div>
            {gear.length > 0 && (
              <div className="gear" aria-label="ציוד נדרש">{gear.map((g) => <span className="g" key={g}>{g}</span>)}</div>
            )}
            <div className="focus-actions">
              <button className="btn outline field" disabled={sending} onClick={() => submit('on_track')} aria-label="דיווח שהכל תקין">הכל תקין</button>
              <button className="btn slip-solid field" onClick={() => setStage({ kind: 'report' })} aria-label="דיווח על בעיה במשימה">דווח על בעיה</button>
            </div>
          </>
        )}
      </main>
      <footer><a href={`./?profile=${profileId}#/tower`}>למגדל הפיקוד ←</a></footer>
    </div>
  );
}

document.documentElement.lang = 'he';
document.documentElement.dir = 'rtl';
createRoot(document.getElementById('root')!).render(<StrictMode><FocusApp /></StrictMode>);