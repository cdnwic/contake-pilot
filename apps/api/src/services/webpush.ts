import type { PushSubscription } from '@contake/core';
import type { ProviderResult, PushPayload, WebPushProvider } from './dispatch.js';

/** Web push providers (contracts v1.10, web-push-spec §3/§7). Default is a
 *  log-only sandbox — nothing leaves the process without VAPID keys in env.
 *  The real provider wraps the `web-push` library (VAPID); mapped semantics:
 *  404/410 -> gone (dead subscription, dispatcher deletes it, never retried);
 *  429 -> retryable with Retry-After honored; 5xx -> retryable; anything else
 *  -> non-retryable (notifications spec v1.6: unknown codes fail loudly). */
export function createLogPushProvider(): WebPushProvider {
  return {
    name: 'web_push',
    send: (sub: PushSubscription, payload: PushPayload) => {
      console.log(`[web_push sandbox] -> ${sub.userId} (${sub.endpoint.slice(0, 48)}…): ${payload.title} / ${payload.body}`);
      return Promise.resolve({ ok: true, providerMessageId: `webpush-sandbox-${Date.now()}`, retryable: false });
    },
  };
}

export interface VapidConfig { publicKey: string; privateKey: string; subject: string }

export function vapidConfigFromEnv(): VapidConfig | undefined {
  const publicKey = process.env['VAPID_PUBLIC_KEY'];
  const privateKey = process.env['VAPID_PRIVATE_KEY'];
  if (!publicKey || !privateKey) return undefined;
  return { publicKey, privateKey, subject: process.env['VAPID_SUBJECT'] ?? 'mailto:ops@contake.app' };
}

interface WebPushLib {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
  ): Promise<unknown>;
}

/** Real VAPID provider. `web-push` is loaded lazily so the sandbox path (and
 *  any test env without the dependency installed) never pays for it. */
export function createVapidPushProvider(cfg: VapidConfig): WebPushProvider {
  let libPromise: Promise<WebPushLib> | undefined;
  const lib = (): Promise<WebPushLib> => {
    libPromise ??= import('web-push').then(m => {
      const wp = (m.default ?? m) as unknown as WebPushLib;
      wp.setVapidDetails(cfg.subject, cfg.publicKey, cfg.privateKey);
      return wp;
    });
    return libPromise;
  };
  return {
    name: 'web_push',
    send: async (sub: PushSubscription, payload: PushPayload): Promise<ProviderResult> => {
      try {
        const wp = await lib();
        await wp.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload));
        return { ok: true, retryable: false };
      } catch (e) {
        const err = e as { statusCode?: number; headers?: Record<string, string | undefined>; body?: string };
        const code = err.statusCode ?? 0;
        if (code === 404 || code === 410) return { ok: false, retryable: false, gone: true, error: `push subscription gone (${code})` };
        if (code === 429) {
          const ra = Number(err.headers?.['retry-after'] ?? 0);
          return { ok: false, retryable: true, error: 'push service throttled (429)', retryAfterMs: ra > 0 ? ra * 1000 : undefined };
        }
        if (code >= 500) return { ok: false, retryable: true, error: `push service error (${code})` };
        // Unknown / client-error codes: non-retryable per spec v1.6 (loud failure, no duplicate-send risk).
        return { ok: false, retryable: false, error: `push send failed (${code || 'unknown'}): ${err.body ?? ''}`.slice(0, 200) };
      }
    },
  };
}
