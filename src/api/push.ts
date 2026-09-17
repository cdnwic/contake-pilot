/** Web push client (PR-4, contracts v1.10): VAPID subscribe/unsubscribe against the
 *  self-service routes, device list management, and the permission-explainer state
 *  machine. Live mode only — the mock harness never touches this module.
 *  The push endpoint+keys are operational secrets (contracts v1.10 §7.4): they go
 *  to the owner's own server routes only, never into frames, logs, or other users. */
import type { PushSubscription } from '../contracts/contake-core-contracts.v1.10';
import { apiFetch, apiBase } from './liveApi';
import { isLiveMode, loadSession } from './session';

const SW_PATH = '/sw-push.js';
const DISMISS_KEY = 'contake-push-dismissed-at';
const REOFFER_MS = 24 * 60 * 60 * 1000; // dismissed → re-offer at next login, max once/day (spec §5)

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

export function markPushDismissed(now = Date.now()): void {
  localStorage.setItem(DISMISS_KEY, String(now));
}

/** Explainer visibility (spec §5): live + supported + signed in + permission not yet
 *  decided, and not dismissed within the last day. Pure — unit-tested directly. */
export function shouldOfferPush(opts: {
  live: boolean; supported: boolean; signedIn: boolean;
  permission: 'default' | 'denied' | 'granted' | 'unsupported';
  dismissedAt: number | null; now: number;
}): boolean {
  if (!opts.live || !opts.supported || !opts.signedIn) return false;
  if (opts.permission !== 'default') return false;
  if (opts.dismissedAt !== null && opts.now - opts.dismissedAt < REOFFER_MS) return false;
  return true;
}

export function offerPushNow(): boolean {
  const raw = localStorage.getItem(DISMISS_KEY);
  return shouldOfferPush({
    live: isLiveMode(), supported: pushSupported(), signedIn: loadSession() !== null,
    permission: pushPermission(),
    dismissedAt: raw === null ? null : Number(raw), now: Date.now(),
  });
}

/** VAPID public key → applicationServerKey (spec §5/§7). */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

let vapidCache: Promise<string> | null = null;
export function getVapidPublicKey(): Promise<string> {
  if (!vapidCache) vapidCache = apiFetch<{ publicKey: string }>('/v1/push/vapid-public-key').then((r) => r.publicKey);
  return vapidCache;
}
/** Tests + session switches must not leak a key across identities. */
export function resetPushCachesForTests(): void { vapidCache = null; }

async function swRegistration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register(SW_PATH);
}

/** Mirror the context the SW needs for pushsubscriptionchange re-register (SWs
 *  cannot read localStorage). Best-effort: jsdom/older browsers skip silently. */
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

/** Subscribe this browser+device and upsert it server-side (idempotent on endpoint,
 *  AC-PUSH-1). Returns the endpoint for settings "this device" marking. */
export async function subscribePush(): Promise<string> {
  const reg = await swRegistration();
  const key = await getVapidPublicKey();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) as BufferSource });
  const keys = sub.toJSON().keys as { p256dh: string; auth: string };
  await apiFetch('/v1/push/subscriptions', {
    method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint, keys }),
  });
  await mirrorSwContext(key);
  return sub.endpoint;
}

/** Toggle OFF (spec §6): browser unsubscribe + server DELETE for this device. */
export async function unsubscribePush(): Promise<void> {
  const reg = await swRegistration();
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await sub.unsubscribe();
  await apiFetch('/v1/push/subscriptions', {
    method: 'DELETE', body: JSON.stringify({ endpoint: sub.endpoint }),
  });
}

export async function listSubscriptions(): Promise<PushSubscription[]> {
  const r = await apiFetch<{ subscriptions: PushSubscription[] }>('/v1/push/subscriptions');
  return r.subscriptions;
}

/** Per-device remove from the settings list (owner-only route; another user's
 *  endpoint is a server-side 403, never a client decision). */
export async function deleteSubscription(endpoint: string): Promise<void> {
  await apiFetch('/v1/push/subscriptions', { method: 'DELETE', body: JSON.stringify({ endpoint }) });
}

export async function currentEndpoint(): Promise<string | null> {
  try {
    const reg = await swRegistration();
    return (await reg.pushManager.getSubscription())?.endpoint ?? null;
  } catch { return null; }
}

/** SW → page messages: re-register after pushsubscriptionchange (permission already
 *  granted here), deep-link navigation is handled by the apps themselves. */
export function listenForSwMessages(onResubscribe: () => void): () => void {
  if (!pushSupported()) return () => {};
  const h = (e: MessageEvent) => {
    if ((e.data as { type?: string })?.type === 'push-resubscribe' && pushPermission() === 'granted') onResubscribe();
  };
  navigator.serviceWorker.addEventListener('message', h);
  return () => navigator.serviceWorker.removeEventListener('message', h);
}