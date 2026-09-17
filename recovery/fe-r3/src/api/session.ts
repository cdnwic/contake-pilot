/** Pilot session (plan §3zav item 1): the OTP verify response {token, principal} IS
 *  the session — it replaces the M-era dev auto-auth. Persisted in localStorage so a
 *  reload keeps the user signed in; every live REST call and the realtime socket run
 *  with this exact identity (server computes rooms/RBAC from the token).
 *  Expiry/401: the session is cleared and the app returns to login — no silent
 *  re-auth, no dev credentials in app code.
 *  Mock mode NEVER touches this module: the mock harness stays pass-through and all
 *  QA E2E hooks (?api=live, ?offline=1, ?seedqueue=N, ?nort=1, localStorage flags)
 *  behave exactly as before. */
import type { Principal } from '../contracts/contake-core-contracts.v1.1';

export interface AuthSession { token: string; principal: Principal }

const KEY = 'contake-session-v1';

/** Live-mode selector — the SAME rule client.ts dispatches on. */
export function isLiveMode(): boolean {
  return new URLSearchParams(window.location.search).get('api') === 'live'
    || localStorage.getItem('contake-api') === 'live';
}

export function loadSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<AuthSession>;
    if (typeof s?.token !== 'string' || !s.token || !s.principal?.userId || !s.principal?.role) return null;
    return { token: s.token, principal: s.principal as Principal };
  } catch { return null; }
}

export function saveSession(s: AuthSession): void {
  localStorage.setItem(KEY, JSON.stringify({ token: s.token, principal: s.principal }));
}

export function clearSession(): void {
  localStorage.removeItem(KEY);
}

/** Login URL for an unauthenticated live user — preserves ?api=live and ?theme=. */
export function loginUrl(): string {
  const q = new URLSearchParams(window.location.search);
  const next = new URLSearchParams();
  if (isLiveMode()) next.set('api', 'live');
  const theme = q.get('theme');
  if (theme === 'night' || theme === 'day') next.set('theme', theme);
  const qs = next.toString();
  return './login.html' + (qs ? `?${qs}` : '');
}

export function redirectToLogin(): void {
  window.location.href = loginUrl();
}

/** Expiry/401 anywhere in the live app: drop the dead session, return to login. */
export function handleAuthExpired(): void {
  clearSession();
  redirectToLogin();
}