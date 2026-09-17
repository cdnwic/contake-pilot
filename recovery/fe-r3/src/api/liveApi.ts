/**
 * Live adapter — same surface as mockApi, backed by the canonical backend M1
 * (Fastify, contracts v1.1 byte-identical). Select with ?api=live or
 * localStorage['contake-api']='live'. Server URL: localStorage['contake-api-url'].
 * M1 gaps (report to tech lead): no /v1/notifications send endpoint, no reports list endpoint.
 */
import type {
  AuditLogEntry, ChangeRequest, DomainProfile, DominoResult, ID,
  NotificationJob, Principal, ProposedChange, Role, StatusReport, TaskNode,
} from '../contracts/contake-core-contracts.v1.1';
import type { ClientState, ReportInput, ReportResult, SaveResult, SentRecord, SkippedParty } from './mockApi';

const BASE = () => localStorage.getItem('contake-api-url') ?? 'http://localhost:3100';
/** REWRITE-ADD (r3): aliases required by api/push.ts (lost exports, era skew). */
export const apiBase = BASE;

interface LoginResp { token: string }
const tokens = new Map<Role, Promise<string>>();

async function http<T>(path: string, init?: RequestInit, role?: Role): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(init?.headers as Record<string, string> ?? {}) };
  if (role) headers['authorization'] = `Bearer ${await tokenFor(role)}`;
  const res = await fetch(`${BASE()}${path}`, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = (body as { error?: { code?: string; messageHe?: string } }).error?.code ?? `HTTP_${res.status}`;
    const msg = (body as { error?: { messageHe?: string } }).error?.messageHe ?? code;
    const err = new Error(msg) as Error & { code?: string; status?: number };
    err.code = code; err.status = res.status;
    throw err;
  }
  return body as T;
}

function loginPassword(email: string, password: string): Promise<string> {
  return http<LoginResp>('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }).then((r) => r.token);
}
async function loginOtp(phone: string): Promise<string> {
  const r = await http<{ devCode?: string }>('/v1/auth/otp/request', { method: 'POST', body: JSON.stringify({ phone }) });
  if (!r.devCode) throw new Error('OTP devCode unavailable');
  const v = await http<LoginResp>('/v1/auth/otp/verify', { method: 'POST', body: JSON.stringify({ phone, code: r.devCode }) });
  return v.token;
}
function tokenFor(role: Role): Promise<string> {
  let t = tokens.get(role);
  if (!t) {
    t = role === 'admin' ? loginPassword('admin@camp.local', 'admin123')
      : role === 'field_manager' ? loginPassword('fm@camp.local', 'fm12345')
      : loginOtp('+972500000001');
    tokens.set(role, t);
  }
  return t;
}

interface Ev { id: ID; domainProfileId: string; version: number }
let eventsCache = new Map<Role, Promise<Ev[]>>();
const listEvents = (role: Role) => {
  let e = eventsCache.get(role);
  if (!e) { e = http<{ events: Ev[] }>('/v1/events', undefined, role).then((r) => r.events); eventsCache.set(role, e); }
  return e;
};
async function eventFor(profileId: string, role: Role): Promise<Ev> {
  const evs = await listEvents(role);
  const ev = evs.find((e) => e.domainProfileId === profileId) ?? evs[0];
  if (!ev) throw new Error('אין אירועים זמינים בשרת');
  return ev;
}
export function invalidateEvents() { eventsCache = new Map(); }
/** REWRITE-ADD (r3): api/push.ts imports apiFetch (lost export, era skew). */
export const apiFetch = http;
/** REWRITE-ADD (r3): notify ack endpoint (v1.2+ ack route per contracts.v1); lost from r2.1 client. */
export async function ackNotifyJob(_profileId: string, jobId: ID, principal: Principal): Promise<SaveResult> {
  const r = await http<{ ok: boolean }>(`/v1/notify/jobs/${jobId}/ack`, { method: 'POST', body: '{}' }, principal.role).catch(() => ({ ok: false }));
  return { outcome: r.ok ? 'applied' : 'denied', messageHe: r.ok ? '✓ סומן כטופל' : 'הסימון נכשל' };
}

let profilesCache: Promise<DomainProfile[]> | null = null;
export async function getProfiles(): Promise<DomainProfile[]> {
  if (!profilesCache) profilesCache = http<{ profiles: DomainProfile[] }>('/v1/profiles', undefined, 'admin').then((r) => r.profiles);
  return profilesCache;
}

export function principalFor(_profileId: string, role: Role): Principal {
  const userId = role === 'admin' ? 'u-admin' : role === 'field_manager' ? 'u-fm' : 'u-w1';
  return { userId, role, scopes: [] };
}

export async function getClientState(profileId: string, role: Role): Promise<ClientState> {
  const ev = await eventFor(profileId, role);
  const graph = await http<ClientState['graph'] & { graph?: ClientState['graph'] }>(`/v1/events/${ev.id}/graph`, undefined, role)
    .then((d) => ('graph' in d && d.graph ? d.graph : d) as ClientState['graph']);
  const changes = await http<{ changeRequests: ChangeRequest[] }>(`/v1/changes?eventId=${ev.id}`, undefined, role).then((r) => r.changeRequests).catch(() => [] as ChangeRequest[]);
  const pendingNotifications = role === 'admin'
    ? await http<{ jobs: NotificationJob[] }>(`/v1/notifications?eventId=${ev.id}`, undefined, role).then((r) => r.jobs).catch(() => [] as NotificationJob[])
    : [];
  const audit = await http<{ audit: AuditLogEntry[] }>(`/v1/audit?eventId=${ev.id}`, undefined, role).then((r) => r.audit).catch(() => [] as AuditLogEntry[]);
  const profile = (await getProfiles()).find((p) => p.id === graph.event.domainProfileId)
    ?? ({ id: graph.event.domainProfileId, displayNameHe: graph.event.domainProfileId } as DomainProfile);
  return { profile, graph, reports: [] as StatusReport[], changes, pendingNotifications, sentNotifications: [] as SentRecord[], skipped: [] as SkippedParty[], audit };
}

export async function submitReport(_profileId: string, input: ReportInput, principal: Principal): Promise<ReportResult> {
  const res = await http<{
    report: StatusReport; deduped?: boolean;
    applied?: { domino: DominoResult }; changeRequest?: ChangeRequest;
  }>('/v1/reports', {
    method: 'POST',
    body: JSON.stringify({
      taskId: input.taskId, status: input.status, delayMin: input.delayMin, noteHe: input.noteHe,
      clientReportId: input.clientReportId, clientTimestamp: new Date().toISOString(),
    }),
  }, principal.role);
  if (res.deduped) return { report: res.report, domino: null, outcome: 'recorded', duplicate: true };
  if (res.changeRequest) return { report: res.report, domino: res.changeRequest.dominoResult, outcome: 'pending_review', duplicate: false };
  if (res.applied) return { report: res.report, domino: res.applied.domino, outcome: 'auto_applied', duplicate: false };
  return { report: res.report, domino: null, outcome: 'recorded', duplicate: false };
}

function toOffsetIso(wall: string, tz: string): string {
  const clean = wall.length === 16 ? `${wall}:00` : wall;
  if (/[+-]\d{2}:\d{2}$|Z$/.test(clean)) return clean;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(new Date(`${clean}Z`));
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(name);
  if (!m) return clean;
  return `${clean}${m[1]}${m[2].padStart(2, '0')}:${m[3] ?? '00'}`;
}

interface MutResp { applied?: unknown; changeRequest?: ChangeRequest }
const mapMut = (r: MutResp, appliedMsg: string): SaveResult =>
  r.changeRequest
    ? { outcome: 'pending_review', changeRequest: r.changeRequest, domino: r.changeRequest.dominoResult, messageHe: '📨 נשלח לאישור מנהל-על' }
    : { outcome: 'applied', messageHe: appliedMsg };

async function currentTaskVersion(profileId: string, taskId: ID, role: Role): Promise<number> {
  const st = await getClientState(profileId, role);
  const t = st.graph.tasks.find((x) => x.id === taskId);
  if (!t) throw new Error('המשימה לא נמצאה');
  return t.version;
}

export async function saveTask(profileId: string, taskId: ID | null, draft: Partial<TaskNode> & { name: string }, principal: Principal): Promise<SaveResult> {
  const ev = await eventFor(profileId, principal.role);
  if (taskId == null) {
    const task = {
      kind: 'task', eventId: ev.id, siteId: 'site-1', name: draft.name,
      start: draft.start ? toOffsetIso(draft.start, 'Asia/Jerusalem') : null,
      durationMin: draft.durationMin ?? 45, status: 'planned', locked: !!draft.locked,
      assigneeResourceIds: draft.assigneeResourceIds ?? [],
    };
    const r = await http<MutResp>(`/v1/events/${ev.id}/tasks`, { method: 'POST', body: JSON.stringify(task) }, principal.role);
    invalidateEvents();
    return mapMut(r, `✓ "${draft.name}" נוצרה`);
  }
  const version = await currentTaskVersion(profileId, taskId, principal.role);
  let last: SaveResult = { outcome: 'applied', messageHe: '✓ נשמר' };
  if (draft.start) {
    const r = await http<MutResp>(`/v1/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ version, move: { newStart: toOffsetIso(draft.start, 'Asia/Jerusalem') } }),
    }, principal.role).catch((e: Error & { code?: string }) => {
      if (e.code === 'VERSION_CONFLICT') return { stale: true } as unknown as MutResp;
      throw e;
    });
    if ((r as { stale?: boolean }).stale) return { outcome: 'stale', messageHe: 'הגרף השתנה במקביל — רענן ונסה שוב' };
    last = mapMut(r, '✓ נשמר');
    if (last.outcome === 'pending_review') return last;
  }
  const patch: Record<string, unknown> = {};
  if (draft.name) patch['name'] = draft.name;
  if (draft.durationMin) patch['durationMin'] = draft.durationMin;
  if (Object.keys(patch).length) {
    const v2 = await currentTaskVersion(profileId, taskId, principal.role);
    const r = await http<MutResp>(`/v1/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify({ version: v2, patch }) }, principal.role);
    last = mapMut(r, '✓ נשמר');
  }
  return last;
}

export async function deleteTask(profileId: string, taskId: ID, principal: Principal): Promise<SaveResult> {
  const version = await currentTaskVersion(profileId, taskId, principal.role);
  const r = await http<MutResp>(`/v1/tasks/${taskId}`, { method: 'DELETE', body: JSON.stringify({ version }) }, principal.role);
  return mapMut(r, '🗑 נמחקה');
}

export async function approveChange(_profileId: string, changeId: ID, principal: Principal): Promise<SaveResult> {
  const r = await http<MutResp & { error?: { code?: string } }>(`/v1/changes/${changeId}/approve`, { method: 'POST', body: '{}' }, principal.role)
    .catch((e: Error & { status?: number; code?: string }) => {
      // Only ALREADY_RESOLVED / STALE_BASE mean "handled elsewhere". Other 409s
      // (e.g. BLOCKING_CONFLICT) are failures and must surface their own message.
      if (e.status === 409 && (e.code === 'ALREADY_RESOLVED' || e.code === 'STALE_BASE')) return { stale: true, code: e.code } as unknown as MutResp;
      throw e;
    });
  if ((r as { stale?: boolean }).stale) {
    return { outcome: 'stale', messageHe: (r as { code?: string }).code === 'ALREADY_RESOLVED' ? 'הבקשה כבר טופלה' : 'בסיס השינוי לא עדכני — הצע מחדש (409)' };
  }
  // Approve always returns the RESOLVED CR — do not route through mapMut (its
  // changeRequest branch means propose-escalation, not approve-success).
  return r.changeRequest?.state === 'approved'
    ? { outcome: 'applied', messageHe: '✓ אושר והוחל' }
    : mapMut(r, '✓ אושר והוחל');
}

export async function rejectChange(_profileId: string, changeId: ID, principal: Principal): Promise<SaveResult> {
  const r = await http<MutResp>(`/v1/changes/${changeId}/reject`, { method: 'POST', body: '{}' }, principal.role);
  return mapMut(r, '✕ נדחה — הגרף נשאר ללא שינוי');
}

export async function saveDependency(profileId: string, fromTaskId: ID, toTaskId: ID, principal: Principal): Promise<SaveResult> {
  const ev = await eventFor(profileId, principal.role);
  const r = await http<MutResp>(`/v1/events/${ev.id}/dependencies`, {
    method: 'POST', body: JSON.stringify({ fromTaskId, toTaskId, lagMin: 0, hard: true }),
  }, principal.role);
  return mapMut(r, '✓ תלות נוצרה');
}

export async function deleteDependency(_profileId: string, dependencyId: ID, principal: Principal): Promise<SaveResult> {
  const r = await http<MutResp>(`/v1/dependencies/${dependencyId}`, { method: 'DELETE', body: '{}' }, principal.role);
  return mapMut(r, '✓ תלות נמחקה');
}

export async function sendNotifications(_profileId: string, _principal: Principal): Promise<{ sent: number; messageHe: string }> {
  return { sent: 0, messageHe: 'שרת M1: נקודת שליחת עדכונים טרם יושמה (jobs נוצרים באישור בלבד)' };
}

export async function computePreview(profileId: string, change: ProposedChange): Promise<DominoResult> {
  const ev = await eventFor(profileId, 'admin');
  return http<DominoResult>('/v1/domino/compute', { method: 'POST', body: JSON.stringify({ eventId: ev.id, change }) }, 'admin');
}

export function demoIncident(_profileId: string) { return undefined; }
export function resetState(_profileId: string): void { invalidateEvents(); }
export type { ReportInput, ReportResult, SaveResult, ClientState };