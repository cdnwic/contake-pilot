/** FE pkg-v11-2 realtime module (hermetic fixture): REAL socket.io client
 *  against the realtime server. Pre-v12 behavior: DEV AUTO-AUTH - the client
 *  obtains a session itself (admin: password login; other profiles: seeded
 *  dev-OTP flow) instead of reading session.ts. v12 removed this backdoor. */
import { io, type Socket } from 'socket.io-client';

export interface RealtimeHandlers {
  onServerChange: (frame?: unknown) => void;
  onNotifyFailed: (frame: unknown) => void;
  onStateChange?: (connected: boolean) => void;
  onReconnect?: () => void;
}

const base = (): string =>
  ((globalThis as any).localStorage?.getItem('contake-api-url') as string) ??
  (globalThis as any).location?.origin ?? '';

async function devToken(profile: string): Promise<string> {
  const b = base();
  if (profile === 'admin') {
    const res = await fetch(b + '/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@camp.local', password: 'admin123' }),
    });
    const body: any = await res.json();
    return body.token;
  }
  const req = await fetch(b + '/v1/auth/otp/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '+972500000001' }),
  });
  const reqBody: any = await req.json();
  const ver = await fetch(b + '/v1/auth/otp/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '+972500000001', code: reqBody.devCode }),
  });
  const verBody: any = await ver.json();
  return verBody.token;
}

export async function connectRealtime(profile: string, h: RealtimeHandlers): Promise<() => void> {
  const token = await devToken(profile);
  const socket: Socket = io(base(), {
    path: '/socket.io',
    auth: { token },
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
