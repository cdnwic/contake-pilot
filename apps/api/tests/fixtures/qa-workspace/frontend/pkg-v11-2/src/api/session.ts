/** FE v12 session module (hermetic fixture): localStorage-backed session store.
 *  Key: contake-session-v1. Garbage JSON / empty token / null principal -> null. */
export interface SessionPrincipal { userId: string; role: string; scopes?: unknown[]; }
export interface Session { token: string; principal: SessionPrincipal; }

const KEY = 'contake-session-v1';
const ls = (): Storage => (globalThis as any).localStorage;

export function saveSession(s: Session): void {
  ls().setItem(KEY, JSON.stringify({ token: s.token, principal: s.principal }));
}
export function loadSession(): Session | null {
  const raw = ls().getItem(KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Session;
    if (!p || typeof p !== 'object') return null;
    if (typeof p.token !== 'string' || p.token === '') return null;
    if (!p.principal || typeof p.principal !== 'object') return null;
    return p;
  } catch {
    return null;
  }
}
export function clearSession(): void {
  ls().removeItem(KEY);
}
