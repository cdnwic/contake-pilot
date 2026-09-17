/** Authenticated HTTP for the v2 live layer — behavior port of FE's liveApi http():
 *  every call carries the session token; 401 clears the session and bounces to
 *  login; server error envelopes surface {code, messageHe}. */
import { handleAuthExpired, loadSession, redirectToLogin, resolveApiBase } from './session';

export const apiBase = resolveApiBase;

export interface ApiError extends Error { code?: string; status?: number }

function sessionToken(): string {
  const s = loadSession();
  if (!s) {
    redirectToLogin();
    const err = new Error('נדרשת התחברות') as ApiError;
    err.code = 'AUTH_REQUIRED'; err.status = 401;
    throw err;
  }
  return s.token;
}

export async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(init?.headers as Record<string, string> ?? {}) };
  headers['authorization'] = `Bearer ${sessionToken()}`;
  const res = await fetch(`${apiBase()}${path}`, { ...init, headers });
  if (res.status === 401) {
    handleAuthExpired();
    const err = new Error('ההתחברות פגה — יש להתחבר מחדש') as ApiError;
    err.code = 'AUTH_EXPIRED'; err.status = 401;
    throw err;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = (body as { error?: { code?: string } }).error?.code ?? `HTTP_${res.status}`;
    const msg = (body as { error?: { messageHe?: string } }).error?.messageHe ?? code;
    const err = new Error(msg) as ApiError;
    err.code = code; err.status = res.status;
    throw err;
  }
  return body as T;
}