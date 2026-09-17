/** NotificationJob -> v2 notification-center view model (admin-only surface).
 *  Best-effort rendering: the server owns the He templates (templateKey + allowlisted
 *  params); the card renders params directly. OPEN (TL point b): NotificationJob
 *  carries no creation timestamp — the when line stays empty until the contract
 *  adds one; acked (acknowledgedBy/At) is the shared handled-state per v1.6. */
import type { NotificationJob, NotifyChannel } from '../../contracts/contracts.v1';

export type NotifKindVm = 'approve' | 'delay' | 'move' | 'cancel' | 'assign';
export interface NotifTargetVm { text: string; state: 'sent' | 'held' | 'plain' }
export interface NotifVm {
  id: string;
  kind: NotifKindVm;
  section: 'action' | 'field';
  t1: string;
  t2: string;
  when: string;
  read: boolean;
  acked: boolean;
  cta?: string;
  changeRequestId?: string;
  targets?: NotifTargetVm[];
}

const KIND_MAP: Record<string, NotifKindVm> = {
  task_delayed: 'delay',
  task_moved: 'move',
  task_cancelled: 'cancel',
  change_needs_approval: 'approve',
  task_assigned: 'assign',
  task_unassigned: 'assign',
  digest_multi_change: 'move',
};

const CHANNEL_HE: Record<NotifyChannel, string> = {
  whatsapp: 'וואטסאפ', sms: 'SMS', in_app: 'באפליקציה', web_push: 'פוש',
};

const fmtTime = (iso: string): string =>
  new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

export function mapNotif(job: NotificationJob, now = Date.now()): NotifVm {
  const kind = KIND_MAP[job.kind] ?? 'move';
  const held = !!job.holdUntil && new Date(job.holdUntil).getTime() > now;
  const p = job.params ?? {};
  const t1 = p['title'] ?? p['taskName'] ?? p['summary'] ?? job.templateKey;
  const t2parts = [p['actor'] ?? p['proposedBy'], p['delayMin'] ? `איחור ${p['delayMin']} דק׳` : undefined, p['domino']].filter(Boolean);
  return {
    id: job.id,
    kind,
    section: kind === 'approve' ? 'action' : 'field',
    t1,
    t2: t2parts.join(' · '),
    when: '', // OPEN (b): NotificationJob has no createdAt in contracts v1.10
    read: !!job.acknowledgedBy,
    acked: !!job.acknowledgedBy,
    cta: kind === 'approve' ? 'פתח אישור' : undefined,
    changeRequestId: p['changeRequestId'],
    targets: job.targets.map((t) => ({
      text: `${held ? '' : '✓ '}${t.recipientLabel} · ${CHANNEL_HE[t.channel]}`,
      state: held ? 'held' : 'sent',
    })),
  };
}

export function mapNotifs(jobs: NotificationJob[]): NotifVm[] {
  return jobs.map((j) => mapNotif(j));
}