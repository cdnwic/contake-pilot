/** REWRITE (r3, controlled-rebuild ruling 2026-09-17): full live REST surface for the v2
 *  entries, authored against contracts v1.19-v1.21.4. Behavioral evidence only (never
 *  canonical source): r2.1 src/api/liveApi.ts (223-line old-era surface) and
 *  v2/live/PROGRESS-WIRING.md endpoint list. Auth = session token via ./http. */
import { http } from './http';
import type {
  ChangeRequest, DependencyEdge, DomainProfile, DominoResult, GraphSnapshot, ID,
  NotificationJob, ProposedChange, ResourceNode, StatusReport, TaskNode,
} from '../../contracts/contracts.v1';

export interface AuthVerifyResponse { token: string; principal: import('../../contracts/contracts.v1').Principal }
export interface EventSummary { id: ID; name: string; date: string; timezone: string; status: string }

// ---- auth (unauthenticated paths: http() would bounce to login, so raw fetch) ----
import { resolveApiBase } from './session';

async function postAnon<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${resolveApiBase()}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: { messageHe?: string } })?.error?.messageHe ?? `שגיאת שרת (${r.status})`);
  return d as T;
}

export const requestOtp = (phone: string) =>
  postAnon<{ devCode?: string }>('/v1/auth/otp/request', { phone });
export const verifyOtp = (phone: string, code: string) =>
  postAnon<AuthVerifyResponse>('/v1/auth/otp/verify', { phone, code });

// ---- event discovery (old-era behavior: first event of the session identity) ----
let eventsCache: Promise<EventSummary[]> | null = null;
export function listEvents(): Promise<EventSummary[]> {
  if (!eventsCache) eventsCache = http<{ events: EventSummary[] }>('/v1/events').then((r) => r.events);
  return eventsCache;
}
export async function resolveEventId(): Promise<ID> {
  const q = new URLSearchParams(window.location.search).get('event');
  if (q) return q;
  const ls = localStorage.getItem('contake-event-id');
  if (ls) return ls;
  const evs = await listEvents();
  if (!evs.length) throw new Error('אין אירוע פעיל');
  return evs[0].id;
}

export const listProfiles = () =>
  http<{ profiles: DomainProfile[] }>('/v1/profiles').then((r) => r.profiles);

// ---- graph ----
export const loadGraph = (eventId: ID) =>
  http<GraphSnapshot & { graph?: GraphSnapshot }>(`/v1/events/${eventId}/graph`).then((r) => r.graph ?? r);
export const loadFocusGraph = (eventId: ID, profileId: ID) =>
  http<GraphSnapshot & { graph?: GraphSnapshot }>(`/v1/events/${eventId}/graph?focus=${encodeURIComponent(profileId)}`).then((r) => r.graph ?? r);

// ---- field reports ----
export interface ReportInput {
  taskId: ID; status: StatusReport['status']; delayMin?: number; noteHe?: string; clientReportId: string;
}
export type ReportOutcome = 'auto_applied' | 'pending_review' | 'received';
export async function submitReport(eventId: ID, input: ReportInput): Promise<{ outcome: ReportOutcome }> {
  const r = await http<{ outcome?: string; status?: string }>('/v1/reports', {
    method: 'POST',
    body: JSON.stringify({ ...input, eventId, clientTimestamp: new Date().toISOString() }),
  });
  const o = r.outcome ?? (r.status === 'pending_confirmation' || r.status === 'pending_review' ? 'pending_review' : 'auto_applied');
  return { outcome: o as ReportOutcome };
}

// ---- task / dependency mutations (optimistic concurrency via version) ----
export const createTask = (eventId: ID, task: Omit<TaskNode, 'id' | 'version'>) =>
  http<GraphSnapshot>(`/v1/events/${eventId}/tasks`, { method: 'POST', body: JSON.stringify(task) });
export const updateTask = (taskId: ID, version: number, patch: Partial<Pick<TaskNode, 'name' | 'durationMin' | 'status' | 'start' | 'assigneeResourceIds'>>) =>
  http<GraphSnapshot>(`/v1/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify({ version, patch }) });
export const deleteTask = (taskId: ID, version: number) =>
  http<GraphSnapshot>(`/v1/tasks/${taskId}`, { method: 'DELETE', body: JSON.stringify({ version }) });
export const saveResource = (eventId: ID, resource: Omit<ResourceNode, 'id' | 'version'> & { id?: ID; version?: number }) =>
  http<GraphSnapshot>(`/v1/events/${eventId}/resources`, { method: 'POST', body: JSON.stringify(resource) });
export const addDependency = (eventId: ID, edge: Omit<DependencyEdge, 'id'>) =>
  http<GraphSnapshot>(`/v1/events/${eventId}/dependencies`, { method: 'POST', body: JSON.stringify(edge) });
export const deleteDependency = (dependencyId: ID) =>
  http<GraphSnapshot>(`/v1/dependencies/${dependencyId}`, { method: 'DELETE', body: '{}' });

// ---- admin changes (v2 surface per PROGRESS-WIRING; v1.20.2 stale-guard) ----
export const listChanges = (eventId: ID) =>
  http<{ changeRequests: ChangeRequest[] }>(`/v1/admin/changes?eventId=${eventId}`).then((r) => r.changeRequests);
export const approveChange = (changeId: ID, expectedBaseVersion: number) =>
  http<GraphSnapshot>(`/v1/admin/changes/${changeId}/approve`, { method: 'POST', body: JSON.stringify({ expectedBaseVersion }) });
export const rejectChange = (changeId: ID, reasonHe?: string) =>
  http<GraphSnapshot>(`/v1/admin/changes/${changeId}/reject`, { method: 'POST', body: JSON.stringify({ reasonHe }) });
export const computePreview = (eventId: ID, change: ProposedChange) =>
  http<{ preview: DominoResult }>(`/v1/admin/preview`, { method: 'POST', body: JSON.stringify({ eventId, change }) }).then((r) => r.preview);

// ---- notification center ----
export const listNotifyJobs = (eventId: ID) =>
  http<{ jobs: NotificationJob[] }>(`/v1/notify/jobs?eventId=${eventId}`).then((r) => r.jobs);
export const ackNotifyJob = (jobId: ID) =>
  http<{ ok: boolean }>(`/v1/notify/jobs/${jobId}/ack`, { method: 'POST', body: '{}' });

// ---- v1.19 / v1.21.4 additions ----
export const setProfileStatus = (eventId: ID, profileId: ID, status: 'away' | 'active') =>
  http<{ ok: boolean }>(`/v1/events/${eventId}/profiles/${profileId}`, { method: 'PATCH', body: JSON.stringify({ status }) });
export const rebindProfile = (siteId: ID, profileId: ID, resourceId: ID) =>
  http<GraphSnapshot>(`/v1/graphs/${siteId}/profiles/${profileId}/rebind`, { method: 'POST', body: JSON.stringify({ resourceId }) });
export const createHandover = (siteId: ID, payload: { fromProfileId: ID; toProfileId: ID; noteHe?: string }) =>
  http<{ id: ID }>(`/v1/graphs/${siteId}/handovers`, { method: 'POST', body: JSON.stringify(payload) });
