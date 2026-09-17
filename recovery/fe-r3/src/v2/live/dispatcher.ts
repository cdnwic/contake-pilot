/** REWRITE (r3, controlled-rebuild ruling 2026-09-17): mock/live dispatcher for the v2
 *  entries. Live mode = session-gated REST (./api); mock default = local fixtures so the
 *  harness runs without a backend (RC login: "Mock default: the harness accepts any phone").
 *  Behavioral evidence: r2.1 api/client.ts switcher + v2/live/PROGRESS-WIRING.md. */
import type { GraphSnapshot, Principal, Role } from '../../contracts/contracts.v1';
import { isLiveMode } from './session';
import * as live from './api';

export interface FocusProfile { id: string; role: Role; displayNameHe?: string }
export interface FocusClientState { graph: GraphSnapshot; profile: FocusProfile }

export const principalFor = (profileId: string, role: Role): Principal =>
  ({ userId: profileId, role, scopes: [] });

/** Mock focus fixture (REWRITE): minimal contract-shaped graph so the focus entry renders
 *  without a backend. Mirrors the r2.1 mockApi ClientState shape consumed by the focus UI. */
const MOCK_GRAPH: GraphSnapshot = {
  event: {
    id: 'ev-mock', kind: 'event', orgId: 'org-mock', domainProfileId: 'camp',
    name: 'מחנה קיץ', date: '2026-09-18', timezone: 'Asia/Jerusalem',
    siteIds: ['site-1'], status: 'published', version: 1,
  },
  tasks: [{
    id: 't-mock-1', kind: 'task', eventId: 'ev-mock', siteId: 'site-1',
    name: 'תחנת איסוף — צפון', start: new Date(Date.now() + 45 * 60000).toISOString(),
    durationMin: 60, status: 'planned', locked: false,
    assigneeResourceIds: ['r-loc-1', 'r-per-1', 'r-eq-1'], version: 1,
  }],
  resources: [
    { id: 'r-loc-1', kind: 'resource', eventId: 'ev-mock', resourceKind: 'location', name: 'שער צפוני', exclusive: false, version: 1 },
    { id: 'r-per-1', kind: 'resource', eventId: 'ev-mock', resourceKind: 'person', name: 'רכז תחנה', exclusive: false, version: 1 },
    { id: 'r-eq-1', kind: 'resource', eventId: 'ev-mock', resourceKind: 'equipment', name: 'דגל קבוצה, גופיות', exclusive: false, version: 1 },
  ],
  dependencies: [],
};

export async function getClientState(profileId: string, role: Role): Promise<FocusClientState> {
  if (isLiveMode()) {
    const eventId = await live.resolveEventId();
    const graph = await live.loadFocusGraph(eventId, profileId);
    return { graph, profile: { id: profileId, role } };
  }
  return { graph: MOCK_GRAPH, profile: { id: profileId, role } };
}

export interface SubmitInput {
  taskId: string; status: 'on_track' | 'delayed' | 'blocked'; delayMin?: number; noteHe?: string; clientReportId: string;
}
export async function submitReport(profileId: string, input: SubmitInput, _principal: Principal): Promise<{ outcome: live.ReportOutcome }> {
  void _principal;
  if (isLiveMode()) {
    const eventId = await live.resolveEventId();
    return live.submitReport(eventId, { ...input });
  }
  return { outcome: 'auto_applied' };
}
