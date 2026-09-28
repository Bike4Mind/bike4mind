import { randomUUID } from 'node:crypto';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type {
  ChatMessage,
  ChatSession,
  ChatSessionSummary,
  ChatStreamEvent,
  ChatUsage,
  SendMessageResult,
} from '@shared/chat';
import { DEFAULT_COMPLETIONS_PATH, streamCompletion, type CompletionMessage } from './completions';
import type { SessionStore } from './SessionStore';

/** Only the field this client reads from `GET /api/settings/serverConfig`. */
interface ServerTransportConfig {
  sseCompletionsUrl?: string;
}

export interface ChatServiceLogger {
  debug(message: string): void;
  warn(message: string): void;
}

export interface ChatServiceDeps {
  store: SessionStore;
  logger: ChatServiceLogger;
  /** Null whenever no session is usable, which is how a signed-out send is refused. */
  getApiClient(): AuthenticatedApiClient | null;
  /** Identifies the cached completions endpoint; changing environments invalidates it. */
  getEnvironmentUrl(): string;
  emit(event: ChatStreamEvent): void;
}

/**
 * Owns conversations and the reply stream.
 *
 * Streaming runs HERE, in main, and not in the renderer: the request carries the access
 * token, and T4's invariant is that tokens never leave this process. Reply text reaches the
 * renderer as IPC pushes instead - see the note on `send`.
 */
export class ChatService {
  /** One in-flight reply per session; the value aborts it. */
  private readonly active = new Map<string, AbortController>();

  /** Resolved completions endpoint, cached per environment URL (serverConfig is one round trip). */
  private endpointCache: { environmentUrl: string; endpoint: string } | null = null;

  constructor(private readonly deps: ChatServiceDeps) {}

  listSessions(): Promise<ChatSessionSummary[]> {
    return this.deps.store.list();
  }

  createSession(): Promise<ChatSessionSummary> {
    return this.deps.store.create();
  }

  getSession(sessionId: string): Promise<ChatSession | null> {
    return this.deps.store.get(sessionId);
  }

  renameSession(sessionId: string, title: string): Promise<ChatSessionSummary | null> {
    return this.deps.store.rename(sessionId, title);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.stop(sessionId);
    await this.deps.store.delete(sessionId);
  }

  /** Stop an in-flight reply. The partial text is kept - see the 'done' case in @shared/chat. */
  stop(sessionId: string): void {
    this.active.get(sessionId)?.abort();
  }

  dispose(): void {
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
  }

  /**
   * Accept a turn: persist the prompt, then stream the reply in the background.
   *
   * Resolves once the turn is accepted rather than when the reply finishes, because an IPC
   * invoke left pending for the length of a generation looks like a hung renderer - the same
   * reasoning as the auth sign-in channel.
   */
  async send(sessionId: string, text: string): Promise<SendMessageResult> {
    const prompt = text.trim();
    if (!prompt) return { ok: false, error: 'Type a message first.' };
    if (this.active.has(sessionId)) return { ok: false, error: 'This conversation is still replying.' };

    const api = this.deps.getApiClient();
    if (!api) return { ok: false, error: 'Sign in to send a message.' };

    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: prompt,
      createdAt: new Date().toISOString(),
    };

    const session = await this.deps.store.appendMessage(sessionId, userMessage);
    if (!session) return { ok: false, error: 'That conversation no longer exists.' };

    const replyId = randomUUID();
    const controller = new AbortController();
    this.active.set(sessionId, controller);

    void this.runReply(session, replyId, api, controller).finally(() => {
      // Only clear if still ours: a delete-then-recreate could have installed a newer one.
      if (this.active.get(sessionId) === controller) this.active.delete(sessionId);
    });

    return { ok: true, messageId: replyId };
  }

  private async runReply(
    session: ChatSession,
    replyId: string,
    api: AuthenticatedApiClient,
    controller: AbortController
  ): Promise<void> {
    const sessionId = session.id;
    this.deps.emit({ type: 'start', sessionId, messageId: replyId });

    let content = '';
    let stopReason: string | undefined;
    let usage: ChatUsage | undefined;

    try {
      const endpoint = await this.resolveEndpoint(api);

      await streamCompletion(
        api.getAxiosInstance(),
        endpoint,
        { model: session.model, messages: toCompletionMessages(session) },
        event => {
          // `error` never reaches here (the transport throws on it); `meta` carries no reply.
          if (event.type === 'error' || event.type === 'meta') return;
          // tool_use is not expected (no tools are declared) but its `text` is still reply
          // text; taking it keeps a server-side surprise from silently dropping content.
          if (event.text) {
            content += event.text;
            this.deps.emit({ type: 'delta', sessionId, messageId: replyId, text: event.text });
          }
          if (event.stopReason) stopReason = event.stopReason;
          if (event.usage) usage = event.usage;
        },
        controller.signal
      );

      if (controller.signal.aborted) stopReason = 'aborted';

      await this.deps.store.appendMessage(sessionId, {
        id: replyId,
        role: 'assistant',
        content,
        createdAt: new Date().toISOString(),
        stopReason,
      });
      this.deps.emit({ type: 'done', sessionId, messageId: replyId, content, stopReason, usage });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn(`CHAT: reply failed: ${message}`);

      // Persisted even though it failed: a thread that silently drops the turn leaves the
      // user's own prompt sitting there with no explanation next time they open it.
      await this.deps.store.appendMessage(sessionId, {
        id: replyId,
        role: 'assistant',
        content,
        createdAt: new Date().toISOString(),
        error: message,
      });
      this.deps.emit({ type: 'error', sessionId, messageId: replyId, message });
    }
  }

  /**
   * Where to POST completions. Hosted deploys route the same-origin path to the ChatCompletion
   * service, but a self-host stack has no CDN doing that and advertises the service's own
   * origin as `sseCompletionsUrl` instead. A failed lookup is non-fatal - the same-origin path
   * is the right guess for the deploys that omit the field.
   */
  private async resolveEndpoint(api: AuthenticatedApiClient): Promise<string> {
    const environmentUrl = this.deps.getEnvironmentUrl();
    if (this.endpointCache?.environmentUrl === environmentUrl) return this.endpointCache.endpoint;

    let endpoint = DEFAULT_COMPLETIONS_PATH;
    try {
      const config = await api.get<ServerTransportConfig>('/api/settings/serverConfig');
      if (config?.sseCompletionsUrl) endpoint = config.sseCompletionsUrl;
    } catch (err) {
      this.deps.logger.debug(
        `CHAT: serverConfig lookup failed, using ${DEFAULT_COMPLETIONS_PATH}: ${
          err instanceof Error ? err.message : 'unknown'
        }`
      );
    }

    this.endpointCache = { environmentUrl, endpoint };
    return endpoint;
  }
}

/**
 * The whole thread as the wire wants it. This endpoint is stateless, so every turn resends the
 * full history - there is no server-side conversation to append to.
 *
 * A failed turn's placeholder is dropped rather than sent: replaying an empty assistant message
 * would teach the model that empty replies are acceptable, and some providers reject one outright.
 */
function toCompletionMessages(session: ChatSession): CompletionMessage[] {
  return session.messages
    .filter(message => message.content.length > 0)
    .map(message => ({ role: message.role, content: message.content }));
}
