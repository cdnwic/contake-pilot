import React, { useEffect, useRef, useState } from 'react';
import { sound, soundsMuted, setSoundsMuted } from './sound';
import { pushPermission, pushSupported, subscribePush } from './live/push';
import { isLiveMode } from './live/session';

/* ---------- icons (SVG, never emoji, per DESIGN.md §5) ---------- */
export const Logo = ({ size = 34 }: { size?: number }) => (
  <svg className="mark" width={size} height={size} viewBox="0 0 40 40" aria-label="Contake" role="img">
    <path d="M28 10a12 12 0 1 0 4 9" fill="none" stroke="#C2500F" strokeWidth="5" strokeLinecap="round" />
    <path d="M32 19c3 1 5 3 6 6-3-1-6-1-8 1 1-3 1-5 2-7z" fill="#C2500F" />
  </svg>
);
const I = ({ d, size = 20 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
export const IconBell = () => <I size={22} d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9 M13.7 21a2 2 0 0 1-3.4 0" />;
export const IconTower = () => <I d="M4 21V10l6-6 6 6v11 M4 21h16 M10 21v-6h4v6" />;
export const IconCheck = () => <I d="M20 6 9 17l-5-5" />;
export const IconEdit = () => <I d="M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />;
export const IconWrench = () => <I d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />;
export const IconMore = () => <I d="M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z M19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z M5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" />;
export const IconSync = () => <I d="M21 12a9 9 0 1 1-2.64-6.36 M21 3v6h-6" />;
export const IconGear = () => <I d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />;
export const IconMoon = () => <I d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" />;
export const IconGrid = () => <I d="M3 3h7v7H3z M14 3h7v7h-7z M14 14h7v7h-7z M3 14h7v7H3z" />;
export const IconEye = () => <I d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />;
export const IconFocus = () => <I d="M12 3v3 M12 18v3 M3 12h3 M18 12h3 M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />;
export const IconSound = () => <I d="M11 5 6 9H2v6h4l5 4V5Z M15.54 8.46a5 5 0 0 1 0 7.07" />;
export const IconChev = () => <I size={16} d="M15 18l-6-6 6-6" />;

/* ---------- clock ---------- */
export function useClock(): string {
  const [now, setNow] = useState('');
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setNow(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/* ---------- toast ---------- */
let toastSeq = 0;
export function useToast() {
  const [toast, setToast] = useState<{ id: number; msg: string } | null>(null);
  const show = (msg: string) => setToast({ id: ++toastSeq, msg });
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);
  return { toast, show };
}
export const ToastView = ({ toast }: { toast: { id: number; msg: string } | null }) =>
  toast ? <div className="toast" role="status" key={toast.id}>{toast.msg}</div> : null;

/* ---------- app bar ---------- */
export const AppBar = ({ title, sub, badge, onBell }: { title: string; sub: string; badge?: number; onBell: () => void }) => {
  const clock = useClock();
  return (
    <header className="appbar">
      <Logo />
      <div className="who">
        <div className="event-name">{title}</div>
        <div className="event-sub"><span className="vdot" /> {sub}</div>
      </div>
      <div className="clock mono">{clock}</div>
      <button className="bell" aria-label={badge ? `מרכז עדכונים, ${badge} ממתינים` : 'מרכז עדכונים'} onClick={onBell}>
        <IconBell />
        {badge ? <span className="badge">{badge}</span> : null}
      </button>
    </header>
  );
};

/* ---------- bottom tab bar ---------- */
export type TabId = 'tower' | 'approvals' | 'incidents' | 'builder' | 'more';
export const TabBar = ({ active, approvalsCount, onSelect }: { active: TabId; approvalsCount: number; onSelect: (t: TabId) => void }) => {
  const tabs: { id: TabId; label: string; icon: React.ReactNode; badge?: number }[] = [
    { id: 'tower', label: 'מגדל', icon: <IconTower /> },
    { id: 'approvals', label: 'אישורים', icon: <IconCheck />, badge: approvalsCount || undefined },
    { id: 'incidents', label: 'דיווחים', icon: <IconEdit /> },
    { id: 'builder', label: 'בונה', icon: <IconWrench /> },
    { id: 'more', label: 'עוד', icon: <IconMore /> },
  ];
  return (
    <nav className="tabbar" aria-label="ניווט ראשי">
      {tabs.map((t) => (
        <button key={t.id} className="tab" aria-selected={active === t.id} onClick={() => onSelect(t.id)}>
          {t.icon}{t.label}
          {t.badge ? <span className="badge">{t.badge}</span> : null}
        </button>
      ))}
    </nav>
  );
};

/* ---------- toggle ---------- */
export const Toggle = ({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) => (
  <button className="toggle" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />
);

/* ---------- עוד sheet ---------- */
export const MoreSheet = ({ open, onClose, theme, onTheme, onNav }: {
  open: boolean; onClose: () => void;
  theme: 'day' | 'night'; onTheme: (t: 'day' | 'night') => void;
  onNav: (what: string) => void;
}) => {
  const [muted, setMuted] = useState(soundsMuted());
  const [closing, setClosing] = useState(false);
  const dragY = useRef<number | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (open) setClosing(false); }, [open]);
  if (!open) return null;

  const close = () => {
    setClosing(true);
    setTimeout(onClose, 300);
  };
  const onPointerDown = (e: React.PointerEvent) => { dragY.current = e.clientY; };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragY.current == null || !sheetRef.current) return;
    const dy = e.clientY - dragY.current;
    if (dy > 0) sheetRef.current.style.transform = `translateY(${dy}px)`;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (dragY.current == null || !sheetRef.current) return;
    const dy = e.clientY - dragY.current;
    dragY.current = null;
    sheetRef.current.style.transform = '';
    if (dy > 80) close();
  };

  const Row = ({ icon, label, sub, trailing, onClick }: { icon: React.ReactNode; label: string; sub?: string; trailing?: React.ReactNode; onClick?: () => void }) => (
    <button className="sheet-row" onClick={onClick}>
      {icon}
      <span className="lbl">{label}{sub ? <div className="sub">{sub}</div> : null}</span>
      {trailing ?? <span className="chev"><IconChev /></span>}
    </button>
  );

  return (
    <>
      <div className="scrim" onClick={close} />
      <div
        ref={sheetRef}
        className={`sheet${closing ? ' closing' : ''}`}
        role="dialog" aria-modal="true" aria-label="עוד"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      >
        <div className="grab" />
        <h2>עוד</h2>
        <Row icon={<IconSync />} label="סנכרון בעלי עניין" sub="שידור שינויים לצוות, ספקים והורים" onClick={() => onNav('sync')} />
        <Row icon={<IconGear />} label="הגדרות" onClick={() => onNav('settings')} />
        <Row icon={<IconMoon />} label="מצב לילה" trailing={<Toggle checked={theme === 'night'} onChange={(v) => onTheme(v ? 'night' : 'day')} label="מצב לילה" />} onClick={() => onTheme(theme === 'night' ? 'day' : 'night')} />
        <Row icon={<IconSound />} label="צלילים" trailing={<Toggle checked={!muted} onChange={(v) => { setMuted(!v); setSoundsMuted(!v); if (v) sound('notify_info'); }} label="צלילים" />} onClick={() => { const nm = !muted; setMuted(nm); setSoundsMuted(nm); if (!nm) sound('notify_info'); }} />
        <Row icon={<IconGrid />} label="פרופיל תחום" sub="קייטנה" onClick={() => onNav('profile')} />
        <Row icon={<IconEye />} label="תפקיד צפייה" sub="מנהל-על" onClick={() => onNav('role')} />
        <Row icon={<IconFocus />} label="פוקוס מוד" sub="מסך עובד שטח — נפתח בלשונית חדשה" onClick={() => onNav('focus')} />
      </div>
    </>
  );
};

/* ---------- one-time push opt-in sheet (DESIGN.md §5: never inline) ---------- */
const PUSH_KEY = 'contake-push-optin-v2';
export const PushOptInSheet = ({ open, onDone }: { open: boolean; onDone: () => void }) => {
  if (!open) return null;
  const dismiss = (persist: boolean) => {
    if (persist) { try { localStorage.setItem(PUSH_KEY, 'dismissed'); } catch { /* */ } }
    onDone();
  };
  return (
    <>
      <div className="scrim" onClick={() => dismiss(true)} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label="התראות">
        <div className="grab" />
        <h2>קבל עדכונים גם כשהאפליקציה סגורה</h2>
        <p style={{ color: 'var(--ink-soft)', fontSize: 'var(--text-dense)', marginBottom: 'var(--space-3)' }}>
          נשלח התראה כשמשימה שלך זזה, מתבטלת או מחכה לאישור שלך — גם כשהחלון סגור.
        </p>
        <div className="actions" style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button className="btn primary" style={{ flex: 1 }} onClick={() => {
            sound('approved');
            if (isLiveMode() && pushSupported()) { subscribePush().catch(() => { /* permission denied or SW failure: stay dismissed */ }); }
            dismiss(true);
          }}>הפעל התראות</button>
          <button className="btn ghost" style={{ flex: 1 }} onClick={() => dismiss(true)}>לא עכשיו</button>
        </div>
      </div>
    </>
  );
};
export const pushOptInNeeded = (): boolean => {
  try {
    if (localStorage.getItem(PUSH_KEY) === 'dismissed') return false;
  } catch { return false; }
  if (isLiveMode()) return pushSupported() && pushPermission() === 'default';
  return true; // mock mode: sheet behavior unchanged (RC mock default)
};
/** REWRITE-ADD (r3): sprite-icon component required by Focus.tsx (recovered without it — era skew).
 *  Path data follows the lucide icon set (map-pin / backpack / clock / check) matching Focus usage ids. */
const ICO_PATHS: Record<string, string> = {
  'i-pin': 'M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 1 1 16 0Z M12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  'i-gear-bag': 'M4 20V10a8 8 0 0 1 16 0v10 M9 20v-6a3 3 0 0 1 6 0v6 M8 4.5V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v.5',
  'i-clock': 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z M12 6v6l4 2',
  'i-check': 'M20 6 9 17l-5-5',
};
export const Ico = ({ id, size = 16 }: { id: string; size?: number }) => <I size={size} d={ICO_PATHS[id] ?? ''} />;
