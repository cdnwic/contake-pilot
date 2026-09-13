import { describe, expect, it } from 'vitest';
import { createWhatsAppCloudProvider, whatsAppCloudConfigFromEnv, type WhatsAppCloudHttpClient } from '../src/services/whatsapp-cloud.js';

const CFG = { accessToken: 'SECRET_TOKEN_XYZ', phoneNumberId: '123456789' };

describe('QA-WA-CLOUD adversarial probes (QA-owned)', () => {
  it('WA-A1: Retry-After far above the 60s cap is clamped to exactly 60000ms', async () => {
    const http: WhatsAppCloudHttpClient = async () => ({ status: 429, body: '{}', headers: { 'retry-after': '999999' } });
    const p = createWhatsAppCloudProvider(CFG, http);
    const r = await p.send('+972500000000', 'hi');
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
    expect(r.retryAfterMs).toBe(60_000);
  });

  it('WA-A2: 200 with garbage body still succeeds without a providerMessageId (no crash, no phantom id)', async () => {
    const http: WhatsAppCloudHttpClient = async () => ({ status: 200, body: 'not json at all' });
    const p = createWhatsAppCloudProvider(CFG, http);
    const r = await p.send('+972500000000', 'hi');
    expect(r.ok).toBe(true);
    expect(r.providerMessageId).toBeUndefined();
  });

  it('WA-A3 (spec v1.6): unknown 4xx Graph code is NON-retryable - loud failure, no duplicate-send risk', async () => {
    const http: WhatsAppCloudHttpClient = async () => ({ status: 400, body: JSON.stringify({ error: { code: 999999, message: 'unclassified' } }) });
    const p = createWhatsAppCloudProvider(CFG, http);
    const r = await p.send('+972500000000', 'hi');
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(false); // spec v1.6 / TL Sev-3 ruling: docstring wins
  });

  it('WA-A4: token appears ONLY in the authorization field - never in URL or JSON body', async () => {
    let captured: { url: string; authorization: string; json: Record<string, unknown> } | null = null;
    const http: WhatsAppCloudHttpClient = async (req) => { captured = req; return { status: 200, body: '{"messages":[{"id":"wamid.1"}]}' }; };
    const p = createWhatsAppCloudProvider(CFG, http);
    await p.send('+972500000000', 'hi');
    expect(captured).not.toBeNull();
    expect(captured!.authorization).toBe('Bearer SECRET_TOKEN_XYZ');
    expect(captured!.url).not.toContain('SECRET_TOKEN_XYZ');
    expect(JSON.stringify(captured!.json)).not.toContain('SECRET_TOKEN_XYZ');
  });

  it('WA-A5: non-retryable classified code never carries retryAfterMs even when Meta sends Retry-After', async () => {
    const http: WhatsAppCloudHttpClient = async () => ({ status: 403, body: JSON.stringify({ error: { code: 190, message: 'token expired' } }), headers: { 'retry-after': '5' } });
    const p = createWhatsAppCloudProvider(CFG, http);
    const r = await p.send('+972500000000', 'hi');
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(false);
    expect(r.retryAfterMs).toBeUndefined();
  });

  it('WA-A6: env gating refuses partial config (token without phone id, phone id without token)', () => {
    expect(whatsAppCloudConfigFromEnv({ WHATSAPP_CLOUD_TOKEN: 't' })).toBeNull();
    expect(whatsAppCloudConfigFromEnv({ WHATSAPP_CLOUD_PHONE_NUMBER_ID: 'p' })).toBeNull();
    expect(whatsAppCloudConfigFromEnv({ WHATSAPP_CLOUD_TOKEN: '', WHATSAPP_CLOUD_PHONE_NUMBER_ID: 'p' })).toBeNull();
  });
});
