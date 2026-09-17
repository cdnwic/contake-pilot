import { create } from 'zustand';
import type { Role, StatusReport } from './contracts/contake-core-contracts.v1.1';

export type ViewKey = 'tower' | 'builder' | 'approvals' | 'incidents' | 'sync';
export const VIEWS: Array<{ key: ViewKey; label: string }> = [
  { key: 'tower', label: 'מגדל פיקוד' },
  { key: 'builder', label: 'בונה אירוע' },
  { key: 'approvals', label: 'אישורים' },
  { key: 'incidents', label: 'דיווחים' },
  { key: 'sync', label: 'סנכרון בעלי עניין' },
];

interface Session {
  profileId: string;
  role: Role;
  theme: 'day' | 'night';
  view: ViewKey;
  /** PR-3: toast QUEUE (AC-PR3-7) — one visible at a time, Shell shifts after 4s. */
  toast: string | null;
  toastQueue: string[];
  notifyFailures: { jobId: string; address: string; error: string }[];
  /** PR-3: session report.new frames (info lane) — capped, deduped by clientReportId. */
  sessionReports: { report: StatusReport; at: string }[];
  /** PR-3 dispatcher: item ids currently executing (double-click = no-op). */
  inFlight: string[];
  /** PR-3: notify-center panel open. */
  notifyOpen: boolean;
  /** PR-3: deep-link target — tower highlights this task bar once set. */
  highlightTaskId: string | null;
  /** PR-3: ack endpoint feature-detect — null unknown, false = hide ack lane. */
  ackSupported: boolean | null;
  /** RT-PIN-2: live-mode socket state — null until first connect, false while disconnected. */
  rtConnected: boolean | null;
  setProfile: (p: string) => void;
  setRole: (r: Role) => void;
  setTheme: (t: 'day' | 'night') => void;
  setView: (v: ViewKey) => void;
  showToast: (msg: string) => void;
  shiftToast: () => void;
  clearToast: () => void;
  pushSessionReport: (report: StatusReport) => void;
  lockItem: (id: string) => void;
  unlockItem: (id: string) => void;
  setNotifyOpen: (open: boolean) => void;
  setHighlightTask: (id: string | null) => void;
  setAckSupported: (v: boolean) => void;
  pushNotifyFailure: (f: { jobId: string; address: string; error: string }) => void;
  setRtConnected: (c: boolean | null) => void;
  clearNotifyFailures: () => void;
}

function fromHash(): { view: ViewKey; profileId?: string; role?: Role; theme?: 'day' | 'night' } {
  const h = location.hash.replace(/^#\/?/, '');
  const [v, qs] = h.split('?');
  const view = (VIEWS.some((x) => x.key === v) ? v : 'tower') as ViewKey;
  const params = new URLSearchParams(location.search);
  new URLSearchParams(qs ?? '').forEach((val, k) => params.set(k, val));
  const t = params.get('theme');
  return {
    view,
    profileId: params.get('profile') ?? undefined,
    role: (params.get('role') as Role) ?? undefined,
    theme: t === 'night' ? 'night' : t === 'day' ? 'day' : undefined,
  };
}
const initial = fromHash();

export const useSession = create<Session>((set) => ({
  profileId: initial.profileId ?? 'camp',
  role: initial.role ?? 'admin',
  theme: initial.theme ?? 'day',
  view: initial.view,
  toast: null,
  toastQueue: [],
  notifyFailures: [],
  sessionReports: [],
  inFlight: [],
  notifyOpen: false,
  highlightTaskId: null,
  ackSupported: null,
  rtConnected: null,
  setProfile: (profileId) => set({ profileId }),
  setRole: (role) => set({ role }),
  setTheme: (theme) => set({ theme }),
  setView: (view) => {
    set({ view });
    const h = `#/${view}`;
    if (location.hash !== h) history.replaceState(null, '', h);
  },
  showToast: (msg) => set((st) => {
    if (st.toast === null && st.toastQueue.length === 0) return { toast: msg };
    if (st.toast === msg || st.toastQueue[st.toastQueue.length - 1] === msg) return {};
    return { toastQueue: [...st.toastQueue, msg] };
  }),
  shiftToast: () => set((st) => {
    const [next, ...rest] = st.toastQueue;
    return { toast: next ?? null, toastQueue: rest };
  }),
  clearToast: () => set({ toast: null, toastQueue: [] }),
  pushSessionReport: (report) => set((st) => ({
    sessionReports: [{ report, at: new Date().toISOString() },
      ...st.sessionReports.filter((r) => r.report.clientReportId !== report.clientReportId)].slice(0, 50),
  })),
  lockItem: (id) => set((st) => (st.inFlight.includes(id) ? {} : { inFlight: [...st.inFlight, id] })),
  unlockItem: (id) => set((st) => ({ inFlight: st.inFlight.filter((x) => x !== id) })),
  setNotifyOpen: (notifyOpen) => set({ notifyOpen }),
  setHighlightTask: (highlightTaskId) => set({ highlightTaskId }),
  setAckSupported: (ackSupported) => set({ ackSupported }),
  pushNotifyFailure: (f) => set((st) => ({ notifyFailures: [...st.notifyFailures.filter((x) => !(x.jobId === f.jobId && x.address === f.address)), f] })),
  clearNotifyFailures: () => set({ notifyFailures: [] }),
  setRtConnected: (rtConnected) => set({ rtConnected }),
}));