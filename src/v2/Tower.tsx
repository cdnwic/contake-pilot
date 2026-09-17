import React, { useEffect, useMemo, useState } from 'react';
import { sound } from './sound';
import {
  AppBar, TabBar, TabId, MoreSheet, PushOptInSheet, pushOptInNeeded,
  ToastView, useToast, Toggle,
} from './components';
import {
  EVENT, STATUS_COUNTS, NEXT_UP, FEED, SCHEDULE, CHANGES,
  BUILDER_SITES, BUILDER_RESOURCES, ChangeRequest,
} from './mock';
import { useChangeActions, useTowerData } from './live/towerData';

type Theme = 'day' | 'night';
const initTheme = (): Theme => {
  const q = new URLSearchParams(location.search).get('theme');
  if (q === 'night' || q === 'day') return q;
  try { return (localStorage.getItem('contake-theme') as Theme) || 'day'; } catch { return 'day'; }
};

export default function Tower() {
  const [theme, setTheme] = useState<Theme>(initTheme);
  const [tab, setTab] = useState<TabId>('tower');
  const [moreOpen, setMoreOpen] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const { toast, show } = useToast();
  const { vm, loading: vmLoading, live } = useTowerData();
  const changeActions = useChangeActions();

  const [feedFilter, setFeedFilter] = useState<string>('all');
  const [changes, setChanges] = useState<ChangeRequest[]>(CHANGES);
  const [settling, setSettling] = useState<Record<string, boolean>>({});
  const [reasonOpen, setReasonOpen] = useState<Record<string, boolean>>({});
  const [apprFilter, setApprFilter] = useState<string>('all');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.vertical = vm.event.vertical;
    try { localStorage.setItem('contake-theme', theme); } catch { /* */ }
  }, [theme]);
  useEffect(() => { const t = setTimeout(() => setLoading(false), 700); return () => clearTimeout(t); }, []);
  useEffect(() => { setChanges(vm.changes); }, [vm.changes]);

  const settle = (id: string, msg: string, snd: 'approved' | 'domino_warning') => {
    sound(snd);
    show(msg);
    setSettling((s) => ({ ...s, [id]: true }));
    setTimeout(() => setChanges((cs) => cs.filter((c) => c.id !== id)), 260);
  };
  const pendingCount = changes.filter((c) => !c.stale).length;

  const onBell = () => { sound('notify_info'); show('מרכז העדכונים — בקרוב'); };
  const onTab = (t: TabId) => { if (t === 'more') { setMoreOpen(true); return; } setTab(t); };
  const onMoreNav = (what: string) => {
    setMoreOpen(false);
    if (what === 'focus') { window.open(`./fieldboard-focus.html?theme=${theme}`, '_blank'); return; }
    const msgs: Record<string, string> = {
      sync: 'סנכרון בעלי עניין — מסך נפרד בשלב 3',
      settings: 'הגדרות — מסך נפרד בשלב 3',
      profile: 'החלפת פרופיל תחום — בשלב 3 (כרגע: קייטנה)',
      role: 'החלפת תפקיד צפייה — בשלב 3 (כרגע: מנהל-על)',
    };
    sound('notify_info'); show(msgs[what] ?? what);
  };

  const firstReportDone = () => { if (pushOptInNeeded()) setPushOpen(true); };

  return (
    <>
      <AppBar
        title={tab === 'approvals' ? `אישורים — ${vm.event.name.split('—')[0].trim()}` : tab === 'builder' ? `בונה אירוע — ${vm.event.name.split('—')[0].trim()}` : vm.event.name}
        sub={tab === 'approvals' ? `${pendingCount} ממתינים · קייטנת אורנים` : vm.event.sub}
        badge={1}
        onBell={onBell}
      />

      {tab === 'tower' && (
        <TowerPane loading={loading || vmLoading} filter={feedFilter} onFilter={setFeedFilter} onApproveCard={(msg) => { sound('approved'); show(msg); }}
          counts={vm.statusCounts} nextUp={vm.nextUp ?? NEXT_UP} feed={vm.feed} schedule={vm.schedule} />
      )}
      {tab === 'approvals' && (
        <ApprovalsPane
          changes={changes} settling={settling} reasonOpen={reasonOpen}
          filter={apprFilter} onFilter={setApprFilter}
          onApprove={(id) => { const cr = changes.find((c) => c.id === id); if (live && cr) changeActions.approve.mutate({ id, baseVersion: cr.baseVersion }); settle(id, 'אושר — השינוי נכנס לגרף ועודכנו בעלי העניין ✓', 'approved'); }}
          onToggleReason={(id) => setReasonOpen((r) => ({ ...r, [id]: !r[id] }))}
          onReject={(id) => { setReasonOpen((r) => ({ ...r, [id]: false })); if (live) changeActions.reject.mutate({ id }); settle(id, 'נדחה — הנימוק נשלח למציע', 'domino_warning'); }}
        />
      )}
      {tab === 'incidents' && <IncidentsPane onFirstReport={firstReportDone} show={show} schedule={vm.schedule} />}
      {tab === 'builder' && <BuilderPane show={show} sites={vm.builderSites} resources={vm.builderResources} />}

      <TabBar active={tab} approvalsCount={pendingCount} onSelect={onTab} />
      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} theme={theme} onTheme={setTheme} onNav={onMoreNav} />
      <PushOptInSheet open={pushOpen} onDone={() => setPushOpen(false)} />
      <ToastView toast={toast} />
    </>
  );
}

/* ================= tower pane ================= */
function TowerPane({ loading, filter, onFilter, onApproveCard, counts, nextUp, feed, schedule }: {
  loading: boolean; filter: string; onFilter: (f: string) => void;
  onApproveCard: (msg: string) => void;
  counts: typeof STATUS_COUNTS; nextUp: typeof NEXT_UP; feed: typeof FEED;
  schedule: { time: string; name: string; status: string }[];
}) {
  const chips = [
    { id: 'all', label: 'הכל' },
    { id: 'slip', label: `חריג · ${counts.slip}`, dot: 'slip' },
    { id: 'risk', label: `בסיכון · ${counts.risk}`, dot: 'risk' },
    { id: 'ok', label: `תקין · ${counts.ok}`, dot: 'ok' },
    { id: 'done', label: `הושלם · ${counts.done}`, dot: 'off' },
  ];
  const items = feed.filter((f) => filter === 'all' || f.status === filter || (filter === 'done' && false));

  return (
    <div className="stage">
      <section className="nextup" aria-label="המשימה הבאה" style={{ ['--progress' as string]: `${nextUp.progress}%` }}>
        <div className="label">{nextUp.label}</div>
        <div className="task">{nextUp.task}</div>
        <div className="meta">
          <span className="tminus mono">{nextUp.tminus}</span>
          <span className="when">יציאה <span className="mono">07:30</span> · נועה כהן</span>
        </div>
      </section>

      <div className="ribbon-wrap"><div className="ribbon" role="group" aria-label="סינון לפי סטטוס">
        {chips.map((c) => (
          <button key={c.id} className="chip" aria-pressed={filter === c.id} onClick={() => onFilter(c.id)}>
            {c.dot ? <span className={`dot ${c.dot}`} /> : null}{c.label}
          </button>
        ))}
      </div></div>

      <main className="feed" id="main">
        {loading ? (<><div className="skel" /><div className="skel" /><div className="skel" /></>) : (
          <>
            <div className="section-label">דורש טיפול</div>
            {items.length === 0 && (
              <div className="empty">
                <div className="big-ink">אין פריטים בסינון הזה</div>
                <p>כשמשימה תחרוג או תיכנס לסיכון היא תקפוץ לכאן.</p>
              </div>
            )}
            {items.map((f) => (
              <article className="card" key={f.id}>
                <span className={`flag ${f.flag}`}>{f.flagLabel}</span>
                <h3>{f.title}</h3>
                <p className="detail">{f.detail}</p>
                {f.action && (
                  <div className="actions">
                    <button className={`btn ${f.action.kind}`} onClick={() => onApproveCard(f.action!.kind === 'primary' ? 'אושר — הבאסים קיבלו עדכון ✓' : 'נשלח')}>{f.action.label}</button>
                  </div>
                )}
              </article>
            ))}

            <div className="section-label">לוח זמנים · היום</div>
            <div className="rows">
              {schedule.map((r) => (
                <div className="row" key={r.time}>
                  <span className="time mono">{r.time}</span>
                  <span className="name">{r.name}</span>
                  <span className="st" style={{ background: `var(--status-${r.status === 'off' ? 'off' : r.status})` }} />
                </div>
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

/* ================= approvals pane ================= */
function ApprovalsPane({ changes, settling, reasonOpen, filter, onFilter, onApprove, onToggleReason, onReject }: {
  changes: ChangeRequest[]; settling: Record<string, boolean>; reasonOpen: Record<string, boolean>;
  filter: string; onFilter: (f: string) => void;
  onApprove: (id: string) => void; onToggleReason: (id: string) => void; onReject: (id: string) => void;
}) {
  const counts = useMemo(() => ({
    all: changes.length,
    tasks: changes.filter((c) => c.typeKind === 'tasks').length,
    resources: changes.filter((c) => c.typeKind === 'resources').length,
    deps: changes.filter((c) => c.typeKind === 'deps').length,
    publish: changes.filter((c) => c.typeKind === 'publish').length,
  }), [changes]);
  const visible = changes.filter((c) => filter === 'all' || c.typeKind === filter);

  return (
    <>
      <div className="ribbon-wrap"><div className="ribbon" role="group" aria-label="סינון אישורים">
        {[['all', 'הכל'], ['tasks', 'משימות'], ['resources', 'משאבים'], ['deps', 'תלויות'], ['publish', 'פרסום']].map(([id, label]) => (
          <button key={id} className="chip" aria-pressed={filter === id} onClick={() => onFilter(id)}>
            {label} · {(counts as Record<string, number>)[id]}
          </button>
        ))}
      </div></div>

      <main className="feed">
        {visible.length > 0 && <div className="section-label">ממתין להחלטה שלך</div>}
        {visible.map((c) => (
          <article
            className={`card${c.stale ? ' stale' : ''}`} key={c.id}
            style={settling[c.id] ? { transition: 'opacity .24s var(--ease-out), transform .24s var(--ease-out)', opacity: 0, transform: 'translateY(-8px) scale(.98)' } : undefined}
          >
            <div className="topline">
              <span className={`flag ${c.stale ? 'stale' : 'approve'}`}>{c.typeFlag}</span>
              <span className="who">{c.who} · {c.role} · <span className="mono">{c.when}</span></span>
            </div>
            <h3>{c.title}</h3>
            <div className="diff">
              {c.diff.map((d, i) => (
                <div className="drow" key={i}>
                  <span className="k">{d.k}</span>
                  <span className="v">
                    {d.old ? <><span className="old">{d.old}</span> ← <span className="new">{d.neu}</span></> : (d.mono ? <span className="mono">{d.plain}</span> : d.plain)}
                  </span>
                </div>
              ))}
            </div>
            {c.domino.summary && (
              <details className={`domino${c.domino.none ? ' none' : ''}`} open={c.domino.none}>
                <summary>{c.domino.summary}</summary>
                {c.domino.items && <ul>{c.domino.items.map((it, i) => <li key={i}>{it}</li>)}</ul>}
              </details>
            )}
            {c.stale ? (
              <div className="ver bad">גרסת בסיס <span className="mono">{c.baseVersion}</span> ← הנוכחית <span className="mono">{c.currentVersion}</span> · נדרש רענון לפני החלטה</div>
            ) : (
              <div className="ver">גרסת בסיס <span className="mono">{c.baseVersion}</span> · עדכני</div>
            )}
            <div className="actions">
              <button className="btn primary" disabled={c.stale} onClick={() => onApprove(c.id)}>אישור</button>
              <button className="btn danger-quiet" disabled={c.stale} onClick={() => onToggleReason(c.id)}>דחייה</button>
            </div>
            {reasonOpen[c.id] && (
              <div className="reason open">
                <textarea placeholder="נימוק לדחייה (יוצג למציע)…" aria-label="נימוק דחייה" />
                <div className="actions" style={{ marginTop: 0 }}>
                  <button className="btn danger-quiet" onClick={() => onReject(c.id)}>שלח דחייה</button>
                  <button className="btn ghost" onClick={() => onToggleReason(c.id)}>ביטול</button>
                </div>
              </div>
            )}
          </article>
        ))}
        {visible.length === 0 && (
          <div className="empty">
            <div className="big-ink" style={{ fontSize: 44 }}>✓</div>
            <h2 style={{ fontSize: 'var(--text-title)' }}>הכל מאושר</h2>
            <p>אין החלטות ממתינות. אישורים חדשים יקפצו לכאן עם צליל נקישה.</p>
          </div>
        )}
      </main>
    </>
  );
}

/* ================= incidents pane (דיווחים) ================= */
function IncidentsPane({ onFirstReport, show, schedule }: { onFirstReport: () => void; show: (m: string) => void; schedule: { time: string; name: string; status: string }[] }) {
  const [task, setTask] = useState('');
  const [status, setStatus] = useState<'ok' | 'risk' | 'slip'>('ok');
  const [note, setNote] = useState('');
  const [reports, setReports] = useState<{ id: number; task: string; status: string; note: string; when: string }[]>([]);

  const submit = () => {
    if (!task) { sound('domino_warning'); show('בחר משימה לדיווח'); return; }
    const d = new Date();
    setReports((rs) => [{ id: Date.now(), task, status, note, when: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }, ...rs]);
    setNote('');
    sound(status === 'slip' ? 'critical' : 'task_done');
    show(status === 'slip' ? 'הדיווח נשלח — מסומן כחריג ומטופל' : 'הדיווח נשלח ✓');
    onFirstReport();
  };

  return (
    <main className="feed">
      <div className="section-label">דיווח שטח חדש · זמין גם מהאפליקציה בפוקוס מוד</div>
      <article className="card">
        <div className="field">
          <label htmlFor="rep-task">משימה</label>
          <select id="rep-task" value={task} onChange={(e) => setTask(e.target.value)}>
            <option value="">בחר משימה…</option>
            {schedule.map((r) => <option key={r.time} value={r.name}>{r.time} — {r.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>סטטוס</label>
          <div className="seg" role="group" aria-label="סטטוס דיווח">
            {([['ok', 'תקין'], ['risk', 'בסיכון'], ['slip', 'חריג']] as const).map(([id, label]) => (
              <button key={id} aria-selected={status === id} onClick={() => setStatus(id)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="field">
          <label htmlFor="rep-note">פירוט (אופציונלי)</label>
          <textarea id="rep-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="מה קורה בשטח?" />
        </div>
        <div className="actions">
          <button className="btn primary" onClick={submit}>שלח דיווח</button>
        </div>
      </article>

      {reports.length > 0 && <div className="section-label">דיווחים שנשלחו · היום</div>}
      {reports.map((r) => (
        <article className="card" key={r.id}>
          <span className={`flag ${r.status === 'slip' ? 'slip' : r.status === 'risk' ? 'risk' : 'approve'}`}>
            {r.status === 'slip' ? 'חריג' : r.status === 'risk' ? 'בסיכון' : 'תקין'}
          </span>
          <h3>{r.task}</h3>
          <p className="detail">{r.note || 'ללא פירוט'} · <span className="mono">{r.when}</span></p>
        </article>
      ))}
    </main>
  );
}

/* ================= builder pane ================= */
function BuilderPane({ show, sites, resources }: {
  show: (m: string) => void;
  sites: { label: string; tasks: { time: string; name: string; sub: string; durPct: number; lock?: boolean }[] }[];
  resources: { icon?: string; name: string; meta: string; excl: boolean }[];
}) {
  const [seg, setSeg] = useState<'tasks' | 'resources' | 'deps'>('tasks');
  const [sheet, setSheet] = useState<'' | 'task' | 'dup'>('');
  const [dur, setDur] = useState(45);
  const [locked, setLocked] = useState(false);
  const [assignees, setAssignees] = useState<Record<string, boolean>>({ 'נועה כהן': true });
  const [dupToggles, setDupToggles] = useState({ tasks: true, resources: true, deps: true });

  const close = () => setSheet('');

  return (
    <>
      <div className="stage builder-stage">
        <section className="meta card" aria-label="פרטי האירוע">
          <div className="row1">
            <span className="pill">יום שני · <span className="mono">14.9.26</span></span>
            <span className="pill">2 אתרים</span>
            <span className="pill">גרסת גרף <span className="mono">9</span></span>
            <span className="draft">טיוטה</span>
          </div>
          <div className="actions">
            <button className="btn ghost" onClick={() => setSheet('dup')}>שכפל יום…</button>
            <button className="btn dark" onClick={() => { sound('approval_request'); show('פרסום נשלח לאישור מנהל-על — event.publish'); }}>פרסם אירוע</button>
          </div>
        </section>

        <div className="seg" role="tablist" aria-label="חלקי האירוע">
          <button role="tab" aria-selected={seg === 'tasks'} onClick={() => setSeg('tasks')}>משימות <span className="cnt">5</span></button>
          <button role="tab" aria-selected={seg === 'resources'} onClick={() => setSeg('resources')}>משאבים <span className="cnt">4</span></button>
          <button role="tab" aria-selected={seg === 'deps'} onClick={() => setSeg('deps')}>תלויות <span className="cnt">2</span></button>
        </div>

        {seg === 'tasks' && (
          <>
            {sites.map((s) => (
              <React.Fragment key={s.label}>
                <div className="group-label">אתר: {s.label}</div>
                <div className="rows">
                  {s.tasks.map((t) => (
                    <button className="trow" key={t.time + t.name} onClick={() => setSheet('task')}>
                      <span className="time mono">{t.time}</span>
                      <span>
                        <span className="nm">{t.name}</span>
                        <span className="sub">{t.sub}</span>
                        <span className="dur"><i style={{ width: `${t.durPct}%` }} /></span>
                      </span>
                      <span className={`tag${t.lock ? ' lock' : ''}`}>{t.lock ? <LockIcon /> : null}</span>
                    </button>
                  ))}
                </div>
              </React.Fragment>
            ))}
          </>
        )}

        {seg === 'resources' && (
          <>
            <div className="group-label">משאבים משויכים לאירוע</div>
            <div className="rows">
              {resources.map((r) => (
                <div className="rrow" key={r.name}>
                  <span className="rk">{r.icon}</span>
                  <span className="nm">{r.name}</span>
                  {r.excl ? <span className="excl">בלעדי</span> : <span className="meta2">{r.meta}</span>}
                </div>
              ))}
            </div>
          </>
        )}

        {seg === 'deps' && (
          <>
            <div className="group-label">תלויות בין משימות (from → to · lag · hard)</div>
            <div className="rows">
              <div className="drow2"><span className="edge">הגעה מהבריכה<span className="arr">←</span>ארוחת צהריים</span><span className="lag mono">10 דק׳</span><span className="hardtag">קשיחה</span></div>
              <div className="drow2"><span className="edge">איסוף בוקר<span className="arr">←</span>הגעה והתארגנות</span><span className="lag mono">0</span><span className="hardtag soft">רכה</span></div>
            </div>
            <div className="group-label">מסלול יצירה: בחר משימת מקור ← בחר משימת יעד ← השהיה + קשיחה</div>
          </>
        )}
      </div>

      <div className="dock">
        <button className="fab" onClick={() => setSheet('task')}>＋ משימה חדשה</button>
      </div>

      {sheet !== '' && <div className="scrim" onClick={close} />}

      {sheet === 'task' && (
        <section className="sheet" role="dialog" aria-modal="true" aria-label="משימה חדשה">
          <div className="grab" />
          <h2>משימה חדשה</h2>
          <div className="field"><label>שם המשימה</label><input placeholder="למשל: בריכה — קבוצות א׳–ג׳" /></div>
          <div className="field"><label>אתר (siteId)</label><select><option>קייטנת אורנים — שטח</option><option>מתחם הבריכה</option></select></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
            <div className="field"><label>התחלה (start)</label><input defaultValue="10:30" className="mono" inputMode="numeric" /></div>
            <div className="field"><label>משך בדקות (durationMin)</label>
              <div className="stepper">
                <button aria-label="פחות" onClick={() => setDur((d) => Math.max(5, d - 5))}>−</button>
                <span className="val">{dur}</span>
                <button aria-label="עוד" onClick={() => setDur((d) => d + 5)}>＋</button>
              </div>
            </div>
          </div>
          <div className="switchrow">
            <span><span className="lbl">נעילה (locked)</span><br /><span className="desc">אילוץ קשיח — הדומינו לעולם לא יזיז</span></span>
            <Toggle checked={locked} onChange={setLocked} label="נעילה" />
          </div>
          <div className="field" style={{ marginTop: 'var(--space-2)' }}><label>משויכים (assigneeResourceIds)</label>
            <div className="chipsel">
              {['נועה כהן', 'אורן לוי', 'מדריך 3'].map((a) => (
                <button key={a} className="chip" aria-pressed={!!assignees[a]} onClick={() => setAssignees((s) => ({ ...s, [a]: !s[a] }))}>{a}</button>
              ))}
            </div>
          </div>
          <p className="hint">שמירה יוצרת בקשת שינוי (task.create) — נכנס לתור האישורים לפי ההרשאה שלך.</p>
          <div className="actions">
            <button className="btn primary" onClick={() => { close(); sound('approval_request'); show('נשלח לאישור — task.create · גרסת בסיס 9'); }}>שמירת משימה</button>
            <button className="btn ghost" onClick={close}>ביטול</button>
          </div>
        </section>
      )}

      {sheet === 'dup' && (
        <section className="sheet" role="dialog" aria-modal="true" aria-label="שכפול יום">
          <div className="grab" />
          <h2>שכפל יום</h2>
          <div className="field"><label>מקור</label><input defaultValue="יום שני · 14.9 — יום קייטנה מלא" disabled /></div>
          <div className="field"><label>לתאריך (date)</label><input defaultValue="15.9.2026" className="mono" inputMode="numeric" /></div>
          {([['tasks', 'משימות', '5 משימות · כולל שיבוצים'], ['resources', 'משאבים', '4 משאבים משויכים'], ['deps', 'תלויות', '2 קשרי תלות']] as const).map(([k, lbl, desc]) => (
            <div className="switchrow" key={k}>
              <span><span className="lbl">{lbl}</span><br /><span className="desc">{desc}</span></span>
              <Toggle checked={dupToggles[k]} onChange={(v) => setDupToggles((s) => ({ ...s, [k]: v }))} label={lbl} />
            </div>
          ))}
          <p className="hint" style={{ marginTop: 'var(--space-2)' }}>השכפול יוצר אירוע טיוטה חדש; פרסום ידרוש אישור נפרד.</p>
          <div className="actions">
            <button className="btn primary" onClick={() => { sound('approved'); show('היום שוכפל לטיוטה חדשה ✓'); close(); }}>שכפל יום</button>
            <button className="btn ghost" onClick={close}>ביטול</button>
          </div>
        </section>
      )}
    </>
  );
}

const LockIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);