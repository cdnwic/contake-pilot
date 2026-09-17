/** FE v13 push module (hermetic fixture): REAL push-subscription client.
 *  Uses the page's navigator.serviceWorker registration (stubbed in tests,
 *  real in the browser) and the backend /v1/push/* endpoints. Session token
 *  from session.ts; no session -> AUTH_REQUIRED. Module-level caches of the
 *  registration and subscription, resettable via resetPushCachesForTests. */
import { loadSession } from './session.js';

let cachedReg: any = null;
let cachedSub: any = null;

export function resetPushCachesForTests(): void {
  cachedReg = null;
  cachedSub = null;
}

class PushError extends Error {
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

const sessionToken = (): string => {
  const s = loadSession();
  if (!s) throw new PushError('AUTH_REQUIRED', 401, 'no session');
  return s.token;
};

const urlBase64ToUint8Array = (s: string): Uint8Array => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

const registration = async (): Promise<any> => {
  if (!cachedReg) {
    cachedReg = await (globalThis as any).navigator.serviceWorker.register('/sw.js');
  }
  return cachedReg;
};

export async function subscribePush(): Promise<string> {
  const token = sessionToken();
  const reg = await registration();
  const keyRes = await fetch(base() + '/v1/push/vapid-public-key', {
    headers: { authorization: `Bearer ${token}` },
  });
  const keyBody: any = await keyRes.json().catch(() => ({}));
  const publicKey: string = keyBody.publicKey ?? keyBody.key ?? '';
  cachedSub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  const subJson: any = typeof cachedSub.toJSON === 'function' ? cachedSub.toJSON() : {};
  const res = await fetch(base() + '/v1/push/subscriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      endpoint: cachedSub.endpoint,
      keys: subJson.keys ?? {},
      deviceClass: 'web',
    }),
  });
  if (!res.ok) {
    const d: any = await res.json().catch(() => ({}));
    throw new PushError(d.code ?? `HTTP_${res.status}`, res.status, d.message ?? res.statusText);
  }
  return cachedSub.endpoint as string;
}

export async function listSubscriptions(): Promise<Array<{ endpoint: string; keys: { p256dh: string; auth: string } }>> {
  const res = await fetch(base() + '/v1/push/subscriptions', {
    headers: { authorization: `Bearer ${sessionToken()}` },
  });
  const body: any = await res.json().catch(() => ({}));
  return body.subscriptions ?? [];
}

export async function unsubscribePush(): Promise<void> {
  const token = sessionToken();
  const reg = await registration();
  const sub = cachedSub ?? (await reg.pushManager.getSubscription());
  const endpoint: string | undefined = sub?.endpoint;
  if (sub && typeof sub.unsubscribe === 'function') await sub.unsubscribe();
  cachedSub = null;
  if (endpoint) {
    await fetch(base() + '/v1/push/subscriptions', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ endpoint }),
    });
  }
}
