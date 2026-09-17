/** FE pkg-v11-2 liveApi module (hermetic fixture): REAL fetch client against the
 *  recovered backend. Session token from session.ts; no session ->
 *  AUTH_REQUIRED + login redirect (zero server calls); 401 -> session
 *  cleared + AUTH_EXPIRED + login redirect. */
import { loadSession, clearSession } from './session.js';

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const base = (): string =>
  ((globalThis as any).localStorage?.getItem('contake-api-url') as string) ??
  (globalThis as any).location?.origin ?? '';

const redirectToLogin = (): void => {
  const w = (globalThis as any).window;
  if (w?.location) w.location.href = 'login.html?api=live';
};

async function apiFetch(path: string, opts: { method?: string; body?: unknown } = {}): Promise<any> {
  const sess = loadSession();
  if (!sess) {
    redirectToLogin();
    throw new ApiError('AUTH_REQUIRED', 401, 'no session');
  }
  const res = await fetch(base() + path, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${sess.token}` },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (res.status === 401) {
    clearSession();
    redirectToLogin();
    throw new ApiError('AUTH_EXPIRED', 401, 'session expired');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError((data as any).code ?? `HTTP_${res.status}`, res.status, (data as any).message ?? res.statusText);
  }
  return data;
}

export async function getProfiles(): Promise<any[]> {
  const r = await apiFetch('/v1/profiles');
  return r.profiles ?? r;
}

export async function getClientState(profileId: string, role: string): Promise<any> {
  const pr = await apiFetch('/v1/profiles');
  const profiles: any[] = pr.profiles ?? pr;
  const profile = profiles.find((p) => p.id === profileId) ?? { id: profileId };
  const er = await apiFetch('/v1/events');
  const events: any[] = er.events ?? er;
  const event = events[0];
  const gr = await apiFetch(`/v1/events/${event.id}/graph`);
  const graph = gr.graph ?? gr;
  return { profile, role, event, graph };
}

export async function computePreview(profileId: string, change: unknown): Promise<any> {
  return apiFetch('/v1/domino/compute', { method: 'POST', body: change });
}

export async function submitReport(profileId: string, report: unknown, idem: unknown): Promise<any> {
  return apiFetch('/v1/reports', { method: 'POST', body: report });
}
