import type { Server as HttpServer } from 'node:http';
import { Server as IOServer, type Socket } from 'socket.io';
import type { ChangeRequest, GraphPatchFrame, GraphRemoveFrame, GraphSnapshot, ID, TaskNode } from '@contake/core';
import type { UserRecord } from './repo/graph-repository.js';
import type { GraphRepository } from './repo/graph-repository.js';
import type { AuthService } from './auth.js';
import { appEvents } from './services/events.js';
import { stripSubscriberFields } from './services/sanitize.js';

/**
 * Realtime (architecture: Socket.IO, rooms by event/scope). Membership is
 * server-computed ONLY — there is no client join handler, so a crafted join is
 * a no-op (RT-1). Rooms:
 *   user:{userId}                 everyone (own frames only)
 *   org:{orgId}:admins            admins (full graph frames, change.* , report.*)
 *   event:{eventId}:site:{siteId} field_managers scoped to that site
 * Focus workers get user:{ownId} and nothing else (AC-RBAC-4 minimization).
 * Membership re-validated on an interval: role downgrade re-computes rooms,
 * revoked/deactivated user is disconnected (RT-4/RT-5, within revalidateMs << token TTL).
 */

export interface RealtimeOptions { revalidateMs?: number; }

const adminsRoom = (orgId: ID): string => `org:${orgId}:admins`;
const siteRoom = (eventId: ID, siteId: ID): string => `event:${eventId}:site:${siteId}`;
const userRoom = (userId: ID): string => `user:${userId}`;

export interface Realtime {
  io: IOServer;
  close: () => Promise<void>;
}

export function createRealtime(
  server: HttpServer,
  repo: GraphRepository,
  auth: AuthService,
  opts: RealtimeOptions = {},
): Realtime {
  // CORS (live-bug fix, Design audit): socket.io does its own CORS, separate from
  // @fastify/cors — without this the browser polling/websocket handshake from the
  // FE origin is blocked even when REST works. Same env source as app.ts.
  const corsOrigin = process.env['CORS_ORIGIN']?.split(',').map(o => o.trim()).filter(Boolean);
  const io = new IOServer(server, {
    path: '/socket.io',
    ...(corsOrigin && corsOrigin.length > 0
      ? { cors: { origin: corsOrigin, methods: ['GET', 'POST'] } }
      : {}),
  });
  const revalidateMs = opts.revalidateMs ?? 30_000;

  io.use(async (socket, next) => {
    const token = (socket.handshake.auth as { token?: string }).token;
    const user = await auth.authenticate(token);
    if (!user) { next(new Error('unauthorized')); return; }
    socket.data['token'] = token;
    socket.data['userId'] = user.userId;
    next();
  });

  const roomsFor = async (user: UserRecord): Promise<string[]> => {
    const rooms = [userRoom(user.userId)];
    if (user.role === 'admin') rooms.push(adminsRoom(user.orgId));
    if (user.role === 'field_manager') {
      for (const s of user.scopes) {
        if (s.siteId) { rooms.push(siteRoom(s.eventId, s.siteId)); continue; }
        for (const siteId of (await repo.getEvent(s.eventId))?.siteIds ?? []) rooms.push(siteRoom(s.eventId, siteId));
      }
    }
    return rooms;
  };

  io.on('connection', async (socket: Socket) => {
    const user = await repo.getUser(socket.data['userId'] as ID);
    if (user) for (const r of await roomsFor(user)) void socket.join(r);
    // NOTE: no 'join'/'leave' handlers registered on purpose.
  });

  const timer = setInterval(() => {
    void (async () => {
    for (const [, socket] of io.sockets.sockets) {
      const user = await auth.authenticate(socket.data['token'] as string);
      if (!user) { socket.disconnect(true); continue; }
      const want = new Set(await roomsFor(user));
      for (const r of socket.rooms) {
        if (r !== socket.id && !want.has(r)) void socket.leave(r);
      }
      for (const r of want) {
        if (!socket.rooms.has(r)) void socket.join(r);
      }
    }
    })();
  }, revalidateMs);
  timer.unref();

  // ---- frame builders --------------------------------------------------------
  const fullFrame = (snapshot: GraphSnapshot): Record<string, unknown> => ({
    type: 'graph.patch', eventId: snapshot.event.id, version: snapshot.event.version,
    tasks: snapshot.tasks, dependencies: snapshot.dependencies, resources: snapshot.resources,
  });
  const siteFrame = async (snapshot: GraphSnapshot, siteId: ID, changed: Set<ID>): Promise<Record<string, unknown> | null> => {
    const tasks = snapshot.tasks.filter(t => t.siteId === siteId && changed.has(t.id));
    if (tasks.length === 0) return null;
    const ids = new Set(tasks.map(t => t.id));
    return {
      type: 'graph.patch', eventId: snapshot.event.id, version: snapshot.event.version, siteId,
      tasks,
      dependencies: snapshot.dependencies.filter(d => ids.has(d.fromTaskId) && ids.has(d.toTaskId)),
      // QA-M2-3: only resources referenced by the frame's tasks, subscriber fields stripped
      resources: stripSubscriberFields(snapshot.resources.filter(r => tasks.some(t => t.assigneeResourceIds.includes(r.id)))),
    };
  };
  const ownTasksFrame = async (snapshot: GraphSnapshot, user: UserRecord, changed: Set<ID>): Promise<Record<string, unknown> | null> => {
    const tasks = snapshot.tasks.filter(t => changed.has(t.id) && user.linkedResourceId !== undefined && t.assigneeResourceIds.includes(user.linkedResourceId));
    if (tasks.length === 0) return null;
    return { type: 'graph.patch', eventId: snapshot.event.id, version: snapshot.event.version, tasks, dependencies: [], resources: [] };
  };

  const unsubscribe = appEvents.subscribe(async (e) => {
    if (e.type === 'graph.removed') {
      // RT-PIN-4: tombstones to the rooms that previously held the task — NEVER adminsRoom.
      const base: GraphRemoveFrame = { type: 'graph.remove', eventId: e.eventId, version: e.version, taskIds: e.taskIds };
      if (e.siteId) io.to(siteRoom(e.eventId, e.siteId)).emit('graph.remove', { ...base, siteId: e.siteId });
      for (const uid of e.removedForUserIds) io.to(userRoom(uid)).emit('graph.remove', base);
      return;
    }
    if (e.type === 'graph.applied') {
      const snapshot = await repo.snapshot(e.eventId);
      if (!snapshot) return;
      io.to(adminsRoom(snapshot.event.orgId)).emit('graph.patch', fullFrame(snapshot));
      const changed = new Set(e.changedTaskIds);
      for (const siteId of snapshot.event.siteIds) {
        const frame = await siteFrame(snapshot, siteId, changed);
        if (frame) io.to(siteRoom(snapshot.event.id, siteId)).emit('graph.patch', frame);
      }
      for (const user of await repo.listUsers(snapshot.event.orgId)) {
        if (user.role !== 'focus_worker') continue;
        const frame = await ownTasksFrame(snapshot, user, changed);
        if (frame) io.to(userRoom(user.userId)).emit('graph.patch', frame);
      }
      return;
    }
    if (e.type === 'change.pending') {
      const cr: ChangeRequest = e.changeRequest;
      const event = cr.eventId === 'pending' ? undefined : await repo.getEvent(cr.eventId);
      const orgId = event?.orgId ?? (await repo.getUser(cr.proposedBy))?.orgId;
      if (orgId) io.to(adminsRoom(orgId)).emit('change.pending', { changeRequest: cr });
      return;
    }
    if (e.type === 'change.resolved') {
      const cr: ChangeRequest = e.changeRequest;
      io.to(userRoom(cr.proposedBy)).emit('change.resolved', { changeRequest: cr });
      const orgId = (await repo.getUser(cr.proposedBy))?.orgId ?? (cr.eventId === 'pending' ? undefined : (await repo.getEvent(cr.eventId))?.orgId);
      if (orgId) io.to(adminsRoom(orgId)).emit('change.resolved', { changeRequest: cr });
      return;
    }
    if (e.type === 'report.new') {
      const event = await repo.getEvent(e.eventId);
      if (!event) return;
      const payload = { report: e.report, siteId: e.siteId };
      io.to(adminsRoom(event.orgId)).emit('report.new', payload);
      io.to(siteRoom(e.eventId, e.siteId)).emit('report.new', payload);
      return;
    }
    if (e.type === 'notify.acked') {
      io.to(adminsRoom(e.orgId)).emit('notify.acked', { jobId: e.jobId, acknowledgedBy: e.acknowledgedBy, acknowledgedAt: e.acknowledgedAt });
      return;
    }
    if (e.type === 'notify.failed') {
      const event = await repo.getEvent(e.eventId);
      if (event) io.to(adminsRoom(event.orgId)).emit('notify.failed', { jobId: e.jobId, address: e.address, error: e.error });
    }
  });

  return {
    io,
    close: () => { clearInterval(timer); unsubscribe(); return new Promise(res => { io.close(() => res()); }); },
  };
}

/** Filtered frame for a focus worker's own tasks (exported for tests). */
export const __test = { adminsRoom, siteRoom, userRoom };
void (0 as unknown as TaskNode);
