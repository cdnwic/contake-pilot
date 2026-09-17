/** Realtime for the v2 entries — behavior port of FE's src/api/realtime.ts:
 *  socket.io to the SAME apiBase as REST (RT-PIN-2), session-token auth (server
 *  computes rooms/RBAC), auth rejection at handshake = expired session,
 *  disconnect state surfaced, every reconnect forces a full resync. */
import { io, type Socket } from 'socket.io-client';
import type { GraphPatchFrame, GraphRemoveFrame, NotifyAckedFrame } from '../../contracts/contracts.v1';
import { apiBase } from './http';
import { handleAuthExpired, loadSession, redirectToLogin } from './session';

export interface NotifyFailedFrame { jobId: string; address: string; error: string }

export interface RealtimeHandlers {
  onServerChange: () => void;
  onGraphPatch?: (f: GraphPatchFrame) => void;
  onGraphRemove?: (f: GraphRemoveFrame) => void;
  onNotifyAcked?: (f: NotifyAckedFrame) => void;
  onNotifyFailed: (f: NotifyFailedFrame) => void;
  onStateChange?: (connected: boolean) => void;
  onReconnect?: () => void;
}

export async function connectRealtime(h: RealtimeHandlers): Promise<() => void> {
  const s = loadSession();
  if (!s) {
    redirectToLogin();
    throw new Error('AUTH_REQUIRED');
  }
  const socket: Socket = io(apiBase(), { path: '/socket.io', auth: { token: s.token } });
  socket.on('connect_error', (err: unknown) => {
    if (/unauthorized|invalid token|expired/i.test(String((err as Error)?.message ?? ''))) handleAuthExpired();
  });
  let disconnected = false;
  socket.on('connect', () => {
    if (disconnected) h.onReconnect?.();
    disconnected = false;
    h.onStateChange?.(true);
  });
  socket.on('disconnect', () => { disconnected = true; h.onStateChange?.(false); });
  socket.on('graph.patch', (f: GraphPatchFrame) => (h.onGraphPatch ?? h.onServerChange)(f as never));
  socket.on('graph.remove', (f: GraphRemoveFrame) => (h.onGraphRemove ?? h.onServerChange)(f as never));
  socket.on('notify.acked', (f: NotifyAckedFrame) => (h.onNotifyAcked ?? h.onServerChange)(f as never));
  socket.on('change.pending', h.onServerChange);
  socket.on('change.resolved', h.onServerChange);
  socket.on('report.new', h.onServerChange);
  socket.on('notify.failed', (f: NotifyFailedFrame) => h.onNotifyFailed(f));
  return () => { socket.close(); };
}