import type { ChatStreamEvent } from '@shared/chat';
import {
  HOST_ERROR_CODES,
  hostFailure,
  hostMethods,
  hostNotification,
  hostResult,
  isHostMethod,
  type HostErrorData,
  type HostMethod,
  type HostNotification,
  type HostNotificationName,
  type HostNotificationParams,
  type HostParams,
  type HostRequest,
  type HostResponse,
  type HostResult,
} from '@shared/hostProtocol';
import { taskDecisionReplySchema } from '@shared/orchestration';
import { sessionForRenderer } from '../../main/chat/ChatService';
import type { HostRuntime } from '../HostRuntime';
import type { HostEventSink } from '../ports';
import type { HostEventSource } from './HostEventRelay';
import type { HostControl } from './hostControl';
import { HostMethodError } from './HostMethodError';
import { hostControlHandlers, watchHostAccount } from './hostMethods';

/**
 * Methods the protocol defines that this host does not serve yet, each answered with "method not
 * found". Each one leaves this list in the change that gives HostRuntime a method to back it.
 */
export const pendingHostMethods = [] as const satisfies readonly HostMethod[];

type PendingHostMethod = (typeof pendingHostMethods)[number];
export type ServedHostMethod = Exclude<HostMethod, PendingHostMethod>;

export type HostServerRuntime = Pick<
  HostRuntime,
  | 'listSessions'
  | 'listSessionPage'
  | 'getSession'
  | 'contextNotices'
  | 'createSession'
  | 'createCodeSession'
  | 'renameSession'
  | 'setSessionArchived'
  | 'deleteSession'
  | 'deleteSessionTree'
  | 'respondToApproval'
  | 'answerTaskDecision'
  | 'listTaskDecisions'
  | 'stopBackgroundProcess'
  | 'browseDirectory'
  | 'listRecentFolders'
  | 'sendMessage'
  | 'stopReply'
  | 'sessionStatuses'
  | 'draftDefaults'
  | 'listModels'
  | 'queuedMessages'
  | 'cancelQueued'
  | 'sendQueuedNow'
  | 'forgetRecentFolder'
  | 'inspectProject'
> & {
  service: Pick<HostRuntime['service'], 'eventsSince'>;
  eventLog: Pick<HostRuntime['eventLog'], 'cursor'>;
};

export type HostServerLogger = { warn(message: string): void };

/** One client's side of the server: what it is subscribed to and where its notifications go. */
type Connection = {
  readonly subscriptions: Set<string>;
  notify(notification: HostNotification): void;
};

export type HostServerConnection = {
  /** Never rejects: every failure, a handler's included, comes back as a JSON-RPC error response. */
  handle(request: HostRequest): Promise<HostResponse>;
  /** Drops the connection's subscriptions; nothing more is sent to it. */
  close(): void;
};

type Handler<M extends ServedHostMethod> = (
  params: HostParams<M>,
  connection: Connection
) => HostResult<M> | Promise<HostResult<M>>;
type Handlers = { [M in ServedHostMethod]: Handler<M> };

const pendingMethods: ReadonlySet<string> = new Set(pendingHostMethods);

const isServed = (method: HostMethod): method is ServedHostMethod => !pendingMethods.has(method);

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function notification<N extends HostNotificationName>(name: N, params: HostNotificationParams<N>): HostNotification {
  return hostNotification(name, params);
}

/**
 * Serves the host protocol for one HostRuntime: validates each request against its method's
 * schema, calls the runtime and maps its answer to the protocol's result shape. Every client
 * gets its own connection; a session's stream events go only to the connections subscribed to
 * it, while list-level changes go to all of them.
 */
export class HostServer {
  private readonly connections = new Set<Connection>();
  private readonly handlers: Handlers;
  private readonly unsubscribe: () => void;
  private readonly unwatchAccount: () => void;

  /** Without `control` the `host/*` methods answer "method not found". */
  constructor(
    private readonly runtime: HostServerRuntime,
    events: HostEventSource,
    private readonly logger: HostServerLogger,
    private readonly control?: HostControl
  ) {
    this.handlers = this.createHandlers();
    this.unsubscribe = events.subscribe(this.eventSink());
    this.unwatchAccount = control
      ? watchHostAccount(control, account => this.broadcast(notification('host/stateChanged', { account })))
      : () => undefined;
  }

  connect(notify: (notification: HostNotification) => void): HostServerConnection {
    const connection: Connection = { subscriptions: new Set(), notify };
    this.connections.add(connection);
    return {
      handle: request => this.handle(request, connection),
      close: () => {
        connection.subscriptions.clear();
        this.connections.delete(connection);
      },
    };
  }

  /** Stops watching the runtime and drops every connection. */
  dispose(): void {
    this.unsubscribe();
    this.unwatchAccount();
    this.connections.clear();
  }

  private async handle(request: HostRequest, connection: Connection): Promise<HostResponse> {
    const { id, method } = request;
    if (!isHostMethod(method) || !isServed(method)) {
      return hostFailure(id, HOST_ERROR_CODES.methodNotFound, `Method not found: ${method}`);
    }
    try {
      return hostResult(id, await this.invoke(method, request.params, connection));
    } catch (error) {
      if (error instanceof HostMethodError) return hostFailure(id, error.code, error.message, error.data);
      this.logger.warn(`HOST: ${method} failed: ${errorMessage(error)}`);
      return hostFailure(id, HOST_ERROR_CODES.internalError, errorMessage(error));
    }
  }

  private async invoke<M extends ServedHostMethod>(
    method: M,
    rawParams: unknown,
    connection: Connection
  ): Promise<HostResult<M>> {
    const { params: paramsSchema, result: resultSchema } = hostMethods[method];
    const params = paramsSchema.safeParse(rawParams);
    if (!params.success) {
      throw new HostMethodError(HOST_ERROR_CODES.invalidParams, `Invalid params for ${method}`, params.error.issues);
    }
    const handler: Handler<M> = this.handlers[method];
    const result = resultSchema.safeParse(await handler(params.data as HostParams<M>, connection));
    // The runtime answered with something the protocol does not allow: a host bug, not the caller's.
    if (!result.success) throw new Error(`Result of ${method} does not match the protocol`);
    return result.data as HostResult<M>;
  }

  private createHandlers(): Handlers {
    const runtime = this.runtime;
    return {
      ...hostControlHandlers(this.control),
      'session/list': async () => ({ sessions: await runtime.listSessions() }),
      'session/page': request => runtime.listSessionPage(request),
      'session/get': async ({ sessionId, viewed }) => {
        const session = await runtime.getSession(sessionId, viewed === true);
        const notices = runtime.contextNotices(sessionId);
        return {
          session: sessionForRenderer(session),
          cursor: session?.eventCursor ?? runtime.eventLog.cursor(sessionId),
          ...(notices.length > 0 ? { notices } : {}),
        };
      },
      'session/rename': async ({ sessionId, title }) => ({
        summary: await runtime.renameSession(sessionId, title),
      }),
      'session/create': async request =>
        request ? runtime.createCodeSession(request) : { ok: true, session: await runtime.createSession() },
      'session/setArchived': ({ sessionId, archived, confirmed, archiveChildIds }) =>
        runtime.setSessionArchived(sessionId, archived, { confirmed, archiveChildIds }),
      'session/delete': async ({ sessionId, removeWorktree, allowDiscard }) => {
        await runtime.deleteSession(sessionId, removeWorktree === true, allowDiscard === true);
        return {};
      },
      'session/deleteTree': ({ sessionId, nestedIds, removeWorktree, nestedWorktreeIds, allowDiscard }) =>
        runtime.deleteSessionTree(
          sessionId,
          nestedIds,
          removeWorktree === true,
          nestedWorktreeIds ?? [],
          allowDiscard === true
        ),
      'session/subscribe': ({ sessionId, after }, connection) => this.subscribe(connection, sessionId, after),
      'session/unsubscribe': ({ sessionId }, connection) => {
        connection.subscriptions.delete(sessionId);
        return {};
      },
      'session/statuses': () => ({ statuses: runtime.sessionStatuses() }),
      'turn/send': request => runtime.sendMessage(request),
      'turn/stop': ({ sessionId }) => {
        runtime.stopReply(sessionId);
        return {};
      },
      'request/respond': async request => {
        if (request.kind === 'approval') {
          await runtime.respondToApproval(request.requestId, request.answer);
          return {};
        }
        const reply = taskDecisionReplySchema.safeParse(request);
        if (!reply.success) {
          throw new HostMethodError(HOST_ERROR_CODES.invalidParams, 'Invalid task decision answer', reply.error.issues);
        }
        await runtime.answerTaskDecision(reply.data.sessionId, reply.data.decisionId, reply.data.answer);
        return {};
      },
      'background/stop': async ({ sessionId, processId }) => {
        const stopped = await runtime.stopBackgroundProcess(sessionId, processId);
        if (!stopped.ok) {
          throw new HostMethodError(HOST_ERROR_CODES.processNotFound, `No background process ${processId}`, {
            sessionId,
            processId,
          } satisfies HostErrorData<'processNotFound'>);
        }
        return { process: stopped.process };
      },
      'fs/browse': async params => {
        const browsed = await runtime.browseDirectory(params?.path);
        if (!browsed.ok) {
          throw new HostMethodError(HOST_ERROR_CODES.pathUnavailable, `Cannot browse ${browsed.path}`, {
            path: browsed.path,
            reason: browsed.reason,
          } satisfies HostErrorData<'pathUnavailable'>);
        }
        return browsed.listing;
      },
      'project/recent': async () => ({ folders: await runtime.listRecentFolders() }),
      'queue/list': async ({ sessionId }) => ({ queued: await runtime.queuedMessages(sessionId) }),
      'queue/cancel': ({ sessionId, queuedId }) => {
        runtime.cancelQueued(sessionId, queuedId);
        return {};
      },
      'queue/sendNow': ({ sessionId, queuedId }) => {
        runtime.sendQueuedNow(sessionId, queuedId);
        return {};
      },
      'project/forgetRecent': async ({ path }) => ({ folders: await runtime.forgetRecentFolder(path) }),
      'project/inspect': async ({ directory }) => ({ inspection: await runtime.inspectProject(directory) }),
      'model/list': async ({ force }) => ({ models: await runtime.listModels(force ?? false) }),
      'draft/defaults': async () => ({ defaults: await runtime.draftDefaults() }),
      'taskDecision/list': async () => ({ decisions: await runtime.listTaskDecisions() }),
    };
  }

  // Synchronous from the replay read to the subscription being recorded, so no live event can
  // land between them and be either lost or sent twice.
  private subscribe(
    connection: Connection,
    sessionId: string,
    after: HostParams<'session/subscribe'>['after']
  ): HostResult<'session/subscribe'> {
    const replay = after ? this.runtime.service.eventsSince(sessionId, after) : { ok: true as const, events: [] };
    if (!replay.ok) {
      throw new HostMethodError(
        HOST_ERROR_CODES.snapshotRequired,
        'The events after this cursor are no longer held; read the session again',
        { sessionId }
      );
    }
    connection.subscriptions.add(sessionId);
    for (const event of replay.events) this.sendEvent(connection, event);
    return { cursor: this.runtime.eventLog.cursor(sessionId) };
  }

  private sendEvent(connection: Connection, event: ChatStreamEvent): void {
    if (event.seq === undefined) {
      this.logger.warn(`HOST: dropped an unsequenced ${event.type} event for ${event.sessionId}`);
      return;
    }
    connection.notify(
      notification('session/event', {
        sessionId: event.sessionId,
        seq: event.seq,
        epoch: this.runtime.eventLog.cursor(event.sessionId).epoch,
        event,
      })
    );
  }

  private broadcast(message: HostNotification): void {
    for (const connection of this.connections) connection.notify(message);
  }

  private eventSink(): HostEventSink {
    return {
      streamEvent: event => {
        for (const connection of this.connections) {
          if (connection.subscriptions.has(event.sessionId)) this.sendEvent(connection, event);
        }
        if (event.type === 'spawn-failed') {
          const { sessionId, title, message } = event;
          this.broadcast(notification('session/spawnFailed', { sessionId, title, message }));
        }
        if (event.type === 'context-notice') {
          const { type, sessionId, message, kind } = event;
          this.broadcast(
            notification('session/contextNotice', { event: { type, sessionId, message, ...(kind ? { kind } : {}) } })
          );
        }
        if (event.type === 'context-notice-cleared') {
          const { type, sessionId, kind } = event;
          this.broadcast(notification('session/contextNotice', { event: { type, sessionId, kind } }));
        }
      },
      sessionSummary: summary => this.broadcast(notification('session/summaryChanged', { summary })),
      // Sent whether or not the status itself moved, as the renderer IPC push is: a background
      // job starting or ending changes only the event's detail, and the sidebar draws that too.
      sessionStatus: event => this.broadcast(notification('session/statusChanged', { event })),
      queueChanged: event => this.broadcast(notification('session/queueChanged', { event })),
      taskDecisions: decisions => this.broadcast(notification('session/taskDecisionsChanged', { decisions })),
      // The protocol has no loop notification yet; Desktop's renderer still takes it over IPC.
      loopChanged: () => undefined,
    };
  }
}
