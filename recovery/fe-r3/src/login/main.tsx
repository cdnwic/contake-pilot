/** Login (design v3-login) — brand lockup + OTP phone flow, day/night via ?theme=.
 *  REWRITE (r3): r2.1 verbatim entry + two authored fixes — normalized() helper restored
 *  (lost in era skew) and OTP verify persists the v2 session (contake-session-v1) with a
 *  role-based redirect (focus_worker → focus app), matching v2/live/session.ts contract.
 *  Mock default: the harness accepts any phone + any 6-digit code (fixtures only). */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../fonts.css';
import '../tokens.css';
import '../styles.css';
import { saveSession } from '../v2/live/session';
import type { Principal } from '../contracts/contracts.v1';

const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'night' ? 'night' : 'day';
const live = params.get('api') === 'live';
const apiBase = localStorage.getItem('contake-api-url') ?? '';

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(apiBase + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: { messageHe?: string } })?.error?.messageHe ?? `שגיאת שרת (${r.status})`);
  return d as T;
}

/** E.164 normalization for IL mobiles (REWRITE-ADD): 05X-XXXXXXX → +9725XXXXXXX. */
const normalized = (): string => {
  const d = phoneDigits.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d;
  return d.replace(/^0/, '+972');
};
let phoneDigits = '';

function Login() {
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, []);

  const sendCode = async () => {
    setError(null);
    if (!/^0\d{8,9}$/.test(phone.trim())) { setError('מספר טלפון לא תקין — פורמט 05X-XXXXXXX'); return; }
    setBusy(true);
    try {
      if (live) await post('/v1/auth/otp/request', { phone: phone.trim() });
      setStep('code');
    } catch (e) { setError(e instanceof Error ? e.message : 'שליחת הקוד נכשלה'); }
    finally { setBusy(false); }
  };
  const verify = async () => {
    setError(null);
    if (!/^\d{4,6}$/.test(code.trim())) { setError('הקוד לא תקין'); return; }
    setBusy(true);
    try {
      if (live) {
        phoneDigits = phone;
        const r = await post<{ token: string; principal: Principal }>('/v1/auth/otp/verify', { phone: normalized(), code: code.trim() });
        saveSession({ token: r.token, principal: r.principal });
        localStorage.setItem('contake-api', 'live');
        location.href = r.principal.role === 'focus_worker' ? './focus/?api=live' : './?api=live';
      } else location.href = './';
    } catch (e) { setError(e instanceof Error ? e.message : 'אימות הקוד נכשל'); setBusy(false); }
  };

  return (
    <main className="login-wrap">
      <div className="login-card">
        {/* REWRITE (r3): /brand/contake-mark-*.svg were never captured (era skew); inline mark
            from the recovered design-language Logo (components.tsx) + wordmark instead. */}
        <svg className="login-logo" viewBox="0 0 40 40" aria-label="Contake" role="img" style={{ width: 72, height: 72 }}>
          <path d="M28 10a12 12 0 1 0 4 9" fill="none" stroke="#C2500F" strokeWidth="5" strokeLinecap="round" />
          <path d="M32 19c3 1 5 3 6 6-3-1-6-1-8 1 1-3 1-5 2-7z" fill="#C2500F" />
        </svg>
        <div style={{ fontWeight: 700, fontSize: 28, marginTop: -8 }}>Contake</div>
        <h1 className="login-title">כניסה</h1>
        {step === 'phone' ? (
          <form className="login-form" onSubmit={(e) => { e.preventDefault(); void sendCode(); }}>
            <p className="login-sub">מספר הטלפון שלך ונשלח לך קוד כניסה</p>
            <input className="login-input tnum" type="tel" inputMode="tel" autoComplete="tel" placeholder="05X-XXXXXXX"
              aria-label="מספר טלפון" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <button className="btn primary login-submit" type="submit" disabled={busy}>{busy ? 'שולח…' : 'שלחו לי קוד'}</button>
            <p className="login-note">קוד חד-פעמי בוואטסאפ או במסרון</p>
          </form>
        ) : (
          <form className="login-form" onSubmit={(e) => { e.preventDefault(); void verify(); }}>
            <p className="login-sub">נשלח קוד כניסה למספר <span className="tnum" dir="ltr">{phone}</span></p>
            <input className="login-input tnum" type="text" inputMode="numeric" autoComplete="one-time-code" placeholder="קוד כניסה"
              aria-label="קוד כניסה" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
            <button className="btn primary login-submit" type="submit" disabled={busy}>{busy ? 'מאמת…' : 'כניסה'}</button>
            <button className="btn ghost" type="button" onClick={() => { setStep('phone'); setCode(''); setError(null); }}>חזרה</button>
          </form>
        )}
        {error && <p className="login-error" role="alert">{error}</p>}
        <footer className="login-footer">Contake</footer>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Login /></StrictMode>);
