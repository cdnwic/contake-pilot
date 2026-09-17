/** PR-3 (plan §3ה): notification-center feed synthesis. Pure client-side — NO new
 *  endpoints. Sources: change requests (actionable approve/decline + handled state),
 *  session notify.failed frames joined to jobs for shared ack state (contracts v1.8),
 *  session report.new frames. The dispatcher never mutates graph state; handled-state
 *  reconciles via frames. */
import type { ChangeRequest, NotificationJob, StatusReport } from '../contracts/contake-core-contracts.v1.1';
import type { ClientState } from '../api/mockApi';

export type NotificationKind = 'change_pending' | 'change_resolved' | 'report' | 'job_failed';
export type Severity = 'action' | 'critical' | 'info';

export interface NotificationItem {
  /** stable id: cr:<id> / job:<id> / report:<clientReportId> — dispatcher lock key. */
  id: string;
  kind: NotificationKind;
  severity: Severity;
  titleHe: string;
  bodyHe?: string;
  at: string; // ISO, sort key
  changeRequestId?: string;  // actionable: approve/decline
  jobId?: string;            // ack-able when the endpoint is live (contracts v1.8)
  jobAddress?: string;       // failed delivery target, for display
  taskId?: string;           // deep-link target
  handledBy?: string;        // resolvedBy / acknowledgedBy (internal id — logic only, NEVER rendered)
  handledByLabel?: string;   // display-safe label (domain role label) — the only rendered form
  handledAt?: string;
}

export interface SessionFailure { jobId: string; address: string; error: string; at: string }
export interface SessionReport { report: StatusReport; at: string }

const crTitle = (cr: ChangeRequest): string => {
  const moved = cr.dominoResult?.movedTasks?.length ?? 0;
  const base = cr.change.type === 'task.update' ? 'עדכון משימה'
    : cr.change.type === 'task.move' ? 'הזזת משימה'
    : cr.change.type === 'task.assign' ? 'שיוך משימה'
    : cr.change.type === 'task.create' ? 'משימה חדשה'
    : cr.change.type === 'task.delete' ? 'מחיקת משימה'
    : 'שינוי בגרף';
  return moved > 0 ? `${base} · אפקט דומינו: ${moved} משימות` : base;
};
const taskOf = (cr: ChangeRequest): string | undefined => (cr.change as { taskId?: string }).taskId;

export function severityRank(s: Severity): number { return s === 'critical' ? 0 : s === 'action' ? 1 : 2; }

export function synthesizeFeed(
  state: Pick<ClientState, 'changes' | 'pendingNotifications'>,
  sessionFailures: SessionFailure[],
  sessionReports: SessionReport[],
  /** P-6: maps an internal user id to a display-safe label (domain role label from audit/profile). */
  displayOf?: (userId: string) => string | undefined,
): NotificationItem[] {
  const items: NotificationItem[] = [];
  const jobsById = new Map<string, NotificationJob>(state.pendingNotifications.map((j) => [j.id, j]));
  for (const cr of state.changes) {
    if (cr.state === 'pending_review') {
      items.push({
        id: `cr:${cr.id}`, kind: 'change_pending', severity: 'action',
        titleHe: crTitle(cr), bodyHe: cr.reasonHe, at: cr.createdAt,
        changeRequestId: cr.id, taskId: taskOf(cr),
      });
    } else if (cr.state === 'approved' || cr.state === 'rejected') {
      items.push({
        id: `cr:${cr.id}`, kind: 'change_resolved', severity: 'info',
        titleHe: `${crTitle(cr)} — ${cr.state === 'approved' ? 'אושר' : 'נדחה'}`,
        at: cr.resolvedAt ?? cr.createdAt, changeRequestId: cr.id, taskId: taskOf(cr),
        handledBy: cr.resolvedBy, handledByLabel: cr.resolvedBy ? displayOf?.(cr.resolvedBy) : undefined, handledAt: cr.resolvedAt,
      });
    }
  }
  for (const f of sessionFailures) {
    const job = jobsById.get(f.jobId);
    items.push({
      id: `job:${f.jobId}`, kind: 'job_failed', severity: 'critical',
      titleHe: `כשל בשליחת עדכון ל-${f.address}`, bodyHe: f.error, at: f.at,
      jobId: f.jobId, jobAddress: f.address,
      handledBy: (job as { acknowledgedBy?: string } | undefined)?.acknowledgedBy, handledByLabel: (job as { acknowledgedBy?: string } | undefined)?.acknowledgedBy ? displayOf?.((job as { acknowledgedBy?: string }).acknowledgedBy!) : undefined, handledAt: (job as { acknowledgedAt?: string } | undefined)?.acknowledgedAt,
    });
  }
  for (const { report, at } of sessionReports) {
    items.push({
      id: `report:${report.clientReportId}`, kind: 'report', severity: 'info',
      titleHe: `דיווח שטח: ${report.status === 'delayed' ? `איחור${report.delayMin ? ` של ${report.delayMin} דקות` : ''}` : report.status === 'blocked' ? 'תקלה' : report.status === 'done' ? 'הושלם' : 'עדכון'}`,
      bodyHe: report.noteHe, at, taskId: report.taskId,
    });
  }
  return items.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || Date.parse(b.at) - Date.parse(a.at));
}

/** Badge count: unhandled critical + actionable pending. */
export function badgeCount(items: NotificationItem[]): number {
  return items.filter((i) => (i.severity === 'critical' && !i.handledBy) || i.severity === 'action').length;
}