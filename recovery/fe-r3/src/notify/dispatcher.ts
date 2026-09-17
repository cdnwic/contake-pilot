/** PR-3 (plan §3ה): the single client-side action dispatcher. Maps notification
 *  type to EXISTING mutation APIs — no new endpoints, and NEVER mutates the local
 *  graph: handled-state reconciles via realtime frames / refetch only.
 *  Rules: immediate lock + in-flight no-op on double-click; success → toast, item
 *  stays locked until the change.resolved frame lands (safety timeout releases);
 *  409 (already resolved elsewhere) → revert + toast; network → revert + toast,
 *  item stays actionable. */
import type { NotificationItem } from './center';
import * as api from '../api/client';
import type { Principal } from '../contracts/contake-core-contracts.v1.1';

export type DispatchAction = 'approve' | 'reject' | 'ack';

export interface DispatchDeps {
  approveChange: (changeId: string, principal: Principal) => Promise<{ outcome: string; messageHe: string }>;
  rejectChange: (changeId: string, principal: Principal) => Promise<{ outcome: string; messageHe: string }>;
  ackNotifyJob: (jobId: string, principal: Principal) => Promise<{ acknowledgedBy: string; acknowledgedAt: string }>;
  isLocked: (id: string) => boolean;
  lock: (id: string) => void;
  unlock: (id: string) => void;
  toast: (msg: string) => void;
  /** called to reconcile after settle (frame invalidation / safety refetch) */
  resync: () => void;
  /** ms to keep a succeeded item locked waiting for the frame; 0 disables (tests). */
  frameTimeoutMs?: number;
}

export function actionLabel(a: DispatchAction): string {
  return a === 'approve' ? 'אישור' : a === 'reject' ? 'דחייה' : 'סמן כטופל';
}

export function actionsFor(item: NotificationItem, ackSupported: boolean): DispatchAction[] {
  if (item.kind === 'change_pending' && item.changeRequestId) return ['approve', 'reject'];
  if (item.kind === 'job_failed' && item.jobId && !item.handledBy && ackSupported) return ['ack'];
  return [];
}

/** Returns false when the click was a no-op (already in flight). */
export async function dispatchAction(
  item: NotificationItem,
  action: DispatchAction,
  principal: Principal,
  deps: DispatchDeps,
): Promise<boolean> {
  const key = `${item.id}:${action}`;
  if (deps.isLocked(item.id) || deps.isLocked(key)) return false; // double-click = no-op
  deps.lock(item.id);
  let frameOwnsLock = false;
  try {
    if (action === 'approve' && item.changeRequestId) {
      const r = await deps.approveChange(item.changeRequestId, principal);
      if (r.outcome === 'stale') {
        deps.toast('השינוי כבר טופל — המצב מתעדכן');
        deps.resync();
        return true;
      }
      deps.toast(r.messageHe || '✓ אושר');
    } else if (action === 'reject' && item.changeRequestId) {
      const r = await deps.rejectChange(item.changeRequestId, principal);
      if (r.outcome === 'stale') {
        deps.toast('השינוי כבר טופל — המצב מתעדכן');
        deps.resync();
        return true;
      }
      deps.toast(r.messageHe || '✕ נדחה');
    } else if (action === 'ack' && item.jobId) {
      await deps.ackNotifyJob(item.jobId, principal);
      deps.toast('✓ סומן כטופל');
    } else {
      return false;
    }
    // Success: keep the lock until the frame reconciles (dispatcher never mutates state).
    const t = deps.frameTimeoutMs ?? 10_000;
    if (t > 0) { frameOwnsLock = true; setTimeout(() => { deps.unlock(item.id); deps.resync(); }, t); }
    return true;
  } catch (e) {
    // 409 / network / any failure: revert, error toast, item stays actionable if pending.
    const msg = e instanceof Error ? e.message : String(e);
    deps.toast(`הפעולה נכשלה: ${msg}`);
    deps.resync();
    return true;
  } finally {
    // AC-PR3-3: failure AND stale paths always release the item lock — only an
    // applied success transfers lock ownership to the frame-wait timeout.
    if (!frameOwnsLock) deps.unlock(item.id);
    deps.unlock(key);
  }
}

/** api-backed deps factory (Shell wires store + query invalidation). */
export function liveDeps(profileId: string, base: Omit<DispatchDeps, 'approveChange' | 'rejectChange' | 'ackNotifyJob'>): DispatchDeps {
  return {
    ...base,
    approveChange: (changeId, principal) => api.approveChange(profileId, changeId, principal),
    rejectChange: (changeId, principal) => api.rejectChange(profileId, changeId, principal),
    ackNotifyJob: (jobId, principal) => api.ackNotifyJob(profileId, jobId, principal).then(() => ({ acknowledgedBy: principal.userId, acknowledgedAt: new Date().toISOString() })),
  };
}