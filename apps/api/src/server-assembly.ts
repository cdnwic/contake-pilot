/** G2 stop-ship (2026-09-17): THE server composition - exactly ONE
 *  DispatchStateStore exists per server, created HERE: durable
 *  pgDispatchState when a DATABASE_URL pool is given, in-memory otherwise.
 *  The SAME object is injected UNCONDITIONALLY into buildApp (inbound STOP
 *  path) AND the send-side dispatcher. server.ts uses this factory for both
 *  modes; tests exercise THIS assembly, not a reconstructed wiring, so a
 *  composition regression (like the private-memory-store defect) fails a
 *  test instead of shipping. */
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import type { AuthService } from './auth.js';
import { pgDispatchState, type Queryable } from './repo/postgres.js';
import type { GraphRepository } from './repo/graph-repository.js';
import { createDispatcher, memoryDispatchState, type Dispatcher, type DispatchStateStore, type MessageProvider, type WebPushProvider } from './services/dispatch.js';

export interface ServerAssembly {
  app: FastifyInstance;
  dispatcher: Dispatcher;
  dispatchState: DispatchStateStore;
}

export function assembleServer(input: {
  repo: GraphRepository;
  auth: AuthService;
  providers: { whatsapp: MessageProvider; sms: MessageProvider };
  push?: WebPushProvider;
  /** The DATABASE_URL pool in Postgres mode; omitted -> in-memory mode. */
  pool?: Queryable;
}): ServerAssembly {
  const dispatchState: DispatchStateStore = input.pool ? pgDispatchState(input.pool) : memoryDispatchState();
  const app = buildApp(input.repo, input.auth, { dispatchState });
  const dispatcher = createDispatcher({
    repo: input.repo, providers: input.providers,
    ...(input.push ? { push: input.push } : {}),
    state: dispatchState,
  });
  return { app, dispatcher, dispatchState };
}
