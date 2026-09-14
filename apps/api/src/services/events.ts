import type { ChangeRequest, ID, StatusReport, WhitelistEntry } from '@contake/core';

/** In-process event bus: mutation paths publish, realtime/dispatch subscribe.
 *  Keeps Socket.IO out of the service layer; tests subscribe directly. */
export type AppEvent =
  | { type: 'graph.applied'; eventId: ID; changedTaskIds: ID[] }
  /** RT-PIN-4: task removed from a consumer's set (unassign / site transfer / delete).
   *  siteId = room that previously held the task (site tombstone); removedForUserIds
   *  get user-room tombstones. version = event version AFTER the mutation. */
  | { type: 'graph.removed'; eventId: ID; orgId: ID; version: number; taskIds: ID[]; siteId?: ID; removedForUserIds: ID[] }
  | { type: 'change.pending'; changeRequest: ChangeRequest }
  | { type: 'change.resolved'; changeRequest: ChangeRequest }
  | { type: 'report.new'; report: StatusReport; eventId: ID; siteId: ID }
  /** v1.12: shared handled-state for field reports -> adminsRoom + site room (mirrors report.new). */
  | { type: 'report.resolved'; report: StatusReport; eventId: ID; siteId: ID }
  | { type: 'notify.failed'; eventId: ID; jobId: ID; address: string; error: string }
  /** PR-3 (contracts v1.6/v1.7): shared FYI handled-state -> adminsRoom(orgId). */
  | { type: 'notify.acked'; eventId: ID; orgId: ID; jobId: ID; acknowledgedBy: ID; acknowledgedAt: string }
  /** v1.18 §15: whitelist lifecycle transition -> adminsRoom(orgId) only. */
  | { type: 'whitelist.updated'; orgId: ID; entry: WhitelistEntry };

type Listener = (e: AppEvent) => void;
const listeners = new Set<Listener>();

export const appEvents = {
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  emit(e: AppEvent): void {
    for (const fn of [...listeners]) {
      try { fn(e); } catch { /* a broken subscriber never blocks a mutation */ }
    }
  },
};
