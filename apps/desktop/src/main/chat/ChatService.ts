import { randomUUID } from 'node:crypto';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type {
  ChatMessage,
  ChatModelCatalog,
  ChatModelOption,
  ChatSession,
  ChatSessionSummary,
  ChatStreamEvent,
  ChatToolCall,
  ChatUsage,
  SendMessageResult,
} from '@shared/chat';
import { DEFAULT_COMPLETIONS_PATH, streamCompletion, type CompletionMessage } from './completions';
import { resolveDefaultModel, type ModelCatalog } from './ModelCatalog';
import type { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import type { ApprovalGate } from './tools/ApprovalGate';
import type { BackgroundProcessRegistry } from './tools/BackgroundProcessRegistry';
import { findTool, toolsForRequest } from './tools/registry';
import { capOutput, type ApprovalPrompt, type ToolContext, type ToolDefinition } from './tools/types';

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
  /**
   * The server's model list. Absent in tests that do not exercise model resolution, which then
   * leaves every session on whatever model it was created with.
   */
  models?: ModelCatalog;
  /** This build's preferred model, used until the server's catalog says what it really offers. */
  preferredModel?: string;
  /** Absent in tests that exercise tools needing no consent; a gated tool then never runs. */
  approvals?: ApprovalGate;
  /** Owns long-running commands. Absent in tests, which then have no background tools. */
  background?: BackgroundProcessRegistry;
  /** Paths kept out of reach of shell commands whatever the user granted. See tools/sandbox.ts. */
  protectedPaths?: readonly string[];
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

  listModels(force = false): Promise<ChatModelCatalog> {
    return this.deps.models?.list(force) ?? Promise.resolve({ models: [] });
  }

  /**
   * Start a conversation on a model this deployment actually offers.
   *
   * The catalog lookup is awaited rather than skipped: it is one cached round trip on a
   * deliberate click, and starting a thread on a model the server does not have means the
   * user's first message is the thing that discovers it.
   */
  async createSession(): Promise<ChatSessionSummary> {
    const catalog = await this.listModels();
    return this.deps.store.create(this.pickModel(catalog.models) ?? undefined);
  }

  /** Pin this conversation to a model. Not validated against the catalog: see `reconcileModel`. */
  setSessionModel(sessionId: string, model: string): Promise<ChatSessionSummary | null> {
    return this.deps.store.setModel(sessionId, model);
  }

  getSession(sessionId: string): Promise<ChatSession | null> {
    return this.deps.store.get(sessionId);
  }

  renameSession(sessionId: string, title: string): Promise<ChatSessionSummary | null> {
    return this.deps.store.rename(sessionId, title);
  }

  /**
   * Deleting a conversation also kills its background processes.
   *
   * The alternative - leaving them running - orphans them: the panel that could stop them is
   * gone with the conversation, and the model can no longer name their handles. Nothing would
   * be left that could turn a forgotten dev server off.
   */
  async deleteSession(sessionId: string): Promise<void> {
    this.stop(sessionId);
    this.deps.approvals?.forgetSession(sessionId);
    await this.deps.background?.killSession(sessionId);
    await this.deps.store.delete(sessionId);
  }

  /**
   * Stop an in-flight reply. The partial text is kept - see the 'done' case in @shared/chat.
   *
   * Background processes are deliberately NOT stopped: outliving the turn is the whole point
   * of starting one, and a user pressing stop on a reply is stopping the model, not the dev
   * server it started. `bash_kill` and the panel's Stop button are how those end.
   */
  stop(sessionId: string): void {
    this.active.get(sessionId)?.abort();
  }

  dispose(): void {
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
    this.deps.approvals?.dispose();
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

    const appended = await this.deps.store.appendMessage(sessionId, userMessage);
    if (!appended) return { ok: false, error: 'That conversation no longer exists.' };

    const { session, notice } = await this.reconcileModel(appended);

    const replyId = randomUUID();
    const controller = new AbortController();
    this.active.set(sessionId, controller);

    void this.runReply(session, replyId, api, controller).finally(() => {
      // Only clear if still ours: a delete-then-recreate could have installed a newer one.
      if (this.active.get(sessionId) === controller) this.active.delete(sessionId);
    });

    return { ok: true, messageId: replyId, ...(notice ? { notice } : {}) };
  }

  /**
   * Move a conversation off a model this deployment no longer offers.
   *
   * The two ways in are an environment switch (hosted -> self-host, where the model set is
   * whatever that stack holds keys for) and a conversation older than a provider key being
   * removed. Substituting is better than letting the request 4xx: the user gets an answer plus
   * a line saying what happened, rather than a status code from a server they did not change.
   *
   * Only ever acts on an ALREADY-CACHED list. A turn must not wait on a network round trip to
   * discover that nothing is wrong, and an unreadable catalog is not evidence that a model is
   * gone - in that case the request goes out as saved and the server decides.
   */
  private async reconcileModel(session: ChatSession): Promise<{ session: ChatSession; notice?: string }> {
    const available = this.deps.models?.cached();
    if (!available || available.length === 0) return { session };
    if (available.some(model => model.id === session.model)) return { session };

    const replacement = this.pickModel(available);
    if (!replacement) return { session };

    await this.deps.store.setModel(session.id, replacement);
    const name = available.find(model => model.id === replacement)?.name ?? replacement;
    this.deps.logger.warn(`CHAT: ${session.model} is not available here; using ${replacement}`);
    return {
      session: { ...session, model: replacement },
      notice: `${session.model} is not available on this server. Switched this conversation to ${name}.`,
    };
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

        const tool = findTool(request.name);
        if (!tool) {
          const unknown: ChatToolCall = { ...call, status: 'error', error: `Unknown tool: ${request.name}` };
          this.deps.emit({ type: 'tool-start', sessionId, messageId, call });
          this.deps.emit({ type: 'tool-end', sessionId, messageId, call: unknown });
          return unknown;
        }

        const context: ToolContext = {
          roots,
          signal,
          protectedPaths: this.deps.protectedPaths,
          sessionId,
          background: this.deps.background,
        };

        // Asked BEFORE 'running' is announced, so the UI never shows a command as under way
        // while it is still waiting on the user, and nothing has run if they say no.
        const denial = await this.awaitApproval(tool, call, context, sessionId, messageId, signal);
        if (denial) return denial;

        this.deps.emit({ type: 'tool-start', sessionId, messageId, call });

        let settled: ChatToolCall;
        try {
          const result = await tool.run(call.input, context);
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

        this.deps.emit({ type: 'tool-end', sessionId, messageId, call: settled });
        return settled;
      })
    );
  }

  /**
   * Hold a tool at the approval gate, if it declares one.
   *
   * Returns the settled DENIED call when the user says no, and null when the tool may run. A
   * refusal is reported to the model as a failed tool_result rather than as an aborted turn, so
   * it can say what it wanted to do instead of the conversation stopping dead.
   */
  private async awaitApproval(
    tool: ToolDefinition,
    call: ChatToolCall,
    context: ToolContext,
    sessionId: string,
    messageId: string,
    signal: AbortSignal
  ): Promise<ChatToolCall | null> {
    const gate = this.deps.approvals;
    if (!gate || !tool.approval) return null;

    // Building the prompt reads the filesystem for a write tool, and a refusal there - a path
    // outside every granted folder, a binary file - has to settle the call WITHOUT asking. A
    // denial the user is invited to click through is not a denial.
    let prompt: ApprovalPrompt;
    try {
      prompt = await tool.approval(call.input, context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const refused: ChatToolCall = {
        ...call,
        status: err instanceof Error && err.name === 'PathAccessDenied' ? 'denied' : 'error',
        error: message,
      };
      this.deps.emit({ type: 'tool-start', sessionId, messageId, call });
      this.deps.emit({ type: 'tool-end', sessionId, messageId, call: refused });
      return refused;
    }

    if (gate.isStanding(sessionId, prompt.key)) return null;

    const decision = await gate.request(sessionId, prompt.key, signal, approvalId => {
      this.deps.emit({
        type: 'tool-start',
        sessionId,
        messageId,
        call: {
          ...call,
          status: 'awaiting-approval',
          approvalId,
          approvalDetail: prompt.detail,
          ...(prompt.diff ? { approvalDiff: prompt.diff } : {}),
        },
      });
    });

    if (decision !== 'deny') return null;

    const denied: ChatToolCall = {
      ...call,
      status: 'denied',
      error: 'The user declined to run this. Do not try to run it again; ask them what to do instead.',
    };
    this.deps.emit({ type: 'tool-end', sessionId, messageId, call: denied });
    return denied;
  }

  private pickModel(models: readonly ChatModelOption[]): string | null {
    return resolveDefaultModel(models, this.deps.preferredModel ?? '');
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
      'You can read and change files on the user machine, and run bash commands on it, with the',
      'provided tools.',
      'These folders are shared with you, including everything beneath them:',
      ...roots.map(root => `  ${root}`),
      'Always pass absolute paths. Any path outside those folders is denied;',
      'if you need one, ask the user to share it with the "Share a folder" button.',
      'Running a command needs the user to approve it first, and they see the exact command, so',
      'prefer one clear command over several speculative ones. If they decline, accept it and ask',
      'what they would like instead rather than trying a variation of the same command.',
      'Changing a file needs the same approval, and the user sees a line-by-line diff of the',
      'change before they answer. Read a file before you edit it, and prefer file_edit over',
      'file_write so the rest of the file is left alone; file_write replaces a file entirely.',
      'Dev servers, watchers and anything else meant to keep running go to bash_background, not',
      'bash_execute. Background processes belong to this conversation, are all killed when the app',
      'quits, and none survive a restart - so check bash_list rather than assuming one from an',
      'earlier session is still up, and stop what you no longer need with bash_kill.',
      'Never invent a file name, size or contents, or the output of a command: if a tool did not',
      'return it, you do not know it.',
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
