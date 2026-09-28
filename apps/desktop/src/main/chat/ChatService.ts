import { randomUUID } from 'node:crypto';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type {
  ChatMessage,
  ChatSession,
  ChatSessionSummary,
  ChatStreamEvent,
  ChatToolCall,
  ChatUsage,
  SendMessageResult,
} from '@shared/chat';
import { DEFAULT_COMPLETIONS_PATH, streamCompletion, type CompletionMessage } from './completions';
import type { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import { findTool, toolsForRequest } from './tools/registry';
import { capOutput } from './tools/types';

/** Only the field this client reads from `GET /api/settings/serverConfig`. */
interface ServerTransportConfig {
  sseCompletionsUrl?: string;
}

/**
 * Ceiling on tool round trips within a single user turn. A model that keeps calling tools
 * without concluding would otherwise bill and run forever; hitting the cap ends the turn with
 * whatever it has said, flagged so the UI can show it was cut short rather than finished.
 */
const MAX_TOOL_TURNS = 10;

export interface ChatServiceLogger {
  debug(message: string): void;
  warn(message: string): void;
}

export interface ChatServiceDeps {
  store: SessionStore;
  access: AccessStore;
  logger: ChatServiceLogger;
  /** Null whenever no session is usable, which is how a signed-out send is refused. */
  getApiClient(): AuthenticatedApiClient | null;
  /** Identifies the cached completions endpoint; changing environments invalidates it. */
  getEnvironmentUrl(): string;
  emit(event: ChatStreamEvent): void;
}

/** One model-requested tool call, as it arrives on the wire. */
interface RequestedTool {
  id?: string;
  name: string;
  arguments?: string;
}

/**
 * Owns conversations, the reply stream, and the tool loop.
 *
 * Streaming runs HERE, in main, and not in the renderer: the request carries the access
 * token, and T4's invariant is that tokens never leave this process. Tools run here for the
 * same reason plus a second one - they touch the filesystem, which a sandboxed renderer cannot.
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
   * Accept a turn: persist the prompt, then run the reply in the background.
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
    const toolCalls: ChatToolCall[] = [];
    let thinking: unknown[] | undefined;

    try {
      const endpoint = await this.resolveEndpoint(api);
      const roots = await this.deps.access.list();
      const tools = toolsForRequest(roots);
      const wire = toCompletionMessages(session);
      wire.unshift(buildSystemMessage(roots));

      for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        const requested: RequestedTool[] = [];
        let turnText = '';
        let turnThinking: unknown[] | undefined;

        await streamCompletion(
          api.getAxiosInstance(),
          endpoint,
          { model: session.model, messages: wire, tools },
          event => {
            // `error` never reaches here (the transport throws on it); `meta` carries no reply.
            if (event.type === 'error' || event.type === 'meta') return;
            if (event.text) {
              content += event.text;
              turnText += event.text;
              this.deps.emit({ type: 'delta', sessionId, messageId: replyId, text: event.text });
            }
            if (event.type === 'tool_use') {
              if (event.tools) requested.push(...event.tools);
              if (event.thinking) turnThinking = event.thinking;
            }
            if (event.stopReason) stopReason = event.stopReason;
            if (event.usage) usage = event.usage;
          },
          controller.signal
        );

        if (controller.signal.aborted) break;
        if (requested.length === 0) break;

        thinking = turnThinking;
        const settled = await this.runTools(requested, roots, sessionId, replyId, controller.signal);
        toolCalls.push(...settled);

        // Anthropic's shape: ONE assistant turn carrying the reasoning, any text and every
        // tool_use block, answered by ONE user turn of matching tool_result blocks. Splitting
        // them per tool would misrepresent parallel calls as a sequence.
        wire.push({
          role: 'assistant',
          content: [
            ...(turnThinking ?? []),
            ...(turnText ? [{ type: 'text', text: turnText }] : []),
            ...settled.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input })),
          ],
        });
        wire.push({
          role: 'user',
          content: settled.map(call => ({
            type: 'tool_result',
            tool_use_id: call.id,
            content: call.error ?? call.preview ?? '',
            ...(call.error ? { is_error: true } : {}),
          })),
        });

        if (turn === MAX_TOOL_TURNS - 1) stopReason = 'tool_turn_limit';
      }

      if (controller.signal.aborted) stopReason = 'aborted';

      await this.deps.store.appendMessage(sessionId, {
        id: replyId,
        role: 'assistant',
        content,
        createdAt: new Date().toISOString(),
        stopReason,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(thinking ? { thinking } : {}),
      });
      this.deps.emit({
        type: 'done',
        sessionId,
        messageId: replyId,
        content,
        stopReason,
        usage,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
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
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
      this.deps.emit({ type: 'error', sessionId, messageId: replyId, message });
    }
  }

  /**
   * Run every tool the model asked for, in parallel, reporting each to the UI as it starts and
   * finishes. A tool that throws is reported back to the MODEL as a failed result rather than
   * aborting the turn: "that path is not granted" is something it can act on.
   */
  private async runTools(
    requested: readonly RequestedTool[],
    roots: readonly string[],
    sessionId: string,
    messageId: string,
    signal: AbortSignal
  ): Promise<ChatToolCall[]> {
    return Promise.all(
      requested.map(async request => {
        const call: ChatToolCall = {
          id: request.id ?? randomUUID(),
          name: request.name,
          input: parseArguments(request.arguments),
          status: 'running',
        };
        this.deps.emit({ type: 'tool-start', sessionId, messageId, call });

        const tool = findTool(request.name);
        let settled: ChatToolCall;
        if (!tool) {
          settled = { ...call, status: 'error', error: `Unknown tool: ${request.name}` };
        } else {
          try {
            const result = await tool.run(call.input, { roots, signal });
            settled = { ...call, status: 'done', preview: capOutput(result) };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.deps.logger.debug(`CHAT: tool ${request.name} failed: ${message}`);
            settled = {
              ...call,
              // A refusal is its own state: the UI says "denied", not "something broke".
              status: err instanceof Error && err.name === 'PathAccessDenied' ? 'denied' : 'error',
              error: message,
            };
          }
        }

        this.deps.emit({ type: 'tool-end', sessionId, messageId, call: settled });
        return settled;
      })
    );
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
 * State the model's current file access, every turn, whether or not anything is granted.
 *
 * Both halves were learned from live failures:
 *  - Granted but unnamed, it guesses a path from the user's wording ("my Downloads folder" ->
 *    a call against an invented `/shared`), which is denied and wastes a whole tool turn.
 *  - Revoked, it FABRICATES. Sending nothing when no tools are declared left a thread whose
 *    earlier turns contained a successful tool call, and the model imitated that shape and
 *    invented a filename and byte count rather than saying it could not look. Saying "you have
 *    no access" explicitly is what stops that, so this is never omitted.
 */
function buildSystemMessage(roots: readonly string[]): CompletionMessage {
  if (roots.length === 0) {
    return {
      role: 'system',
      content: [
        'You currently have NO access to the user files or filesystem, and no tools to read them.',
        'Earlier turns in this conversation may show successful file reads; that access has since',
        'been revoked and you cannot rely on it.',
        'Never claim to have read, listed or searched a file, and never invent a file name, size,',
        'path or contents. If asked about local files, say plainly that you have no access and ask',
        'the user to grant a folder with the "Share a folder" button.',
      ].join('\n'),
    };
  }

  return {
    role: 'system',
    content: [
      'You can read files on the user machine with the provided tools.',
      'These folders are shared with you, including everything beneath them:',
      ...roots.map(root => `  ${root}`),
      'Always pass absolute paths. Any path outside those folders is denied;',
      'if you need one, ask the user to share it with the "Share a folder" button.',
      'Never invent a file name, size or contents: if a tool did not return it, you do not know it.',
    ].join('\n'),
  };
}

/** Tool arguments arrive as a raw JSON string; a malformed one becomes an empty object. */
function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The whole thread as the wire wants it. This endpoint is stateless, so every turn resends the
 * full history - there is no server-side conversation to append to.
 *
 * A turn that ran tools is rebuilt into the pair the provider expects (assistant tool_use,
 * then user tool_result), so a reloaded conversation continues exactly like a live one.
 *
 * A failed turn's placeholder is dropped rather than sent: replaying an empty assistant message
 * would teach the model that empty replies are acceptable, and some providers reject one outright.
 */
function toCompletionMessages(session: ChatSession): CompletionMessage[] {
  const wire: CompletionMessage[] = [];

  for (const message of session.messages) {
    const calls = message.toolCalls ?? [];
    if (calls.length === 0) {
      if (message.content.length > 0) wire.push({ role: message.role, content: message.content });
      continue;
    }

    wire.push({
      role: 'assistant',
      content: [
        ...(message.thinking ?? []),
        ...(message.content ? [{ type: 'text', text: message.content }] : []),
        ...calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input })),
      ],
    });
    wire.push({
      role: 'user',
      content: calls.map(call => ({
        type: 'tool_result',
        tool_use_id: call.id,
        content: call.error ?? call.preview ?? '',
        ...(call.error ? { is_error: true } : {}),
      })),
    });
  }

  return wire;
}
