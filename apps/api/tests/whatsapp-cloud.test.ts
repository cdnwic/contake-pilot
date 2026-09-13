/** PR-2: Meta WhatsApp Cloud API adapter — env gating, success, and fault
 *  mapping (mirrors the M3 Twilio adapter's QA-M3-3 probes). Code-only: no
 *  live Meta calls anywhere in the suite. */
import { describe, expect, it } from 'vitest';
import { createWhatsAppCloudProvider, whatsAppCloudConfigFromEnv, type WhatsAppCloudHttpClient, type WhatsAppCloudRequest } from '../src/services/whatsapp-cloud.js';

const CFG = { accessToken: 'test-token', phoneNumberId: '1234567890' };

const httpReturning = (status: number, body: string, headers?: Record<string, string>): { http: WhatsAppCloudHttpClient; seen: WhatsAppCloudRequest[] } => {
  const seen: WhatsAppCloudRequest[] = [];
  return { http: async req => { seen.push(req); return { status, body, ...(headers ? { headers } : {}) }; }, seen };
};

describe('PR-2 whatsapp-cloud adapter', () => {
  it('env gating: null without BOTH required vars, never invents credentials', () => {
    expect(whatsAppCloudConfigFromEnv({})).toBeNull();
    expect(whatsAppCloudConfigFromEnv({ WHATSAPP_CLOUD_TOKEN: 't' })).toBeNull();
    expect(whatsAppCloudConfigFromEnv({ WHATSAPP_CLOUD_PHONE_NUMBER_ID: 'p' })).toBeNull();
    expect(whatsAppCloudConfigFromEnv({ WHATSAPP_CLOUD_TOKEN: 't', WHATSAPP_CLOUD_PHONE_NUMBER_ID: 'p' })).toEqual({ accessToken: 't', phoneNumberId: 'p' });
  });

  it('success: POSTs Cloud API text message, maps messages[0].id', async () => {
    const { http, seen } = httpReturning(200, JSON.stringify({ messages: [{ id: 'wamid.abc123' }] }));
    const p = createWhatsAppCloudProvider(CFG, http);
    const res = await p.send('+97252100001', 'המשימה הוזזה ל-09:30');
    expect(res).toEqual({ ok: true, retryable: false, providerMessageId: 'wamid.abc123' });
    expect(seen.length).toBe(1);
    expect(seen[0]!.url).toBe('https://graph.facebook.com/v21.0/1234567890/messages');
    expect(seen[0]!.authorization).toBe('Bearer test-token');
    expect(seen[0]!.json).toMatchObject({ messaging_product: 'whatsapp', to: '+97252100001', type: 'text' });
  });

  it('429 with Retry-After -> retryable with capped backoff', async () => {
    const { http } = httpReturning(429, JSON.stringify({ error: { code: 4, message: 'rate limit' } }), { 'retry-after': '120' });
    const res = await createWhatsAppCloudProvider(CFG, http).send('+97252100001', 'x');
    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(true);
    expect(res.retryAfterMs).toBe(60_000); // capped
  });

  it('5xx -> retryable', async () => {
    const { http } = httpReturning(500, 'oops');
    const res = await createWhatsAppCloudProvider(CFG, http).send('+97252100001', 'x');
    expect(res).toMatchObject({ ok: false, retryable: true });
  });

  it('131030 (recipient not allowed) -> non-retryable, message surfaced', async () => {
    const { http } = httpReturning(403, JSON.stringify({ error: { code: 131030, message: 'Recipient phone number not in allowed list' } }));
    const res = await createWhatsAppCloudProvider(CFG, http).send('+97252100001', 'x');
    expect(res).toMatchObject({ ok: false, retryable: false, error: 'Recipient phone number not in allowed list' });
  });

  it('131047 (outside 24h window) -> non-retryable', async () => {
    const { http } = httpReturning(400, JSON.stringify({ error: { code: 131047, message: 'Re-engagement message' } }));
    const res = await createWhatsAppCloudProvider(CFG, http).send('+97252100001', 'x');
    expect(res.retryable).toBe(false);
  });

  it('spec v1.6: UNKNOWN Graph code -> NON-retryable (loud failure, never a duplicate send)', async () => {
    const { http } = httpReturning(400, JSON.stringify({ error: { code: 999999, message: 'Some future Graph error' } }));
    const res = await createWhatsAppCloudProvider(CFG, http).send('+97252100001', 'x');
    expect(res).toMatchObject({ ok: false, retryable: false, error: 'Some future Graph error' });
  });

  it('network throw -> retryable', async () => {
    const p = createWhatsAppCloudProvider(CFG, async () => { throw new Error('ECONNRESET'); });
    const res = await p.send('+97252100001', 'x');
    expect(res).toMatchObject({ ok: false, retryable: true, error: 'network: ECONNRESET' });
  });

  it('secret never leaks into error payloads', async () => {
    const { http } = httpReturning(401, JSON.stringify({ error: { code: 190, message: 'Invalid OAuth access token' } }));
    const res = await createWhatsAppCloudProvider(CFG, http).send('+97252100001', 'x');
    expect(JSON.stringify(res)).not.toContain('test-token');
  });
});
