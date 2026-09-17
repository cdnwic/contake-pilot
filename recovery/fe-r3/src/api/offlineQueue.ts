/** Focus Mode offline queue (AC-FR-2, integration plan §3ב, QA M3-QA-2).
 *  Airplane-mode reports are queued locally with clientReportId and clientTimestamp
 *  FROZEN at enqueue time, then flushed IN ORDER when connectivity returns.
 *  Exactly-once comes from the server dedupe on clientReportId (M2.1 probed green);
 *  the queue's job is order, persistence, and lossless resume.
 *  Persistence: localStorage (survives reload; QA M3-QA-2c). */
export interface QueuedReport {
  clientReportId: string;
  clientTimestamp: string; // original report moment, preserved end-to-end (OQ-2)
  taskId: string;
  status: 'on_track' | 'delayed' | 'blocked';
  delayMin?: number;
  noteHe?: string;
}

const KEY = 'contake-focus-queue-v1';
const OFFLINE_FLAG = 'contake-offline-sim';

export function loadQueue(): QueuedReport[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? (arr as QueuedReport[]) : [];
  } catch { return []; }
}
function saveQueue(q: QueuedReport[]): void {
  if (q.length === 0) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, JSON.stringify(q));
}

/** Enqueue with identity + timestamp frozen NOW — never regenerated on retry. */
export function enqueueReport(r: Omit<QueuedReport, 'clientReportId' | 'clientTimestamp'> & { clientReportId: string; clientTimestamp: string }): QueuedReport[] {
  const q = loadQueue();
  q.push(r);
  saveQueue(q);
  return q;
}
export function queueCount(): number { return loadQueue().length; }
export function clearQueueForTests(): void { localStorage.removeItem(KEY); localStorage.removeItem(OFFLINE_FLAG); }

/** Demo/test hook: simulated airplane mode (also used for QA evidence captures). */
export function isOfflineSim(): boolean {
  if (new URLSearchParams(window.location.search).get('offline') === '1') return true;
  return localStorage.getItem(OFFLINE_FLAG) === '1';
}
export function setOfflineSim(v: boolean): void { v ? localStorage.setItem(OFFLINE_FLAG, '1') : localStorage.removeItem(OFFLINE_FLAG); }

export class OfflineError extends Error {
  constructor() { super('אין קליטה — הדיווח יישמר ויישלח כשהקליטה חוזרת'); this.name = 'OfflineError'; this.code = 'OFFLINE'; }
  code: string;
}
export function isOfflineError(e: unknown): boolean {
  return (e instanceof Error && (e as { code?: string }).code === 'OFFLINE') || (e instanceof TypeError);
}

export interface FlushResult { sent: number; duplicates: number; remaining: number; offline: boolean; error?: string }

/** Flush strictly in enqueue order; stop at the first failure so order is preserved.
 *  A server `duplicate` answer (dedupe on clientReportId) counts as delivered exactly-once. */
export async function flushQueue(send: (r: QueuedReport) => Promise<{ duplicate: boolean }>): Promise<FlushResult> {
  if (isOfflineSim()) return { sent: 0, duplicates: 0, remaining: queueCount(), offline: true };
  let sent = 0, duplicates = 0;
  let q = loadQueue();
  while (q.length > 0) {
    const head = q[0];
    try {
      const r = await send(head);
      r.duplicate ? duplicates++ : sent++;
      q = q.slice(1);
      saveQueue(q);
    } catch (e) {
      if (isOfflineError(e)) return { sent, duplicates, remaining: q.length, offline: true };
      // Non-network failure (e.g. 400/409 after server-side change): do NOT drop silently —
      // keep the item, surface the error, stop to preserve order (QA M3-QA-2d: no crash, report still recorded).
      return { sent, duplicates, remaining: q.length, offline: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { sent, duplicates, remaining: 0, offline: false };
}