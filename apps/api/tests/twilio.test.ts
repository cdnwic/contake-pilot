import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import type { GraphRepository } from '../src/repo/graph-repository.js';
import { makeTestRepo } from './helpers/repo.js';
import { createDispatcher } from '../src/services/dispatch.js';
import { appEvents, type AppEvent } from '../src/services/events.js';
import { createTwilioProvider, twilioConfigFromEnv, type TwilioRequest, type TwilioResponse } from '../src/services/twilio.js';

const CFG = { accountSid: 'ACtest00000000000000000000000000', authToken: 'test-token', whatsappFrom: '+14155238886', smsFrom: '+12055550100' };

const twilioHttp = (script: TwilioResponse[], capture?: TwilioRequest[]) => {
  let i = 0;
  return async (req: TwilioRequest): Promise<TwilioResponse> => {
    capture?.push(req);
    const res = script[Math.min(i, script.length - 1)]!;
    i += 1;
    return res;
  };
};

describe('M3 Twilio adapter (integration plan §3ב)', () => {
  it('config comes from env only: missing any var -> null, complete set -> config', () => {
    expect(twilioConfigFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(twilioConfigFromEnv({ TWILIO_ACCOUNT_SID: 'x' } as NodeJS.ProcessEnv)).toBeNull();
    const cfg = twilioConfigFromEnv({
      TWILIO_ACCOUNT_SID: 'ACx', TWILIO_AUTH_TOKEN: 't', TWILIO_WHATSAPP_FROM: '+1', TWILIO_SMS_FROM: '+2',
    } as NodeJS.ProcessEnv);
    expect(cfg).toEqual({ accountSid: 'ACx', authToken: 't', whatsappFrom: '+1', smsFrom: '+2' });
  });

  it('posts form-encoded Messages.json with basic auth; whatsapp: prefix only on the WA channel', async () => {
    const reqs: TwilioRequest[] = [];
    const ok = twilioHttp([{ status: 201, body: JSON.stringify({ sid: 'SM123' }) }], reqs);
    const wa = createTwilioProvider('whatsapp', CFG, ok);
    const res = await wa.send('+972500000001', 'שלום');
    expect(res).toEqual({ ok: true, retryable: false, providerMessageId: 'SM123' });
    expect(reqs[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${CFG.accountSid}/Messages.json`);
    expect(reqs[0]!.authorization).toBe(`Basic ${Buffer.from(`${CFG.accountSid}:${CFG.authToken}`).toString('base64')}`);
    expect(reqs[0]!.form).toEqual({ To: 'whatsapp:+972500000001', From: `whatsapp:${CFG.whatsappFrom}`, Body: 'שלום' });
    const sms = createTwilioProvider('sms', CFG, ok);
    await sms.send('+972500000001', 'x');
    expect(reqs[1]!.form['To']).toBe('+972500000001');
    expect(reqs[1]!.form['From']).toBe(CFG.smsFrom);
  });

  it('error mapping: 500/429 retryable (429 carries Retry-After), 21211-class non-retryable, network throw retryable', async () => {
    const p500 = createTwilioProvider('whatsapp', CFG, twilioHttp([{ status: 500, body: '{}' }]));
    expect(await p500.send('+1', 'x')).toMatchObject({ ok: false, retryable: true });
    const p429 = createTwilioProvider('whatsapp', CFG, twilioHttp([{ status: 429, body: '{}', headers: { 'retry-after': '2' } }]));
    expect(await p429.send('+1', 'x')).toMatchObject({ ok: false, retryable: true, retryAfterMs: 2000 });
    const p21211 = createTwilioProvider('whatsapp', CFG, twilioHttp([{ status: 400, body: JSON.stringify({ code: 21211, message: 'Invalid To number' }) }]));
    expect(await p21211.send('+1', 'x')).toMatchObject({ ok: false, retryable: false, error: 'Invalid To number' });
    // spec v1.6 (WA-A3, all providers): UNKNOWN code -> NON-retryable (loud failure, never a duplicate send)
    const pUnknown = createTwilioProvider('whatsapp', CFG, twilioHttp([{ status: 400, body: JSON.stringify({ code: 29999, message: 'Some future Twilio error' }) }]));
    expect(await pUnknown.send('+1', 'x')).toMatchObject({ ok: false, retryable: false, error: 'Some future Twilio error' });
    const pnet = createTwilioProvider('whatsapp', CFG, () => Promise.reject(new Error('ECONNRESET')));
    expect(await pnet.send('+1', 'x')).toMatchObject({ ok: false, retryable: true });
  });
});

describe('M3 provider fault injection through the real adapter (M3-QA-3)', () => {
  let app: FastifyInstance;
  let repo: GraphRepository;

  beforeEach(async () => {
    // Determinism: job-build quiet-hours reads the wall clock — pin a daytime Date
    // (fake Date only, timeouts stay real for backoff probes) or the suite is red 22:00-07:00.
    vi.useFakeTimers({ now: new Date('2026-09-14T12:00:00+03:00').getTime(), toFake: ['Date'] });
    repo = await makeTestRepo();
    app = buildApp(repo, new AuthService(repo));
    await app.ready();
  });
  afterEach(() => { vi.useRealTimers(); });

  const flagship = async (): Promise<void> => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@camp.local', password: 'admin123' } });
    const token = res.json().token as string;
    await app.inject({ method: 'PATCH', url: '/v1/tasks/t1', headers: { authorization: `Bearer ${token}` }, payload: { version: 1, move: { newStart: '2026-09-14T08:15:00+03:00' } } });
  };

  it('WA 500 -> SMS fallback sends through the Twilio SMS channel', async () => {
    await flagship();
    let clock = Date.now();
    const waCalls: TwilioRequest[] = [];
    const wa = createTwilioProvider('whatsapp', CFG, twilioHttp([{ status: 500, body: '{}' }], waCalls));
    const sms = createTwilioProvider('sms', CFG, twilioHttp([{ status: 201, body: JSON.stringify({ sid: 'SMok' }) }]));
    const d = createDispatcher({ repo, providers: { whatsapp: wa, sms }, maxAttempts: 1, now: () => clock });
    await d.dispatchDue();
    clock += 61_000;
    const recs = await d.dispatchDue();
    const sent = recs.filter(r => r.status === 'sent');
    expect(sent.length).toBe(31);
    expect(sent.every(r => r.provider === 'sms')).toBe(true);
    expect(waCalls.length).toBe(31); // one WA attempt per recipient, then fallback
  });

  it('full outage -> retry x3 -> terminal failure audited + notify.failed (QA-M2-5 vs real adapter)', async () => {
    await flagship();
    const events: AppEvent[] = [];
    const unsub = appEvents.subscribe(e => { if (e.type === 'notify.failed') events.push(e); });
    const down = (ch: 'whatsapp' | 'sms') => createTwilioProvider(ch, CFG, twilioHttp([{ status: 500, body: '{}' }]));
    let clock = Date.now();
    const d = createDispatcher({ repo, providers: { whatsapp: down('whatsapp'), sms: down('sms') }, maxAttempts: 3, now: () => clock });
    await d.dispatchDue();
    clock += 61_000;
    const recs = await d.dispatchDue();
    const failed = recs.filter(r => r.status === 'failed');
    expect(failed.length).toBe(31);
    expect(failed.every(r => r.attempts === 3)).toBe(true);
    const auditRows = (await repo.listAudit('org-1')).filter(a => a.action === 'notify.send.targeted' && a.entityType === 'notification');
    expect(auditRows.length).toBe(31);
    expect(events.length).toBeGreaterThan(0);
    unsub();
  });

  it('invalid number (21211) -> non-retryable: no retry loop, single attempt per provider, audited', async () => {
    await flagship();
    let clock = Date.now();
    const waCalls: TwilioRequest[] = [];
    const smsCalls: TwilioRequest[] = [];
    const bad = { status: 400, body: JSON.stringify({ code: 21211, message: 'Invalid To number' }) };
    const wa = createTwilioProvider('whatsapp', CFG, twilioHttp([bad], waCalls));
    const sms = createTwilioProvider('sms', CFG, twilioHttp([bad], smsCalls));
    const d = createDispatcher({ repo, providers: { whatsapp: wa, sms }, maxAttempts: 3, now: () => clock });
    await d.dispatchDue();
    clock += 61_000;
    const recs = await d.dispatchDue();
    const failed = recs.filter(r => r.status === 'failed');
    expect(failed.length).toBe(31);
    // no 3x retry loop on a hard failure: exactly one attempt per recipient per provider
    expect(waCalls.length).toBe(31);
    expect(smsCalls.length).toBe(31);
    const auditRows = (await repo.listAudit('org-1')).filter(a => a.action === 'notify.send.targeted');
    expect(auditRows.length).toBe(31);
  });

  it('429 rate limit -> retryable with provider backoff honored (delay observed between attempts)', async () => {
    await flagship();
    const sleeps: number[] = [];
    const callsByTo = new Map<string, number>();
    const flaky = createTwilioProvider('whatsapp', CFG, async (req) => {
      const n = (callsByTo.get(req.form['To']!) ?? 0) + 1;
      callsByTo.set(req.form['To']!, n);
      return n < 2
        ? { status: 429, body: '{}', headers: { 'retry-after': '2' } }
        : { status: 201, body: JSON.stringify({ sid: 'SMr' }) };
    });
    let clock = Date.now();
    const d = createDispatcher({
      repo, providers: { whatsapp: flaky, sms: flaky }, maxAttempts: 3, now: () => clock,
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
    });
    await d.dispatchDue();
    clock += 61_000;
    const recs = await d.dispatchDue();
    expect(recs.filter(r => r.status === 'sent').length).toBe(31);
    expect(sleeps.length).toBe(31);
    expect(sleeps.every(s => s === 2000)).toBe(true); // Retry-After honored per attempt
  });
});
