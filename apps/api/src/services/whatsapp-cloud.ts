import type { MessageProvider } from './dispatch.js';

/** Meta WhatsApp Cloud API adapter (PR-2, TL ruling 2026-09-11): Meta-native so
 *  every BSP (360dialog, Twilio) stays a thin config/transport swap later — they
 *  all front the same Cloud API. CODE-ONLY and env-gated off: without env vars
 *  the server stays on the log-sandbox provider; secrets are env-only (QA-M3-4).
 *  SMS is PARKED (not built). Going live needs Chaim's deferred decisions
 *  (Meta business entity + Hebrew template approval) — free-form text only
 *  sends inside Meta's 24h customer-service window; production sends will use
 *  the approved template set with the same provider interface. */

export interface WhatsAppCloudConfig {
  accessToken: string;      // Meta system-user / app access token (secret)
  phoneNumberId: string;    // sender phone number id from Meta Business Manager
  apiBase?: string;         // default https://graph.facebook.com
  apiVersion?: string;      // default v21.0
}

/** Returns null unless the required vars are present — caller stays on the
 *  log-sandbox provider. Never invents or defaults credentials. */
export function whatsAppCloudConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WhatsAppCloudConfig | null {
  const accessToken = env['WHATSAPP_CLOUD_TOKEN'];
  const phoneNumberId = env['WHATSAPP_CLOUD_PHONE_NUMBER_ID'];
  if (!accessToken || !phoneNumberId) return null;
  const out: WhatsAppCloudConfig = { accessToken, phoneNumberId };
  if (env['WHATSAPP_CLOUD_API_BASE']) out.apiBase = env['WHATSAPP_CLOUD_API_BASE'];
  if (env['WHATSAPP_CLOUD_API_VERSION']) out.apiVersion = env['WHATSAPP_CLOUD_API_VERSION'];
  return out;
}

export interface WhatsAppCloudRequest { url: string; authorization: string; json: Record<string, unknown>; }
export interface WhatsAppCloudResponse { status: number; body: string; headers?: Record<string, string>; }
export type WhatsAppCloudHttpClient = (req: WhatsAppCloudRequest) => Promise<WhatsAppCloudResponse>;

const defaultHttp: WhatsAppCloudHttpClient = async ({ url, authorization, json }) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(json),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  return { status: res.status, body: await res.text(), headers };
};

/** Notifications spec v1.6 (WA-A3, TL Sev-3 ruling): an UNKNOWN Graph error
 *  code is NON-retryable — a loud immediate failure (audited + notify.failed to
 *  admins, QA-M2-5) beats an automatic retry on the unknown, because a retry
 *  that actually succeeded server-side would duplicate the send (idempotency
 *  lives at the job level, not the provider). Retry happens only through the
 *  dispatcher's known backoff policy: network errors, 429 (Retry-After), 5xx. */

export function createWhatsAppCloudProvider(
  cfg: WhatsAppCloudConfig,
  http: WhatsAppCloudHttpClient = defaultHttp,
): MessageProvider {
  const base = cfg.apiBase ?? 'https://graph.facebook.com';
  const version = cfg.apiVersion ?? 'v21.0';
  const url = `${base}/${version}/${cfg.phoneNumberId}/messages`;
  const authorization = `Bearer ${cfg.accessToken}`;
  return {
    name: 'whatsapp',
    send: async (to, bodyText) => {
      let res: WhatsAppCloudResponse;
      try {
        res = await http({
          url, authorization,
          json: {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'text',
            text: { body: bodyText },
          },
        });
      } catch (e) {
        return { ok: false, retryable: true, error: `network: ${(e as Error).message}` };
      }
      if (res.status >= 200 && res.status < 300) {
        let id: string | undefined;
        try { id = (JSON.parse(res.body) as { messages?: { id?: string }[] }).messages?.[0]?.id; } catch { /* keep undefined */ }
        return { ok: true, retryable: false, ...(id ? { providerMessageId: id } : {}) };
      }
      let code: number | undefined;
      let message = `whatsapp-cloud http ${res.status}`;
      try {
        const j = JSON.parse(res.body) as { error?: { code?: number; message?: string } };
        code = j.error?.code;
        if (j.error?.message) message = j.error.message;
      } catch { /* keep defaults */ }
      if (res.status === 429 || res.status >= 500) {
        const ra = res.headers?.['retry-after'];
        const retryAfterMs = ra !== undefined && /^\d+$/.test(ra) ? Math.min(Number(ra) * 1000, 60_000) : undefined;
        return { ok: false, retryable: true, error: message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
      }
      // spec v1.6: every 4xx Graph failure is non-retryable (unknown codes included).
      return { ok: false, retryable: false, error: message };
    },
  };
}
