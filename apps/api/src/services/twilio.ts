import type { MessageProvider } from './dispatch.js';

/** Twilio sandbox adapter (M3, integration plan §3ב): ONE provider behind the
 *  existing MessageProvider interface for WhatsApp + SMS fallback. Secrets are
 *  env-only (QA-M3-4) — no literals, no fallbacks. Real Meta template approval
 *  and business-entity setup are parked for pre-pilot. */

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  whatsappFrom: string;  // sandbox sender, e.g. +14155238886
  smsFrom: string;       // sandbox SMS sender
}

/** Returns null unless ALL required vars are present — the caller then stays on
 *  the log-sandbox providers. Never invents or defaults credentials. */
export function twilioConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TwilioConfig | null {
  const accountSid = env['TWILIO_ACCOUNT_SID'];
  const authToken = env['TWILIO_AUTH_TOKEN'];
  const whatsappFrom = env['TWILIO_WHATSAPP_FROM'];
  const smsFrom = env['TWILIO_SMS_FROM'];
  if (!accountSid || !authToken || !whatsappFrom || !smsFrom) return null;
  return { accountSid, authToken, whatsappFrom, smsFrom };
}

export interface TwilioRequest { url: string; authorization: string; form: Record<string, string>; }
export interface TwilioResponse { status: number; body: string; headers?: Record<string, string>; }
export type TwilioHttpClient = (req: TwilioRequest) => Promise<TwilioResponse>;

const defaultHttp: TwilioHttpClient = async ({ url, authorization, form }) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  return { status: res.status, body: await res.text(), headers };
};

/** Notifications spec v1.6 (WA-A3, general rule for ALL providers): an UNKNOWN
 *  provider error code is NON-retryable — a loud immediate failure (audited +
 *  notify.failed, QA-M2-5) beats an automatic retry that could duplicate a send
 *  (idempotency lives at the job level, not the provider). Retry happens only
 *  through the dispatcher's known backoff policy: network errors, 429, 5xx. */

export function createTwilioProvider(
  channel: 'whatsapp' | 'sms',
  cfg: TwilioConfig,
  http: TwilioHttpClient = defaultHttp,
): MessageProvider {
  const from = channel === 'whatsapp' ? `whatsapp:${cfg.whatsappFrom}` : cfg.smsFrom;
  const authorization = `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')}`;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`;
  return {
    name: channel,
    send: async (to, bodyText) => {
      let res: TwilioResponse;
      try {
        res = await http({
          url, authorization,
          form: { To: channel === 'whatsapp' ? `whatsapp:${to}` : to, From: from, Body: bodyText },
        });
      } catch (e) {
        return { ok: false, retryable: true, error: `network: ${(e as Error).message}` };
      }
      if (res.status === 200 || res.status === 201) {
        let sid: string | undefined;
        try { sid = (JSON.parse(res.body) as { sid?: string }).sid; } catch { /* keep undefined */ }
        return { ok: true, retryable: false, ...(sid ? { providerMessageId: sid } : {}) };
      }
      let code: number | undefined;
      let message = `twilio http ${res.status}`;
      try {
        const j = JSON.parse(res.body) as { code?: number; message?: string };
        code = j.code;
        if (j.message) message = j.message;
      } catch { /* keep defaults */ }
      if (res.status === 429 || res.status >= 500) {
        const ra = res.headers?.['retry-after'];
        const retryAfterMs = ra !== undefined && /^\d+$/.test(ra) ? Math.min(Number(ra) * 1000, 60_000) : undefined;
        return { ok: false, retryable: true, error: message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
      }
      // spec v1.6: every 4xx provider failure is non-retryable (unknown codes included).
      return { ok: false, retryable: false, error: message };
    },
  };
}
