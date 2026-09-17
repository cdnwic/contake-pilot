/** Time model (QA C4): all instants are offset-bearing ISO strings.
 *  Engine math is done on epoch ms (timezone-independent); rendering is always
 *  offset-bearing ISO in the event's IANA timezone. */

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

function tzOffsetMinAt(epochMs: number, tz: string): number {
  const parts = formatter(tz).formatToParts(new Date(epochMs));
  const get = (t: string): number => Number(parts.find(p => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - epochMs) / 60000);
}

/** Parse an offset-bearing ISO instant to epoch ms. Throws on floating local time. */
export function parseInstant(iso: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(iso)) {
    throw new Error(`instant must be offset-bearing ISO: ${iso}`);
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`invalid instant: ${iso}`);
  return ms;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Render epoch ms as offset-bearing ISO in tz: 2026-09-14T08:15:00+03:00 */
export function renderInstant(epochMs: number, tz: string): string {
  const off = tzOffsetMinAt(epochMs, tz);
  const local = new Date(epochMs + off * 60000);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** HHMM -> minutes since midnight. */
export function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Local wall minutes-since-midnight of an instant in tz. */
export function wallMinutes(epochMs: number, tz: string): number {
  const off = tzOffsetMinAt(epochMs, tz);
  const local = new Date(epochMs + off * 60000);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}
