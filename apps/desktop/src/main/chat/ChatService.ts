import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type {
  ChatAttachment,
  ChatMedia,
  ChatMessage,
  ChatModelCatalog,
  ChatModelOption,
  ChatProject,
  ChatQueuedMessage,
  ChatSession,
  ChatSessionStatusEvent,
  ChatSessionSummary,
  ChatStreamEvent,
  ChatToolCall,
  ChatToolNotice,
  ChatUsage,
  CreateCodeSessionRequest,
  CreateCodeSessionResult,
  SendMessageResult,
  UpdateProjectRequest,
  UpdateProjectResult,
} from '@shared/chat';
import { projectDisplayName } from './project/git';
import { resolveWorkspace } from './project/workspace';
import { MAX_ATTACHMENTS_PER_TURN, textAttachmentBlock } from './attachments';
import type { AttachmentStore } from './AttachmentStore';
import { DEFAULT_COMPLETIONS_PATH, streamCompletion, type CompletionMessage } from './completions';
import { MediaApiClient } from './media/MediaApiClient';
import type { MediaStore } from './media/MediaStore';
import type { MessageQueue } from './MessageQueue';
import { resolveDefaultModel, type ModelCatalog } from './ModelCatalog';
import type { SessionActivity } from './SessionActivity';
import type { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import type { ApprovalGate } from './tools/ApprovalGate';
import type { BackgroundProcessRegistry } from './tools/BackgroundProcessRegistry';
import { findTool, toolsForRequest } from './tools/registry';
import {
  capOutput,
  type ApprovalPrompt,
  type MediaContext,
  type ToolContext,
  type ToolDefinition,
  type ToolReporter,
} from './tools/types';

/** The fields this client reads from `GET /api/settings/serverConfig`. */
interface ServerTransportConfig {
  sseCompletionsUrl?: string;
  /** Base for generated-file URLs. A relative path on self-host, an absolute CDN URL on hosted. */
  cdnUrl?: string;
}

/** What one serverConfig lookup yields, cached together because it is one round trip. */
interface ResolvedServerConfig {
  endpoint: string;
  cdnUrl: string;
}

/**
 * Ceiling on tool round trips within a single user turn. A model that keeps calling tools
 * without concluding would otherwise bill and run forever; hitting the cap ends the turn with
 * whatever it has said, flagged so the UI can show it was cut short rather than finished.
 */
const MAX_TOOL_TURNS = 10;

/** How a turn ended. Only 'completed' lets a queued message go out; see settleQueue. */
type TurnOutcome = 'completed' | 'aborted' | 'failed';

export interface ChatServiceLogger {
  debug(message: string): void;
  warn(message: string): void;
}

export interface ChatServiceDeps {
  store: SessionStore;
  access: AccessStore;
  /** Owns attachment bytes. Absent in tests that never attach anything. */
  attachments?: AttachmentStore;
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
  /** Where generated images and audio land. Absent in tests, which then have no generation tools. */
  media?: MediaStore;
  /** Paths kept out of reach of shell commands whatever the user granted. See tools/sandbox.ts. */
  protectedPaths?: readonly string[];
  /**
   * Per-session status for the sidebar. Fed from here because this is where a reply's lifetime
   * is known; the approval gate feeds it the other half.
   */
  activity?: SessionActivity;
  /**
   * Messages typed during a live turn. Absent in tests that never send one mid-reply, which
   * then get the old behaviour: a send during a reply is refused outright.
   */
  queue?: MessageQueue;
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

  /** Resolved serverConfig fields, cached per environment URL (it is one round trip). */
  private serverConfigCache: { environmentUrl: string; config: ResolvedServerConfig } | null = null;

  constructor(private readonly deps: ChatServiceDeps) {}

  listSessions(): Promise<ChatSessionSummary[]> {
    return this.deps.store.list();
  }

  /** Every session that is busy right now, for a renderer that has just mounted. */
  sessionStatuses(): ChatSessionStatusEvent[] {
    return this.deps.activity?.snapshot() ?? [];
  }

  /** What one conversation has waiting, for a renderer opening it. */
  queuedMessages(sessionId: string): ChatQueuedMessage[] {
    return this.deps.queue?.list(sessionId) ?? [];
  }

  /**
   * Take a queued message back. The text returns to the composer rather than vanishing - see
   * ChatQueueReturnReason - which is also how "edit it" works: cancel, then type.
   */
  cancelQueued(sessionId: string, queuedId: string): void {
    this.deps.queue?.cancel(sessionId, queuedId);
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

  /**
   * Start a Code session, with or without a project directory.
   *
   * A request naming no directory creates an UNBOUND session: a real conversation in Code mode
   * with nowhere to run yet, which the chip row then points at a folder. That state exists so
   * that creating a session never depends on the user completing a native dialog - cancelling
   * one used to produce nothing at all.
   *
   * The workspace is resolved BEFORE the session is written, so a worktree that cannot be
   * created leaves nothing behind: there is no session whose tools would then fall back to
   * some other folder.
   */
  async createCodeSession(request: CreateCodeSessionRequest): Promise<CreateCodeSessionResult> {
    const catalog = await this.listModels();
    const model = this.pickModel(catalog.models) ?? undefined;

    if (!request.directory) {
      return { ok: true, session: await this.deps.store.create(model, undefined, 'code') };
    }

    const directory = resolve(request.directory);
    const branch = (request.branch ?? '').trim();

    let workingDirectory = directory;
    let reusedWorkspace = false;
    if (request.workspace) {
      if (!branch) return { ok: false, error: 'Pick a branch for the workspace to run on.' };
      try {
        const resolved = await resolveWorkspace(directory, branch);
        workingDirectory = resolved.workingDirectory;
        reusedWorkspace = resolved.outcome === 'reused';
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not prepare the workspace.' };
      }
    }

    const session = await this.deps.store.create(model, {
      directory,
      name: await projectDisplayName(directory),
      branch,
      workspace: request.workspace === true,
      workingDirectory,
      contextDirectories: (request.contextDirectories ?? []).map(entry => resolve(entry)),
    });

    return { ok: true, session, ...(reusedWorkspace ? { reusedWorkspace } : {}) };
  }

  /**
   * Move an existing Code session onto a different directory, branch or workspace choice.
   *
   * Refused outright while the session is busy, rather than warned about. The working
   * directory is what roots this session's shell commands, file tools and anything they
   * started: repointing it under a streaming reply would have the rest of that turn run
   * somewhere the first half did not, and repointing it while a background process is alive
   * would leave a dev server running in a checkout the conversation no longer claims - with no
   * handle left in the UI that names where it actually is. Both clear on their own, so this is
   * a wait rather than a dead end.
   *
   * The workspace is resolved BEFORE anything is written, for the same reason createCodeSession
   * does it: a worktree that cannot be made must leave the session exactly as it was.
   */
  async updateProject(request: UpdateProjectRequest): Promise<UpdateProjectResult> {
    const session = await this.deps.store.get(request.sessionId);
    if (session?.mode !== 'code') return { ok: false, error: 'Only a Code session is grounded in a project.' };

    if (this.active.has(request.sessionId)) {
      return { ok: false, busy: true, error: 'Wait for this reply to finish before changing where it runs.' };
    }
    const running = (this.deps.background?.list(request.sessionId) ?? []).filter(
      process => process.status === 'running'
    );
    if (running.length > 0) {
      const names = running.map(process => process.command).join(', ');
      return {
        ok: false,
        busy: true,
        error: `Still running in ${session.project?.workingDirectory}: ${names}. Stop it before changing where this session runs.`,
      };
    }

    const current = session.project;
    const directory = request.directory ? resolve(request.directory) : current?.directory;
    if (!directory) return { ok: false, error: 'Choose a project folder for this conversation first.' };
    // An unbound session is "moved" by its first binding, which is what drops the branch and
    // context folders it never had - the same rule that applies to moving between projects.
    const movedProject = directory !== current?.directory;
    // A branch name means nothing in a repository it does not belong to, so moving the project
    // without naming a branch drops the old one rather than carrying it across.
    const branch = (request.branch ?? (movedProject ? '' : (current?.branch ?? ''))).trim();
    const workspace = request.workspace ?? current?.workspace ?? false;

    let workingDirectory = directory;
    if (workspace) {
      if (!branch) return { ok: false, error: 'Pick a branch for the workspace to run on.' };
      try {
        workingDirectory = (await resolveWorkspace(directory, branch)).workingDirectory;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not prepare the workspace.' };
      }
    }

    const updated = await this.deps.store.setProject(request.sessionId, {
      directory,
      name: movedProject || !current ? await projectDisplayName(directory) : current.name,
      branch,
      workspace,
      workingDirectory,
      // Folders granted for the old project are dropped with it: they were chosen as context
      // for that codebase, and silently carrying them into another one widens the tools' reach
      // past anything the user agreed to here.
      contextDirectories: movedProject ? [] : (current?.contextDirectories ?? []),
    });
    if (!updated) return { ok: false, error: 'This conversation is no longer available.' };
    return { ok: true, session: updated };
  }

  /**
   * The folders this session's tools may touch, and where they run.
   *
   * A Code session's own directories are added to the global grants rather than replacing
   * them: the user picked the project in a native dialog, which is the same act of consent the
   * sidebar's folder card represents, so re-granting the project they just chose would be
   * pure ceremony. The global grants stay because tools are not Code-only - a Code session can
   * still be pointed at a reference checkout the user shared earlier.
   *
   * A Code session with NO project is the one case that gets nothing, not even the global
   * grants. It has no working directory, and every path tool falls back to `roots[0]` when it
   * has none - so handing it the grants would root an agent's shell commands in whichever
   * folder the user happened to share first. An empty root set makes each tool refuse instead
   * (paths.resolveWithinRoots and shellTools.resolveCwd both reject one). `send` already
   * refuses the turn outright; this is the second lock on the same door.
   */
  private async resolveToolScope(
    session: ChatSession
  ): Promise<{ roots: readonly string[]; workingDirectory?: string }> {
    const project = session.project;
    if (!project) return { roots: session.mode === 'code' ? [] : await this.deps.access.list() };

    const granted = await this.deps.access.list();
    const owned = [project.workingDirectory, ...project.contextDirectories];
    const roots = [...owned, ...granted.filter(root => !owned.includes(root))];
    return { roots, workingDirectory: project.workingDirectory };
  }

  /** Pin this conversation to a model. Not validated against the catalog: see `reconcileModel`. */
  setSessionModel(sessionId: string, model: string): Promise<ChatSessionSummary | null> {
    return this.deps.store.setModel(sessionId, model);
  }

  setSessionPinned(sessionId: string, pinned: boolean): Promise<ChatSessionSummary | null> {
    return this.deps.store.setPinned(sessionId, pinned);
  }

  addContextDirectory(sessionId: string, directory: string): Promise<ChatSessionSummary | null> {
    return this.deps.store.addContextDirectory(sessionId, resolve(directory));
  }

  removeContextDirectory(sessionId: string, directory: string): Promise<ChatSessionSummary | null> {
    return this.deps.store.removeContextDirectory(sessionId, directory);
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
    await this.deps.attachments?.deleteSession(sessionId);
    // The generated media goes with it: nothing else references those files once the
    // conversation that displayed them is gone, and they are the largest thing this app writes.
    await this.deps.media?.forgetSession(sessionId);
    await this.deps.store.delete(sessionId);
    this.deps.activity?.forget(sessionId);
    this.deps.queue?.forget(sessionId);
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
  async send(
    sessionId: string,
    text: string,
    attachments: readonly ChatAttachment[] = [],
    /**
     * Set on the flush path only: the queue entry this turn IS. It stops a message coming out
     * of the queue from falling back into it - that would move it to the tail and reorder the
     * user's own turns - and names the entry to confirm once the turn is accepted.
     */
    released?: ChatQueuedMessage
  ): Promise<SendMessageResult> {
    const prompt = text.trim();
    // An attachment is a message on its own: "look at this" with a screenshot needs no prose.
    if (!prompt && attachments.length === 0) return { ok: false, error: 'Type a message first.' };
    if (attachments.length > MAX_ATTACHMENTS_PER_TURN) {
      return { ok: false, error: `Only ${MAX_ATTACHMENTS_PER_TURN} attachments fit in one message.` };
    }

    // Reconciled BEFORE the prompt is stored, because the vision check below has to run against
    // the model that will actually answer - including a substitute picked here - and refusing a
    // turn after appending it would leave the prompt in the thread with no reply coming.
    const existing = await this.deps.store.get(sessionId);
    if (!existing) return { ok: false, error: 'That conversation no longer exists.' };

    // Refused in main, not merely disabled in the UI. A Code session with no project has no
    // working directory, and a turn is the only thing that can make its tools run - so the
    // turn is where the state is stopped, rather than trusting every tool to notice.
    if (existing.mode === 'code' && !existing.project) {
      return { ok: false, error: 'Choose a project folder for this conversation before sending a message.' };
    }

    /**
     * Typing ahead. Decided HERE rather than in the renderer: a reply that finishes between a
     * renderer-side "is it streaming?" check and this call would otherwise queue a message
     * behind a turn that has already ended, and nothing would ever release it.
     *
     * The checks above run first so an impossible message is refused now rather than after a
     * wait. The ones below do not: they depend on the model, and the model is reconciled
     * against the server's catalog at the moment the turn actually goes out. A queued message
     * refused then comes back to the composer - see flushQueue.
     */
    if (this.active.has(sessionId)) {
      if (!this.deps.queue || released) return { ok: false, error: 'This conversation is still replying.' };
      // Against the MERGED total: this send joins whatever is already waiting, so the cap has
      // to be read against the turn that will actually go out.
      const pending = this.deps.queue.list(sessionId)[0]?.attachments?.length ?? 0;
      if (pending + attachments.length > MAX_ATTACHMENTS_PER_TURN) {
        return { ok: false, error: `Only ${MAX_ATTACHMENTS_PER_TURN} attachments fit in one message.` };
      }
      return { ok: true, queued: true, message: this.deps.queue.enqueue(sessionId, prompt, attachments) };
    }

    const api = this.deps.getApiClient();
    if (!api) return { ok: false, error: 'Sign in to send a message.' };

    const { session: reconciled, notice } = await this.reconcileModel(existing);

    const attached = await this.resolveAttachments(sessionId, attachments);
    const refusal = this.refuseUnreadableImages(reconciled.model, attached);
    if (refusal) return { ok: false, error: refusal };

    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: prompt,
      createdAt: new Date().toISOString(),
      ...(attached.length > 0 ? { attachments: attached } : {}),
    };

    const session = await this.deps.store.appendMessage(sessionId, userMessage);
    if (!session) return { ok: false, error: 'That conversation no longer exists.' };

    // Now that the conversation's attachments are settled, anything on disk it does not
    // reference was added to the composer and then removed. See AttachmentStore.prune.
    void this.pruneAttachments(session);

    // Before the reply starts, so the prompt reaches the thread above the reply that answers
    // it: runReply emits 'start' the moment it is called.
    if (released) this.deps.queue?.sent(sessionId, released.id, userMessage);

    const replyId = randomUUID();
    const controller = new AbortController();
    this.active.set(sessionId, controller);
    this.deps.activity?.replyStarted(sessionId);

    void this.runReply(session, replyId, api, controller)
      // runReply already catches, so this only covers a throw from its own bookkeeping. A turn
      // whose end cannot be classified is treated as failed, which HOLDS the queue rather than
      // firing it - the safe direction when the outcome is unknown.
      .catch(() => 'failed' as const)
      .then(outcome => {
        // Only clear if still ours: a delete-then-recreate could have installed a newer one, and
        // telling activity this reply ended would then mark a live one idle.
        if (this.active.get(sessionId) !== controller) return;
        this.active.delete(sessionId);
        this.deps.activity?.replyEnded(sessionId);
        this.settleQueue(sessionId, outcome);
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

  /**
   * Keep only the attachments whose bytes are still on disk for THIS session.
   *
   * The renderer sends back descriptors it was given, so this is both a liveness check (the
   * file could have been discarded) and the ownership check: an id belonging to another
   * conversation resolves to nothing here rather than being read across the boundary.
   */
  private async resolveAttachments(
    sessionId: string,
    attachments: readonly ChatAttachment[]
  ): Promise<ChatAttachment[]> {
    const store = this.deps.attachments;
    if (!store || attachments.length === 0) return [];

    const present = await Promise.all(
      attachments.map(async attachment => ((await store.read(sessionId, attachment.id)) ? attachment : null))
    );
    return present.filter((attachment): attachment is ChatAttachment => attachment !== null);
  }

  /**
   * Refuse a turn whose images the chosen model cannot see.
   *
   * Only on an explicit `supportsVision: false`. The catalog carries the flag for the backends
   * that report it and says nothing for the rest, so treating silence as "no" would refuse
   * images on models that handle them fine - and a model that really cannot will reject the
   * request itself, which is a worse message but an honest one. Sending an image to a model
   * known not to read it is the only case with no upside.
   */
  private refuseUnreadableImages(model: string, attachments: readonly ChatAttachment[]): string | null {
    if (!attachments.some(attachment => attachment.kind === 'image')) return null;

    const option = this.deps.models?.cached()?.find(candidate => candidate.id === model);
    if (!option || option.supportsVision !== false) return null;

    return `${option.name} cannot read images. Pick a model that can, or remove the image before sending.`;
  }

  private async pruneAttachments(session: ChatSession): Promise<void> {
    const store = this.deps.attachments;
    if (!store) return;
    // The queue is consulted as well as the thread: a queued message's files are on disk and
    // referenced by nothing persisted, so pruning on the thread alone would delete the
    // attachments of a message that has not been sent yet.
    const referenced = new Set([
      ...session.messages.flatMap(message => (message.attachments ?? []).map(attachment => attachment.id)),
      ...(this.deps.queue?.attachmentIds(session.id) ?? []),
    ]);
    await store.prune(session.id, referenced).catch(err => {
      this.deps.logger.debug(`CHAT: pruning attachments failed: ${err instanceof Error ? err.message : 'unknown'}`);
    });
  }

  /**
   * Stream one reply. The return value is what the queue turns on, so it names the three ends
   * a turn can have rather than leaving them to be inferred from the events: only 'completed'
   * releases a queued message.
   */
  private async runReply(
    session: ChatSession,
    replyId: string,
    api: AuthenticatedApiClient,
    controller: AbortController
  ): Promise<TurnOutcome> {
    const sessionId = session.id;
    this.deps.emit({ type: 'start', sessionId, messageId: replyId });

    let content = '';
    let stopReason: string | undefined;
    let usage: ChatUsage | undefined;
    const toolCalls: ChatToolCall[] = [];
    let thinking: unknown[] | undefined;

    try {
      const serverConfig = await this.resolveServerConfig(api);
      const { roots, workingDirectory } = await this.resolveToolScope(session);
      const media = this.buildMediaContext(session, api, serverConfig.cdnUrl);
      const tools = toolsForRequest({ roots, media: !!media });
      const wire = await toCompletionMessages(
        session,
        (attachment: ChatAttachment) => this.deps.attachments?.read(session.id, attachment.id) ?? Promise.resolve(null)
      );
      wire.unshift(buildSystemMessage(roots, !!media, session.project));

      for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        const requested: RequestedTool[] = [];
        let turnText = '';
        let turnThinking: unknown[] | undefined;
        let turnUsage: ChatUsage | undefined;

        await streamCompletion(
          api.getAxiosInstance(),
          serverConfig.endpoint,
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
            if (event.usage) turnUsage = event.usage;
          },
          controller.signal
        );

        // Within one request the server's counts are cumulative, so the last report wins; across
        // the requests an agent turn makes they are separate bills, so the turn's cost is their
        // sum. Emitted here rather than only on 'done' so the status line can show a real number
        // from the first round trip on - the alternative is a field that stays blank for a
        // minute, or one filled in with a guess.
        usage = addUsage(usage, turnUsage);
        if (usage) this.deps.emit({ type: 'usage', sessionId, messageId: replyId, usage });

        if (controller.signal.aborted) break;
        if (requested.length === 0) break;

        thinking = turnThinking;
        const settled = await this.runTools(
          requested,
          roots,
          workingDirectory,
          media,
          sessionId,
          replyId,
          controller.signal
        );
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
      // A truncated reply ('max_tokens', 'tool_turn_limit') still counts as completed: the model
      // answered and the user can read it. Only the user's own stop is 'aborted'.
      return controller.signal.aborted ? 'aborted' : 'completed';
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
      return 'failed';
    }
  }

  /**
   * Hand the queue whatever the turn just did.
   *
   * Anchored to the reply promise rather than to a status, which is what keeps a queued
   * message from jumping the approval gate: a turn parked at the gate has not resolved, so
   * this has not run. The gate cannot be raced because it is not consulted.
   *
   * A turn that did not succeed does not release the queue at all. Stopping a reply is the
   * user changing their mind about the answer they were queueing against, and an errored turn
   * would usually just take the queued message into the same wall - so both give the text back
   * to the composer, where the user decides whether it still says what they meant.
   */
  private settleQueue(sessionId: string, outcome: TurnOutcome): void {
    if (outcome === 'completed') {
      this.flushQueue(sessionId);
      return;
    }
    this.deps.queue?.releaseAll(sessionId, outcome === 'aborted' ? 'stopped' : 'failed');
  }

  /**
   * Send the oldest queued message as the next turn.
   *
   * The turn it starts installs this same hook, so a queue of several drains FIFO on its own -
   * each message is a turn of its own, in the order it was typed, and one that fails stops the
   * chain and returns the rest.
   */
  private flushQueue(sessionId: string): void {
    const queue = this.deps.queue;
    // A newer turn is already running (the user sent one by hand in the gap): its own ending
    // flushes this, so taking a message out now would only put it behind that turn again.
    if (!queue || this.active.has(sessionId)) return;

    const next = queue.takeNext(sessionId);
    if (!next) return;

    void this.send(sessionId, next.text, next.attachments ?? [], next).then(result => {
      if (result.ok) return;
      // Its turn came and main refused it - signed out since, or a model reconciled to one that
      // cannot read the image it carries. It is out of the queue by now, so it is handed back
      // explicitly, ahead of anything still waiting behind it.
      queue.giveBack(sessionId, [next], 'refused', result.error);
    });
  }

  /**
   * Run every tool the model asked for, in parallel, reporting each to the UI as it starts and
   * finishes. A tool that throws is reported back to the MODEL as a failed result rather than
   * aborting the turn: "that path is not granted" is something it can act on.
   */
  private async runTools(
    requested: readonly RequestedTool[],
    roots: readonly string[],
    workingDirectory: string | undefined,
    media: MediaContext | undefined,
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

        // Collected as the tool runs and folded onto the settled call. The media and the notice
        // are kept even when the call then FAILS: a generation can produce a notice worth
        // showing ("out of credits") precisely because it did not produce anything else.
        const attachments: ChatMedia[] = [];
        let notice: ChatToolNotice | undefined;
        const report: ToolReporter = {
          progress: text => this.deps.emit({ type: 'tool-progress', sessionId, messageId, callId: call.id, text }),
          media: item => attachments.push(item),
          notice: value => {
            notice = value;
          },
        };
        const decorate = (settled: ChatToolCall): ChatToolCall => ({
          ...settled,
          ...(attachments.length > 0 ? { media: attachments } : {}),
          ...(notice ? { notice } : {}),
        });

        const context: ToolContext = {
          roots,
          workingDirectory,
          signal,
          protectedPaths: this.deps.protectedPaths,
          sessionId,
          background: this.deps.background,
          ...(media ? { media } : {}),
          report,
        };

        // Asked BEFORE 'running' is announced, so the UI never shows a command as under way
        // while it is still waiting on the user, and nothing has run if they say no.
        const denial = await this.awaitApproval(tool, call, context, sessionId, messageId, signal);
        if (denial) return denial;

        this.deps.emit({ type: 'tool-start', sessionId, messageId, call });

        let settled: ChatToolCall;
        try {
          const result = await tool.run(call.input, context);
          settled = decorate({ ...call, status: 'done', preview: capOutput(result) });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.deps.logger.debug(`CHAT: tool ${request.name} failed: ${message}`);
          settled = decorate({
            ...call,
            // A refusal is its own state: the UI says "denied", not "something broke".
            status: err instanceof Error && err.name === 'PathAccessDenied' ? 'denied' : 'error',
            error: message,
          });
        }

        this.deps.emit({ type: 'tool-end', sessionId, messageId, call: settled });
        return settled;
      })
    );
  }

  /**
   * What the generation tools need for this turn, or undefined when nothing can be generated.
   *
   * Built per turn rather than per app, because it closes over the conversation: the b4m
   * notebook the generations are filed under belongs to this conversation, and the local
   * session id decides which media folder the bytes land in.
   */
  private buildMediaContext(
    session: ChatSession,
    api: AuthenticatedApiClient,
    cdnUrl: string
  ): MediaContext | undefined {
    const store = this.deps.media;
    const models = this.deps.models;
    if (!store) return undefined;

    let remoteSessionId = session.remoteSessionId;
    return {
      client: new MediaApiClient(api),
      store,
      cdnUrl,
      notebookName: session.title,
      listImageModels: () => models?.listImageModels() ?? Promise.resolve([]),
      getRemoteSessionId: () => remoteSessionId,
      setRemoteSessionId: async value => {
        remoteSessionId = value;
        await this.deps.store.setRemoteSessionId(session.id, value);
      },
    };
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
   * Where to POST completions, and where generated files are served from.
   *
   * Hosted deploys route the same-origin completions path to the ChatCompletion service, but a
   * self-host stack has no CDN doing that and advertises the service's own origin as
   * `sseCompletionsUrl` instead. `cdnUrl` is the sibling question for generated media: absolute
   * on a hosted CDN, and the relative local file-proxy path on self-host. A failed lookup is
   * non-fatal - the same-origin path is the right guess for deploys that omit the field, and an
   * empty `cdnUrl` only means image generation falls back to the URLs the quest itself carries.
   */
  private async resolveServerConfig(api: AuthenticatedApiClient): Promise<ResolvedServerConfig> {
    const environmentUrl = this.deps.getEnvironmentUrl();
    if (this.serverConfigCache?.environmentUrl === environmentUrl) return this.serverConfigCache.config;

    const config: ResolvedServerConfig = { endpoint: DEFAULT_COMPLETIONS_PATH, cdnUrl: '' };
    try {
      const served = await api.get<ServerTransportConfig>('/api/settings/serverConfig');
      if (served?.sseCompletionsUrl) config.endpoint = served.sseCompletionsUrl;
      if (served?.cdnUrl) config.cdnUrl = served.cdnUrl;
    } catch (err) {
      this.deps.logger.debug(
        `CHAT: serverConfig lookup failed, using ${DEFAULT_COMPLETIONS_PATH}: ${
          err instanceof Error ? err.message : 'unknown'
        }`
      );
    }

    this.serverConfigCache = { environmentUrl, config };
    return config;
  }
}

/**
 * What a Code session tells the model about where it is.
 *
 * The worktree line is not decoration: the branch is checked out at a path that is NOT the
 * project directory the user talks about, so a model told only the project path would keep
 * proposing commands against the wrong checkout.
 */
function projectPreamble(project: ChatProject): string[] {
  const lines = [
    `This conversation is about the project ${project.name}, at ${project.directory}.`,
    `Commands run in ${project.workingDirectory} unless you name another folder, and a relative`,
    'path resolves against it.',
  ];
  if (project.workspace && project.workingDirectory !== project.directory) {
    lines.push(
      `That is a git worktree for the branch ${project.branch}, not the main checkout. Work there:`,
      'changes made in the project directory itself would be on a different branch.'
    );
  } else if (project.branch) {
    lines.push(`The branch is ${project.branch}.`);
  }
  return lines;
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
function buildSystemMessage(roots: readonly string[], media: boolean, project?: ChatProject): CompletionMessage {
  if (roots.length === 0) {
    return {
      role: 'system',
      content: [
        'You currently have NO access to the user files or filesystem, and no tools to read them.',
        'Earlier turns in this conversation may show successful file reads; that access has since',
        'been revoked and you cannot rely on it.',
        'Never claim to have read, listed or searched a file, and never invent a file name, size,',
        'path or contents. If asked about local files, say plainly that you have no access and ask',
        'the user to give this conversation a folder: a Code session takes one from the folder chip',
        'above the message box, and the sidebar card shares one with every conversation.',
        ...(media ? MEDIA_GUIDANCE : []),
      ].join('\n'),
    };
  }

  return {
    role: 'system',
    content: [
      'You can read and change files on the user machine, and run bash commands on it, with the',
      'provided tools.',
      ...(project ? projectPreamble(project) : []),
      'These folders are shared with you, including everything beneath them:',
      ...roots.map(root => `  ${root}`),
      'Always pass absolute paths. Any path outside those folders is denied;',
      'if you need one, ask the user to add it from the chip row above the message box.',
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
      ...(media ? MEDIA_GUIDANCE : []),
    ].join('\n'),
  };
}

/**
 * What the model has to know about the generation tools, in both access states.
 *
 * Two things, both learned the same way the file guidance was. The tools spend real money, so
 * the model must not reach for one speculatively or retry a refusal. And their output goes to
 * the USER, not into the conversation - a model that has just "generated an image" will
 * otherwise describe what is in it, which it cannot possibly know.
 */
const MEDIA_GUIDANCE: readonly string[] = [
  'You can also generate images and audio on the Bike4Mind server with generate_image,',
  'generate_speech, generate_sound_effect and generate_music.',
  'Each of these SPENDS THE USER CREDITS and each asks them to approve it first, so use one only',
  'when the user has asked for that thing - never to check whether it works, and never as a',
  'flourish alongside a text answer. If they decline, do not try a variation; ask what they want.',
  'The result is shown or played to the USER and is never returned to you: you cannot see the',
  'image or hear the audio. Never describe what a generated image depicts or how audio sounds.',
];

/**
 * Add one round trip's reported usage to the turn's running total.
 *
 * Absent stays absent: a server that reported nothing must not be made to look like it reported
 * zero, because the status line draws the field only once there is a real number behind it.
 */
export function addUsage(total: ChatUsage | undefined, next: ChatUsage | undefined): ChatUsage | undefined {
  if (!next) return total;
  if (!total) return next;
  const inputTokens = (total.inputTokens ?? 0) + (next.inputTokens ?? 0);
  const outputTokens = (total.outputTokens ?? 0) + (next.outputTokens ?? 0);
  return {
    ...(total.inputTokens === undefined && next.inputTokens === undefined ? {} : { inputTokens }),
    ...(total.outputTokens === undefined && next.outputTokens === undefined ? {} : { outputTokens }),
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
async function toCompletionMessages(
  session: ChatSession,
  readAttachment: ReadAttachment
): Promise<CompletionMessage[]> {
  const wire: CompletionMessage[] = [];

  for (const message of session.messages) {
    const calls = message.toolCalls ?? [];
    if (calls.length === 0) {
      const attachments = message.attachments ?? [];
      if (attachments.length > 0) {
        const content = await toAttachedContent(message.content, attachments, readAttachment);
        if (content.length > 0) wire.push({ role: message.role, content });
        continue;
      }
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

/** Reads one attachment's stored bytes, or null when the file is gone. */
type ReadAttachment = (attachment: ChatAttachment) => Promise<Buffer | null>;

/**
 * A user turn that carried attachments, as provider-shaped content blocks.
 *
 * Images go FIRST and as real image blocks: the point of this feature is that a screenshot
 * arrives as pixels rather than as a filename the model then invents contents for. Text files
 * are inlined into the single text block ahead of the user's own words, so the question they
 * are asking is the last thing the model reads.
 *
 * An attachment whose bytes have vanished is skipped rather than faked - a placeholder saying
 * "image.png" is exactly the filename-instead-of-image failure this exists to avoid.
 */
async function toAttachedContent(
  prompt: string,
  attachments: readonly ChatAttachment[],
  readAttachment: ReadAttachment
): Promise<unknown[]> {
  const blocks: unknown[] = [];
  const sections: string[] = [];

  for (const attachment of attachments) {
    const bytes = await readAttachment(attachment);
    if (!bytes) continue;

    if (attachment.kind === 'image') {
      // Anthropic's block shape; the completions endpoint canonicalizes it for every other
      // provider (see normalizeMultimodalMessages in @bike4mind/common).
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: attachment.mediaType, data: bytes.toString('base64') },
      });
      continue;
    }

    sections.push(textAttachmentBlock(attachment, bytes.toString('utf8')));
  }

  const text = [...sections, prompt].filter(part => part.length > 0).join('\n\n');
  if (text.length > 0) blocks.push({ type: 'text', text });
  return blocks;
}
