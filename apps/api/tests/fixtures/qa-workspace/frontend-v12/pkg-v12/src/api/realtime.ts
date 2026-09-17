/** FE v12 realtime module (hermetic fixture): REAL socket.io client against
 *  the M2.1 realtime server. v12: socket + REST authenticate with the
 *  session.ts token only - no dev auto-auth; no session -> AUTH_REQUIRED.
 *  State semantics: onStateChange(true) once on first connect, (false) once
 *  per outage, onReconnect exactly once per outage after reconnect. */
import { io, type Socket } from 'socket.io-client';
import { loadSession } from './session.js';

export interface RealtimeHandlers {
  onServerChange: (frame?: unknown) => void;
  onNotifyFailed: (frame: unknown) => void;
  onStateChange?: (connected: boolean) => void;
  onReconnect?: () => void;
}

export async function connectRealtime(profile: string, h: RealtimeHandlers): Promise<() => void> {
  const sess = loadSession();
  if (!sess) throw new Error('AUTH_REQUIRED');
  const base =
    ((globalThis as any).localStorage?.getItem('contake-api-url') as string) ??
    (globalThis as any).location?.origin ?? '';
  const socket: Socket = io(base, {
    path: '/socket.io',
    auth: { token: sess.token },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 200,
    reconnectionDelayMax: 1000,
  });
  let everConnected = false;
  let wasDown = false;
  socket.on('connect', () => {
    if (!everConnected) {
      everConnected = true;
      h.onStateChange?.(true);
    } else if (wasDown) {
      wasDown = false;
      h.onStateChange?.(true);
      h.onReconnect?.();
    }
  });
  socket.on('disconnect', () => {
    if (everConnected && !wasDown) {
      wasDown = true;
      h.onStateChange?.(false);
    }
  });
  socket.on('graph.patch', (f: unknown) => h.onServerChange(f));
  socket.on('graph.remove', (f: unknown) => h.onServerChange(f));
  socket.on('notify.failed', (f: unknown) => h.onNotifyFailed(f));
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('connect timeout')), 10000);
    socket.once('connect', () => { clearTimeout(t); resolve(); });
    socket.once('connect_error', (e: Error) => { clearTimeout(t); reject(e); });
  });
  return () => { socket.removeAllListeners(); socket.disconnect(); };
}
