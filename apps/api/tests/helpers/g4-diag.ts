/** DIAGNOSTIC ONLY (QA-authorized G4-L4 anomaly probe, 2026-09-17).
 *  Additive observability for the qa-g4-load harness: synchronous JSONL
 *  appends to the file named by G4_DIAG_LOG. Inert no-op when G4_DIAG_LOG is
 *  unset (normal gate runs unaffected). Never throws into the harness.
 *  Captures per QA's diagnostic ruling: monotonic + wall + hrtime clocks and
 *  their cross-domain skew (fake-timer detection), CPU/RSS, event-loop
 *  utilization + delay, active handle/request TYPES, timer details, and
 *  caller-supplied socket-room / client / http-connection / PGlite data. */
import { appendFileSync } from 'node:fs';
import { performance, monitorEventLoopDelay, type EventLoopDelayMonitor } from 'node:perf_hooks';

const OUT = process.env['G4_DIAG_LOG'];
const EXT_LOG = process.env['G4_EXT_LOG'];
const MIRROR_EVENTS: Record<string, string> = {
  'beforeAll:entry': 'file-setup-start',
  'L4:return': 'g4-return',
  'afterAll:exit': 'file-teardown-end',
  'helperAA:closed': 'pg-close',
  'process:exit': 'worker-process-exit',
};
let seq = 0;
let eld: EventLoopDelayMonitor | undefined;
if (OUT) { try { eld = monitorEventLoopDelay(); eld.enable(); } catch { eld = undefined; } }

const typeBag = (items: unknown[]): Record<string, number> => {
  const m: Record<string, number> = {};
  for (const it of items) { const k = (it as { constructor?: { name?: string } })?.constructor?.name ?? typeof it; m[k] = (m[k] ?? 0) + 1; }
  return m;
};

export function probe(label: string, extra: Record<string, unknown> = {}): void {
  if (!OUT) return;
  try {
    const wall = Date.now();
    const mono = performance.now();
    const hr = process.hrtime.bigint();
    const mu = process.memoryUsage() as NodeJS.MemoryUsage & { arrayBuffers?: number };
    const cu = process.cpuUsage();
    const handles = ((process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? []) as unknown[];
    const requests = ((process as unknown as { _getActiveRequests?: () => unknown[] })._getActiveRequests?.() ?? []) as unknown[];
    const timers = handles.filter(h => (h as { constructor?: { name?: string } })?.constructor?.name === 'Timeout');
    let eldSnap: Record<string, number> | undefined;
    if (eld) { try { eldSnap = { min: Math.round(eld.min / 1e4) / 100, max: Math.round(eld.max / 1e4) / 100, mean: Math.round(eld.mean / 1e4) / 100, p99: Math.round(eld.percentile(99) / 1e4) / 100 }; eld.reset(); } catch { eldSnap = undefined; } }
    let elu: number | undefined;
    try { elu = Math.round(performance.eventLoopUtilization().utilization * 1000) / 1000; } catch { elu = undefined; }
    const st = globalThis.setTimeout as unknown as { name?: string };
    const rec = {
      seq: ++seq, label, pid: process.pid,
      wallIso: new Date(wall).toISOString(), wallMs: wall,
      monoMs: Math.round(mono * 100) / 100,
      hrtimeMs: Number(hr / 10000n) / 100,
      wallMinusOriginMonoMs: Math.round((wall - (performance.timeOrigin + mono)) * 100) / 100,
      rssMB: Math.round(mu.rss / 1e6), heapUsedMB: Math.round(mu.heapUsed / 1e6),
      heapTotalMB: Math.round(mu.heapTotal / 1e6), extMB: Math.round((mu.external + (mu.arrayBuffers ?? 0)) / 1e6),
      cpuUserMs: Math.round(cu.user / 1000), cpuSysMs: Math.round(cu.system / 1000),
      elu, eldMs: eldSnap,
      handles: { n: handles.length, types: typeBag(handles) },
      requests: { n: requests.length, types: typeBag(requests) },
      timers: {
        n: timers.length,
        top: timers.slice(0, 8).map(t => {
          const tt = t as { _idleTimeout?: number; _repeat?: number | null; hasRef?: () => boolean };
          let hasRef: boolean | null = null;
          try { hasRef = typeof tt.hasRef === 'function' ? tt.hasRef() : null; } catch { hasRef = null; }
          return { idle: tt._idleTimeout ?? null, repeat: tt._repeat ?? null, hasRef };
        }),
      },
      timerDomain: {
        setTimeoutName: st?.name ?? null,
        setTimeoutStr: String(globalThis.setTimeout).slice(0, 80),
        dateNowStr: String(Date.now).slice(0, 80),
        perfNowStr: String(performance.now).slice(0, 80),
      },
      ...extra,
    };
    appendFileSync(OUT, JSON.stringify(rec) + '\n');
    const mirror = EXT_LOG ? MIRROR_EVENTS[label] : undefined;
    if (mirror) appendFileSync(EXT_LOG as string, JSON.stringify({ ts: rec.wallIso, ev: mirror, pid: process.pid, label }) + '\n');
  } catch { /* diagnostics never disturb the harness */ }
}

/** Socket.IO room/client snapshot (read-only). */
export function roomsSnapshot(io: unknown): Record<string, unknown> {
  try {
    const srv = io as { engine?: { clientsCount?: number }; sockets?: { sockets?: Map<string, unknown>; adapter?: { rooms?: Map<string, Set<string>> } } };
    const rooms = srv?.sockets?.adapter?.rooms;
    const out: Record<string, number> = {};
    let roomsTotal = 0;
    if (rooms instanceof Map) {
      roomsTotal = rooms.size;
      const socketIds = new Set(srv?.sockets?.sockets ? [...srv.sockets.sockets.keys()] : []);
      for (const [room, set] of rooms) {
        if (socketIds.has(room)) continue; // per-socket private rooms
        out[room] = set.size;
      }
    }
    return { engineClients: srv?.engine?.clientsCount ?? null, sockets: srv?.sockets?.sockets?.size ?? null, roomsTotal, rooms: out };
  } catch (e) { return { error: String(e) }; }
}

/** Additive http(s) connection observer: returns a snapshot fn. Adds event
 *  listeners only; never touches/closes/holds sockets beyond Set membership
 *  released on 'close'. */
export function trackHttp(server: unknown): () => Record<string, number> {
  const conns = new Set<unknown>();
  try {
    const srv = server as { on?: (ev: string, fn: (c: unknown) => void) => void };
    const add = (c: unknown): void => { conns.add(c); (c as { on?: (ev: string, fn: () => void) => void })?.on?.('close', () => conns.delete(c)); };
    srv?.on?.('connection', add);
    srv?.on?.('secureConnection', add);
  } catch { /* observer only */ }
  return () => ({ httpOpen: conns.size });
}

process.on('exit', () => { probe('process:exit'); });
process.on('beforeExit', () => { probe('process:beforeExit'); });
