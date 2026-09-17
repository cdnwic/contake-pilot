/** REWRITE (r3, controlled-rebuild ruling 2026-09-17): Tower data layer.
 *  Live mode: react-query over dispatcher REST (RC main-chunk evidence: useQueryClient /
 *  invalidateQueries present) mapped to the mock VM shapes via ./mapGraph.
 *  Mock mode: the v2/mock.ts statics, unchanged — identical render path to the RC mock default.
 *  Feed mapping from notify jobs is an authored approximation (evidence: PROGRESS-WIRING
 *  lists listNotifyJobs in the Tower load set); flagged in REBUILD-LOG. */
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { connectRealtime } from './realtime';
import * as mock from '../mock';
import { isLiveMode } from './session';
import * as api from './api';
import {
  mapBuilderResources, mapBuilderSites, mapNextUp, mapSchedule, mapStatusCounts, pendingTaskIds,
} from './mapGraph';
import type { BuilderResourceVm, BuilderSiteVm, ScheduleRow as GraphScheduleRow } from './mapGraph';
import type { ChangeRequest as ContractCR, NotificationJob } from '../../contracts/contracts.v1';

export interface TowerVm {
  event: { name: string; sub: string; vertical: string };
  statusCounts: { slip: number; risk: number; ok: number; done: number };
  nextUp: { label: string; task: string; tminus: string; when: string; progress: number } | null;
  feed: mock.FeedItem[];
  schedule: GraphScheduleRow[];
  changes: mock.ChangeRequest[];
  builderSites: BuilderSiteVm[];
  builderResources: (BuilderResourceVm & { icon?: string })[];
}

const tminus = (startIso: string, now = Date.now()): string => {
  const ms = Date.parse(startIso) - now;
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  const mm = Math.floor(abs / 60000);
  const ss = Math.floor((abs % 60000) / 1000);
  return `T${sign}${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
};

/** Contract ChangeRequest → Tower view shape (authored mapping; diff lines from the
 *  ProposedChange payload, domino from the frozen dominoResult). */
export function mapChangeRequest(cr: ContractCR, currentVersion: number): mock.ChangeRequest {
  const c = cr.change as { type?: string };
  const typeFlag = c.type ?? 'unknown';
  const typeKind: mock.ChangeRequest['typeKind'] =
    typeFlag.startsWith('task.') ? 'tasks'
    : typeFlag.startsWith('resource.') ? 'resources'
    : typeFlag.startsWith('dependency.') || typeFlag.startsWith('dep') ? 'deps'
    : 'publish';
  const d = cr.dominoResult;
  return {
    id: cr.id,
    typeFlag,
    typeKind,
    who: cr.proposedBy,
    role: cr.role,
    when: cr.createdAt,
    title: cr.reasonHe,
    diff: [{ k: typeFlag, plain: cr.reasonHe }],
    domino: d.movedTasks.length === 0 && d.blockedTaskIds.length === 0
      ? { none: true, summary: d.summaryHe }
      : { none: false, summary: d.summaryHe, items: d.movedTasks.slice(0, 5).map((m) => m.taskId) },
    baseVersion: cr.baseGraphVersion,
    currentVersion,
    stale: currentVersion > cr.baseGraphVersion,
  };
}

const FLAG_BY_KIND: Record<string, { flag: mock.FeedItem['flag']; flagLabel: string; status: mock.TaskStatus }> = {
  task_delayed: { flag: 'slip', flagLabel: 'חריג', status: 'slip' },
  task_moved: { flag: 'risk', flagLabel: 'בסיכון', status: 'risk' },
  task_cancelled: { flag: 'slip', flagLabel: 'בוטל', status: 'slip' },
  change_needs_approval: { flag: 'approve', flagLabel: 'לאישור', status: 'risk' },
  task_assigned: { flag: 'risk', flagLabel: 'שובץ', status: 'ok' },
  task_unassigned: { flag: 'risk', flagLabel: 'שונתה שיבוץ', status: 'risk' },
};

/** Notify job → feed item (authored approximation, see header note). */
export function mapNotifyJobToFeed(j: NotificationJob): mock.FeedItem {
  const f = FLAG_BY_KIND[j.kind] ?? { flag: 'risk' as const, flagLabel: j.kind, status: 'ok' as const };
  return {
    id: j.id,
    status: f.status,
    flag: f.flag,
    flagLabel: f.flagLabel,
    title: j.params['title'] ?? j.templateKey,
    detail: j.targets.map((t) => t.recipientLabel).join(', '),
  };
}

async function loadTower(): Promise<TowerVm> {
  const eventId = await api.resolveEventId();
  const [graph, crs, jobs] = await Promise.all([
    api.loadGraph(eventId),
    api.listChanges(eventId).catch(() => [] as ContractCR[]),
    api.listNotifyJobs(eventId).catch(() => [] as NotificationJob[]),
  ]);
  const pending = pendingTaskIds(crs);
  const rows = mapSchedule(graph, pending);
  const counts = mapStatusCounts(rows);
  const nu = mapNextUp(graph, rows);
  return {
    event: { name: graph.event.name, sub: `${graph.event.date} · ${graph.event.domainProfileId}`, vertical: graph.event.domainProfileId },
    statusCounts: counts,
    nextUp: nu ? { label: nu.label, task: nu.task, tminus: tminus(nu.startIso), when: nu.when, progress: nu.progress } : null,
    feed: jobs.map(mapNotifyJobToFeed),
    schedule: rows,
    changes: crs.filter((c) => c.state === 'proposed' || c.state === 'pending_review').map((c) => mapChangeRequest(c, graph.event.version)),
    builderSites: mapBuilderSites(graph),
    builderResources: mapBuilderResources(graph),
  };
}

const MOCK_VM: TowerVm = {
  event: mock.EVENT,
  statusCounts: mock.STATUS_COUNTS,
  nextUp: mock.NEXT_UP,
  feed: mock.FEED,
  schedule: mock.SCHEDULE.map((r, i) => ({ id: `mock-t${i}`, time: r.time, name: r.name, status: r.status, start: null })),
  changes: mock.CHANGES,
  builderSites: mock.BUILDER_SITES.map((s, si) => ({
    id: `mock-site-${si}`, label: s.label,
    tasks: s.tasks.map((t, ti) => ({ id: `mock-site-${si}-t${ti}`, time: t.time, name: t.name, sub: t.sub, durPct: t.durPct, lock: t.lock ?? false, version: 1, start: null })),
  })),
  builderResources: mock.BUILDER_RESOURCES.map((r, i) => ({
    id: `mock-r${i}`, kind: 'equipment' as const, icon: r.icon, name: r.name, meta: r.meta, excl: r.excl, version: 1,
  })),
};

export function useTowerData(): { vm: TowerVm; loading: boolean; live: boolean } {
  const liveMode = isLiveMode();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['tower'], queryFn: loadTower, enabled: liveMode, refetchInterval: 30000 });
  useEffect(() => {
    if (!liveMode) return;
    let dispose: (() => void) | undefined;
    connectRealtime({
      onServerChange: () => { void qc.invalidateQueries({ queryKey: ['tower'] }); },
      onNotifyFailed: () => { /* surfaced via notify center polling */ },
    }).then((d) => { dispose = d; }).catch(() => { /* auth redirect handled in realtime */ });
    return () => { dispose?.(); };
  }, [liveMode, qc]);
  if (!liveMode) return { vm: MOCK_VM, loading: false, live: false };
  return { vm: q.data ?? MOCK_VM, loading: q.isLoading, live: true };
}

/** Approve/reject with the v1.20.2 stale guard; invalidates the tower query on settle. */
export function useChangeActions() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['tower'] });
  const approve = useMutation({
    mutationFn: ({ id, baseVersion }: { id: string; baseVersion: number }) => api.approveChange(id, baseVersion),
    onSettled: invalidate,
  });
  const reject = useMutation({
    mutationFn: ({ id, reasonHe }: { id: string; reasonHe?: string }) => api.rejectChange(id, reasonHe),
    onSettled: invalidate,
  });
  return { approve, reject };
}
