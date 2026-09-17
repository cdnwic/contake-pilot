import React, { useEffect, useRef, useState } from 'react';
import { sound } from './sound';
import { Ico, PushOptInSheet, pushOptInNeeded, useToast } from './components';

type Theme = 'day' | 'night';

/** Focus Mode - field staff. One task, giant targets, zero noise (DESIGN.md §5).
 *  Isolated visual build: mock task; T-minus ticks live from mount. */
export default function Focus() {
  const [theme] = useState<Theme>(() => {
    const q = new URLSearchParams(location.search).get('theme');
    return q === 'night' ? 'night' : 'day';
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.vertical = 'camp';
  }, [theme]);

  // demo: current task starts 7:19 from mount; ticks down
  const [startAt] = useState(() => Date.now() + (7 * 60 + 19) * 1000);
  const [remain, setRemain] = useState(startAt - Date.now());
  const ticked = useRef(false);
  useEffect(() => {
    const id = setInterval(() => {
      const r = startAt - Date.now();
      setRemain(Math.max(0, r));
      if (!ticked.current && r <= 5 * 60 * 1000) { ticked.current = true; sound('reminder_tick'); }
    }, 1000);
    return () => clearInterval(id);
  }, [startAt]);
  const mm = Math.floor(remain / 60000);
  const ss = Math.floor((remain % 60000) / 1000);
  const tminus = `T-${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;

  const { toast, show } = useToast();
  const [reportOpen, setReportOpen] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);

  const allOk = () => {
    sound('task_done');
    show('דווח — הכל תקין ✓');
    if (pushOptInNeeded()) setTimeout(() => setPushOpen(true), 900);
  };
  const sendReport = (kind: string) => {
    setReportOpen(false);
    sound('approval_request');
    show(`דיווח נשלח — ${kind}`);
    if (pushOptInNeeded()) setTimeout(() => setPushOpen(true), 900);
  };

  return (
    <>
      <div className="top">
        <span>קייטנת אורנים · יום שני 14.9</span>
        <span className="live"><i /> מחובר</span>
      </div>

      <main className="hero">
        <div className="kicker">המשימה שלך עכשיו</div>
        <h1 className="task-name">איסוף בוקר — אוטובוס 1 (מסלול צפון)</h1>
        <div className="with">עם נועה כהן</div>
        <div className="count mono">{tminus}</div>
        <div className="chips">
          <span className="pill"><Ico id="i-pin" size={13} /> תחנת איסוף — צפון</span>
          <span className="pill"><Ico id="i-gear-bag" size={13} /> ציוד: דגל קבוצה, גופיות</span>
          <span className="pill"><Ico id="i-clock" size={13} /> יציאה <span className="mono">07:30</span></span>
        </div>
      </main>

      <div className="next">
        <span>הבא: <b>הגעה והתארגנות — רחבת הדגל</b></span>
        <span className="t mono">08:15</span>
      </div>

      <div className="actions">
        <button className="big ok" onClick={allOk}><Ico id="i-check" size={22} /> הכל תקין</button>
        <button className={`big problem${reportOpen ? ' armed' : ''}`} onClick={() => { sound('approval_request'); setReportOpen(true); }}>דווח על בעיה</button>
      </div>

      {reportOpen && (
        <>
          <div className="scrim" onClick={() => setReportOpen(false)} />
          <section className="sheet" role="dialog" aria-modal="true" aria-label="דיווח על בעיה">
            <div className="grab" />
            <h2>מה קורה?</h2>
            <div className="field">
              <div className="seg" role="group" aria-label="סוג דיווח">
                <button aria-selected="true">איחור</button>
                <button aria-selected="false" onClick={(e) => { (e.currentTarget.parentElement!.children as unknown as HTMLElement[]); }}>ציוד</button>
                <button aria-selected="false">אחר</button>
              </div>
            </div>
            <div className="field">
              <label htmlFor="focus-note">פירוט קצר</label>
              <textarea id="focus-note" placeholder="למשל: האוטובוס תקוע בפקק, איחור משוער 10 דקות" />
            </div>
            <div className="actions" style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <button className="btn primary" style={{ flex: 1 }} onClick={() => sendReport('איחור')}>שלח דיווח</button>
              <button className="btn ghost" style={{ flex: 1 }} onClick={() => setReportOpen(false)}>ביטול</button>
            </div>
          </section>
        </>
      )}

      <PushOptInSheet open={pushOpen} onDone={() => setPushOpen(false)} />
      {toast ? <div className="toast" role="status" key={toast.id}>{toast.msg}</div> : null}
    </>
  );
}