import type { DomainProfile, ID, NotificationJob, NotificationTarget, PushSubscription } from '@contake/core';
import { getProfile, parseInstant } from '@contake/core';
import type { GraphRepository } from '../repo/graph-repository.js';
import { appEvents } from './events.js';
import { audit } from './audit.js';

/**
 * notify.dispatch worker (notifications spec v1.2 §5, contracts v1.3).
 * In-process Alpha implementation of the BullMQ job; the queue swap at staging
 * keeps these exact semantics:
 *  - idempotent at the job+recipient boundary (ND-2; a retried enqueue never double-sends)
 *  - 60s batching per recipient into digest_multi_change (ND-3, N1)
 *  - quiet-hours holdUntil honored against an injected clock (ND-4)
 *  - opt-out suppression (ND-5)
 *  - WhatsApp -> SMS fallback, retry x3, terminal failure alerts admins in_app (ND-6)
 *  - params-allowlist template rendering, values always literal (ND-7)
 */

export interface ProviderResult { ok: boolean; providerMessageId?: string; retryable: boolean; error?: string; retryAfterMs?: number; gone?: boolean }

/** Web push (contracts v1.10, web-push-spec §3/§4). The push provider is a
 *  DELIVERY path only: recipients stay the pinned in_app targets. Retry semantics
 *  mirror v1.6: 404/410 -> gone (dead subscription, deleted, never retried);
 *  429/5xx -> retryable honoring Retry-After; unknown codes -> non-retryable. */
export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  data: { url: string; jobId: ID; kind: string; eventId: ID };
}
export interface WebPushProvider {
  readonly name: 'web_push';
  send(subscription: PushSubscription, payload: PushPayload): Promise<ProviderResult>;
}
/** Route-hint for notificationclick; the FE SW may refine via the PR-3 mapping. */
export function pushUrlForKind(kind: string): string {
  if (kind === 'change_needs_approval') return '/notifications';
  if (kind === 'task_assigned' || kind === 'task_unassigned' || kind === 'task_moved' || kind === 'task_cancelled') return '/focus';
  return '/notifications';
}
export interface MessageProvider {
  readonly name: 'whatsapp' | 'sms';
  send(to: string, body: string): Promise<ProviderResult>;
}

export interface DispatchRecord {
  id: ID;
  jobId: ID;
  idempotencyKey: string;   // job.idempotencyKey + '|' + address
  address: string;
  status: 'sent' | 'failed' | 'suppressed_optout' | 'held' | 'batched';
  attempts: number;
  provider?: 'whatsapp' | 'sms' | 'web_push';
  body?: string;
  error?: string;
  at: string;
}

/** Per-template params allowlist (spec §4: no free interpolation). */
export const TEMPLATE_PARAMS: Record<string, string[]> = {
  task_moved: ['taskName', 'newStart', 'summaryHe'],
  task_delayed: ['taskName', 'newStart', 'summaryHe'],
  task_cancelled: ['taskName', 'summaryHe'],
  task_assigned: ['taskName', 'newStart'],
  task_unassigned: ['taskName'],
  change_needs_approval: ['summaryHe'],
  digest_multi_change: ['changeCount', 'eventName', 'summaryHe'],
};

/** Single-pass allowlist rendering: only {{allowlistedKey}} placeholders are
 *  substituted; param VALUES are inserted literally and never re-scanned (ND-7). */
export function renderTemplate(template: string, params: Record<string, string>, allowlist: string[]): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
    allowlist.includes(key) && params[key] !== undefined ? params[key] : whole,
  );
}

export interface Dispatcher {
  dispatchDue: () => Promise<DispatchRecord[]>;
  handleInboundStop: (address: string) => Promise<number>;
  records: () => DispatchRecord[];
}

/** PR-1(c): restart-survival surface for dispatch state (sent idempotency keys,
 *  recipient batch windows, staff opt-out suppressions). Default is in-memory
 *  (test/dev); the Postgres adapter supplies a durable implementation. */
export interface DispatchStateStore {
  hasDispatched(key: string): Promise<boolean>;
  markDispatched(key: string): Promise<void>;
  getBatchWindowClose(address: string): Promise<number | undefined>;
  setBatchWindowClose(address: string, closeMs: number): Promise<void>;
  clearBatchWindow(address: string): Promise<void>;
  isSuppressed(address: string): Promise<boolean>;
  markSuppressed(address: string): Promise<void>;
}

export function memoryDispatchState(): DispatchStateStore {
  const sent = new Set<string>();
  const windows = new Map<string, number>();
  const suppressed = new Set<string>();
  return {
    hasDispatched: async k => sent.has(k),
    markDispatched: async k => { sent.add(k); },
    getBatchWindowClose: async a => windows.get(a),
    setBatchWindowClose: async (a, closeMs) => { windows.set(a, closeMs); },
    clearBatchWindow: async a => { windows.delete(a); },
    isSuppressed: async a => suppressed.has(a),
    markSuppressed: async a => { suppressed.add(a); },
  };
}

export function createDispatcher(input: {
  repo: GraphRepository;
  providers: { whatsapp: MessageProvider; sms: MessageProvider };
  /** contracts v1.10: web push delivery for in_app targets. Omitted = push off. */
  push?: WebPushProvider;
  now?: () => number;
  maxAttempts?: number;
  /** Injectable so tests observe provider-requested backoff without real waits. */
  sleep?: (ms: number) => Promise<void>;
  /** PR-1(c): durable dispatch state; defaults to in-memory. */
  state?: DispatchStateStore;
}): Dispatcher {
  const { repo, providers } = input;
  const push = input.push;
  const state = input.state ?? memoryDispatchState();
  const now = input.now ?? (() => Date.now());
  const maxAttempts = input.maxAttempts ?? 3;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const records: DispatchRecord[] = [];
  let seq = 0;
  const recId = (): ID => `disp_${(seq += 1)}`;

  // Recipient-level 60s batching window (TL M2.1): the FIRST pending change for an
  // address opens a window; everything for that address until close merges into ONE
  // message (digest when >=2 distinct changes) — across any number of dispatch ticks.
  const BATCH_WINDOW_MS = 60_000;

  const record = (r: Omit<DispatchRecord, 'id' | 'at'>): DispatchRecord => {
    const full: DispatchRecord = { ...r, id: recId(), at: new Date(now()).toISOString() };
    records.push(full);
    return full;
  };

  const isHeld = (job: NotificationJob): boolean =>
    job.holdUntil !== undefined && parseInstant(job.holdUntil) > now();

  const targetAddress = (t: NotificationTarget): string => t.address;
  const isOptedOut = async (t: NotificationTarget): Promise<boolean> => {
    if (await state.isSuppressed(t.address)) return true;
    return (await repo.findChannelByAddress(t.address))?.optedOut === true;
  };

  const sendOne = async (t: NotificationTarget, body: string, pushPayload?: PushPayload): Promise<{ ok: boolean; provider?: 'whatsapp' | 'sms' | 'web_push'; error?: string }> => {
    if (t.channel === 'in_app') return { ok: true, provider: undefined }; // in_app frames ride Socket.IO; no provider
    if (t.channel === 'web_push') {
      if (!push || !pushPayload) return { ok: true, provider: undefined };
      const subs = await repo.listPushSubscriptions(t.address);
      if (subs.length === 0) return { ok: true, provider: undefined }; // no devices: in_app already delivered
      let lastError = 'unknown';
      let sent = 0;
      let undeliverable = 0; // live (non-dead) subscriptions we could not send to
      for (const sub of subs) {
        let subOk = false;
        let dead = false;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const res = await push.send(sub, pushPayload);
          if (res.ok) { subOk = true; break; }
          lastError = res.error ?? 'web_push failed';
          if (res.gone) { dead = true; break; } // 404/410: dead subscription — delete, never retry
          if (!res.retryable) break;            // v1.6: unknown codes are non-retryable (loud failure)
          if (attempt < maxAttempts && (res.retryAfterMs ?? 0) > 0) await sleep(res.retryAfterMs!);
        }
        if (dead) { await repo.deletePushSubscriptionByEndpoint(sub.endpoint); continue; }
        if (subOk) sent++; else undeliverable++;
      }
      if (undeliverable > 0 && sent === 0) return { ok: false, error: lastError };
      return { ok: true, provider: 'web_push' };
    }
    let lastError = 'unknown';
    for (const provider of t.channel === 'sms' ? [providers.sms] : [providers.whatsapp, providers.sms]) {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const res = await provider.send(targetAddress(t), body);
        if (res.ok) return { ok: true, provider: provider.name };
        lastError = res.error ?? `${provider.name} failed`;
        if (!res.retryable) break; // hard failure: next provider
        // Provider-requested backoff (e.g. Twilio 429 Retry-After) is honored between attempts.
        if (attempt < maxAttempts && (res.retryAfterMs ?? 0) > 0) await sleep(res.retryAfterMs!);
      }
    }
    return { ok: false, error: lastError };
  };

  const dispatchDue = async (): Promise<DispatchRecord[]> => {
    const out: DispatchRecord[] = [];
    const jobs = await repo.listNotificationJobsAll();

    // Collect pending recipient entries across ALL jobs, grouped by address, so the
    // 60s batching rule (ND-3/N1) sees every undelivered change for that recipient.
    interface Pending { job: NotificationJob; target: NotificationTarget; key: string; }
    const held: Pending[] = [];
    const byAddress = new Map<string, Pending[]>();
    for (const job of jobs) {
      for (const t of job.targets) {
        const key = `${job.idempotencyKey}|${targetAddress(t)}`;
        if (await state.hasDispatched(key)) continue;
        const p: Pending = { job, target: t, key };
        if (isHeld(job)) { held.push(p); continue; }
        const arr = byAddress.get(targetAddress(t)) ?? [];
        arr.push(p);
        byAddress.set(targetAddress(t), arr);
      }
      // contracts v1.10: each in_app target also fans out to web push under a
      // SEPARATE batching identity (push:{userId}), so the in_app frame stays
      // immediate while push obeys the 60s recipient window (web-push-spec §3).
      // Quiet-hours-held jobs never synthesize push entries while held.
      if (push && !isHeld(job)) {
        for (const t of job.targets) {
          if (t.channel !== 'in_app') continue;
          const key = `${job.idempotencyKey}|push:${t.address}`;
          if (await state.hasDispatched(key)) continue;
          const pt: NotificationTarget = { ...t, channel: 'web_push' };
          const arr = byAddress.get(`push:${t.address}`) ?? [];
          arr.push({ job, target: pt, key });
          byAddress.set(`push:${t.address}`, arr);
        }
      }
    }
    for (const p of held) {
      out.push(record({ jobId: p.job.id, idempotencyKey: p.key, address: targetAddress(p.target), status: 'held', attempts: 0 }));
    }

    for (const [address, entries] of byAddress) {
      const t = entries[0]!.target;
      const eventId = entries[0]!.job.eventId;
      const ev = await repo.getEvent(eventId);
      // Stage 1 hardening: fail loud when the event exists but its profile is
      // unknown. The camp fallback is ONLY for sentinel jobs (eventId 'pending',
      // e.g. whitelist pending-approval) that have no event row.
      const profile: DomainProfile = ev ? getProfile(ev.domainProfileId) : getProfile('camp');
      if (await isOptedOut(t)) {
        for (const p of entries) {
          await state.markDispatched(p.key);
          out.push(record({ jobId: p.job.id, idempotencyKey: p.key, address, status: 'suppressed_optout', attempts: 0 }));
        }
        continue;
      }
      // in_app targets are urgent (admin alerts, approvals): no batch delay.
      // Quiet-hours-held jobs keep their own timing: once holdUntil passes they
      // dispatch on the next tick, no batch window (TL M2.1 urgent/held distinction).
      // Everyone else waits for their recipient-level window to close (ND-3).
      if (t.channel !== 'in_app' && entries[0]!.job.holdUntil === undefined) {
        const close = await state.getBatchWindowClose(address);
        if (close === undefined) {
          await state.setBatchWindowClose(address, now() + BATCH_WINDOW_MS);
          continue; // window just opened — nothing sends this tick
        }
        if (now() < close) continue; // still collecting
        await state.clearBatchWindow(address);
      }
      const distinctChanges = new Set(entries.map(p => p.job.idempotencyKey));
      // >=2 distinct changes for one recipient in the window -> ONE digest (ND-3)
      const useDigest = distinctChanges.size >= 2;
      const body = useDigest
        ? renderTemplate(
            profile.notificationTemplates['digest_multi_change'] ?? '',
            { changeCount: String(distinctChanges.size), eventName: ev?.name ?? '', summaryHe: entries[0]!.job.params['summaryHe'] ?? '' },
            TEMPLATE_PARAMS['digest_multi_change'] ?? [],
          )
        : (() => {
            const job = entries[0]!.job;
            const templates = profile.notificationTemplates as Record<string, string>;
            const template = templates[job.templateKey] ?? '';
            return renderTemplate(template, job.params, TEMPLATE_PARAMS[job.templateKey] ?? []);
          })();
      const pushPayload: PushPayload | undefined = t.channel === 'web_push'
        ? {
            title: ev?.name ?? 'Contake',
            body,
            icon: '/icons/push-192.png',
            badge: '/icons/badge-96.png',
            data: {
              url: pushUrlForKind(useDigest ? 'digest_multi_change' : entries[0]!.job.kind),
              jobId: entries[0]!.job.id,
              kind: useDigest ? 'digest_multi_change' : entries[0]!.job.kind,
              eventId,
            },
          }
        : undefined;
      const res = await sendOne(t, body, pushPayload);
      for (const p of entries) {
        await state.markDispatched(p.key);
        if (res.ok) {
          out.push(record({
            jobId: p.job.id, idempotencyKey: p.key, address,
            status: useDigest ? 'batched' : 'sent', attempts: 1,
            ...(res.provider ? { provider: res.provider } : {}), body,
          }));
        } else {
          out.push(record({ jobId: p.job.id, idempotencyKey: p.key, address, status: 'failed', attempts: maxAttempts, error: res.error ?? 'failed' }));
        }
      }
      // web-push-spec §8/AC-PUSH-8: a push failure on a device never raises
      // notify.failed when the in_app frame was delivered (always true for the
      // in_app-derived fanout) — it is recorded in DispatchRecord only. Other
      // channels keep the pinned QA-M2-4 escalation.
      if (!res.ok && t.channel !== 'web_push') {
        // QA-M2-4: terminal failure is audited AND surfaces in Control Tower — never silent.
        const ev2 = await repo.getEvent(eventId);
        if (ev2) {
          await audit(repo, {
            orgId: ev2.orgId, eventId, actorUserId: 'system', role: 'admin',
            action: 'notify.send.targeted', entityType: 'notification', entityId: entries[0]!.job.id,
            after: { status: 'failed', address, error: res.error ?? 'failed', attempts: maxAttempts },
          });
        }
        appEvents.emit({ type: 'notify.failed', eventId, jobId: entries[0]!.job.id, address, error: res.error ?? 'failed' });
      }
    }
    return out;
  };

  /** STOP handler (ND-5): disconnect the channel; returns how many were marked. */
  const handleInboundStop = async (address: string): Promise<number> => {
    let marked = 0;
    const ch = await repo.findChannelByAddress(address);
    if (ch && !ch.optedOut) { await repo.updateChannel(ch.id, { optedOut: true }); marked++; }
    if (!ch) { await state.markSuppressed(address); marked++; } // staff phone opt-out
    return marked;
  };

  return { dispatchDue, handleInboundStop, records: () => [...records] };
}

const stringifyParams = (p: Record<string, string>): Record<string, string> => p;
