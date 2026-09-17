/** Web push for the v2 entries — trimmed port of FE's src/api/push.ts (PR-4):
 *  VAPID subscribe/unsubscribe against the self-service routes, SW context mirror
 *  for pushsubscriptionchange re-register. Opt-in UX stays per DESIGN.md: one-time
 *  sheet after the first successful report, dismissal persists (contake-push-optin-v2),
 *  no 24h re-offer — pending TL's ruling on the policy conflict. */
import { http, apiBase } from './http';
import { loadSession } from './session';

const SW_PATH = '/sw-push.js';

export function pushSupported(): boolean {
  return typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator
    && typeof window !== 'undefined'
    && 'PushManager' in window
    && 'Notification' in window;
}

export function pushPermission(): 'default' | 'denied' | 'granted' | 'unsupported' {
  return pushSupported() ? Notification.permission : 'unsupported';
}

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

let vapidCache: Promise<string> | null = null;
export function getVapidPublicKey(): Promise<string> {
  if (!vapidCache) vapidCache = http<{ publicKey: string }>('/v1/push/vapid-public-key').then((r) => r.publicKey);
  return vapidCache;
}

async function swRegistration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register(SW_PATH);
}

async function mirrorSwContext(vapidPublicKey: string): Promise<void> {
  try {
    if (typeof indexedDB === 'undefined') return;
    const s = loadSession();
    if (!s) return;
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('contake-push', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await new Promise<void>((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(s.token, 'token');
      tx.objectStore('kv').put(vapidPublicKey, 'vapidPublicKey');
      tx.objectStore('kv').put(apiBase(), 'apiBase');
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  } catch { /* re-register falls back to messaging open pages */ }
}

export async function subscribePush(): Promise<string> {
  const reg = await swRegistration();
  const key = await getVapidPublicKey();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
  const keys = sub.toJSON().keys as { p256dh: string; auth: string };
  await http('/v1/push/subscriptions', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint, keys }) });
  await mirrorSwContext(key);
  return sub.endpoint;
}

export async function unsubscribePush(): Promise<void> {
  const reg = await swRegistration();
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await sub.unsubscribe();
  await http('/v1/push/subscriptions', { method: 'DELETE', body: JSON.stringify({ endpoint: sub.endpoint }) });
}