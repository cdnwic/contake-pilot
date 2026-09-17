/** Live session for the v2 entries — ported verbatim in behavior from FE's
 *  src/api/session.ts (v13.3): the OTP verify response {token, principal} IS the
 *  session, persisted in localStorage; every live REST call and the realtime socket
 *  run with this exact identity. 401/expiry clears and returns to FE's login page. */
import type { Principal } from '../../contracts/contracts.v1';

export interface AuthSession { token: string; principal: Principal }

const KEY = 'contake-session-v1';

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

/** API base resolution (FE rule, RT-PIN-2): QA/local override first
 *  (localStorage contake-api-url), then VITE_CONTAKE_API_URL, else page origin. */
export function resolveApiBase(): string {
  return localStorage.getItem('contake-api-url')
    ?? (import.meta.env['VITE_CONTAKE_API_URL'] as string | undefined)
    ?? '';
}

/** FE's login page — preserves ?api=live and ?theme=. */
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

export function handleAuthExpired(): void {
  clearSession();
  redirectToLogin();
}