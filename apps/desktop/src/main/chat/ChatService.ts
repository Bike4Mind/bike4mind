import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type {
  ChatApprovalMode,
  ChatArtifact,
  ChatAttachment,
  ChatMedia,
  ChatMessage,
  ChatModelCatalog,
  ChatModelOption,
  ChatPendingApproval,
  ChatProject,
  ChatQueuedMessage,
  ChatReplyRound,
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
import { isTurnBudgetStop } from '@shared/chat';
import type { ArtifactPublisher } from './artifacts/ArtifactPublisher';
import { extractArtifacts, restoreArtifactMarkup } from './artifacts/extract';
import { DESKTOP_ARTIFACT_PROMPT } from './artifacts/prompt';
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
import { isValidSessionId, type SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import type { ApprovalGate } from './tools/ApprovalGate';
import type { BackgroundProcessRegistry } from './tools/BackgroundProcessRegistry';
import { findTool, toolsForRequest } from './tools/registry';
import { assessApprovalRisk, spendsCredits } from './tools/riskAssessment';
import {
  capOutput,
  type ApprovalPrompt,
  type HostContext,
  type HostSessionView,
  type MediaContext,
  type SpawnOutcome,
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
 * What one user turn is allowed to spend before the loop stops it.
 *
 * A model that keeps calling tools without concluding would bill and run forever, so a turn
 * needs SOME bound. A bare round-trip count is a poor one: reading a file, searching and
 * writing one file is already several rounds, and real coding turns run to dozens or hundreds,
 * so any count low enough to catch a runaway early also kills ordinary work. These three bound
 * the two things that actually go wrong - spending without end, and spinning in place - and
 * leave a working turn alone.
 *
 * `rounds` is the backstop rather than the primary guard: high enough that no real turn has
 * reached it, finite so a turn always ends.
 *
 * `stalledRounds` is the real runaway detector. A model that asks for the SAME tool calls, with
 * the same arguments, several rounds running is not making progress whatever the results say;
 * legitimate work repeats a command (re-running a test) but does not repeat an identical round
 * five times. This catches a loop in seconds where a count would take minutes.
 *
 * `wallClockMs` bounds the case neither of the others sees: rounds that each make progress but
 * grind on far past the point the user would have wanted a say. It is wall clock rather than
 * tokens on purpose - the server's usage numbers are optional on the wire, and a guard that
 * silently stops existing when a field is missing is not a guard.
 *
 * Hitting any of them ends the turn with whatever it has, flagged so the UI can show it was cut
 * short rather than finished, and offer to carry on. See isTurnBudgetStop.
 */
export interface TurnLimits {
  rounds: number;
  /** Identical rounds IN A ROW, counted as repeats: this many after the first end the turn. */
  stalledRounds: number;
  wallClockMs: number;
}

const TURN_LIMITS: TurnLimits = {
  rounds: 200,
  stalledRounds: 5,
  wallClockMs: 30 * 60 * 1000,
};

/** How a turn ended. Only 'completed' lets a queued message go out; see settleQueue. */
type TurnOutcome = 'completed' | 'aborted' | 'failed';

/**
 * How many agent-spawned sessions may have a reply in flight at once, across the whole app.
 *
 * One of the two caps that make spawning safe, and neither is sufficient alone: the depth cap
 * stops a chain, and this stops a fan. Without both, one session spawning sessions is a fork
 * bomb that spends the user real credits, so this is a correctness bound rather than a tuning
 * knob - a refusal here is the right outcome, not a queue to drain.
 *
 * Counts autonomous runs only. A user typing into a spawned session is not rationed.
 */
const MAX_CONCURRENT_SPAWNED = 3;

/**
 * How deep the spawn chain may go. A session the user made is depth 0, so this admits a child
 * and a grandchild and refuses the next one.
 *
 * Read off the child's stored `origin.depth` rather than walked back up the parent chain,
 * because a parent can be deleted mid-run and a cap that stops being enforceable when a row
 * disappears is not a cap.
 */
const MAX_SPAWN_DEPTH = 2;

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
  /**
   * Copies emitted artifacts to the server. Absent in tests, and in that case a reply's
   * artifacts are still parsed and shown - they simply exist only on this machine.
   */
  artifacts?: ArtifactPublisher;
  /**
   * Tightens a turn's budget. Only tests set it: exercising a guard whose production values are
   * hundreds of rounds and half an hour of wall clock is not something a unit test can afford
   * to do at full size.
   */
  turnLimits?: Partial<TurnLimits>;
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
 * What a reply that ran out of budget hands back to the run that carries it on.
 *
 * Carried forward rather than re-derived from the stored message because two of the three
 * fields cannot be recovered from it: the text has had its artifact markup stripped, and
 * re-extracting restored markup would mint fresh ids and publish the same artifacts twice.
 */
interface ResumedReply {
  content: string;
  rounds: ChatReplyRound[];
  toolCalls: ChatToolCall[];
  artifacts: ChatArtifact[];
}

/** One round as it is produced, before its artifact markup is parsed out of the text. */
interface RawRound {
  text: string;
  toolCallIds: string[];
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

  /**
   * Spawned sessions whose seeded run has not finished, and who to tell when it does.
   *
   * Only the AUTONOMOUS turn is tracked. A later turn the user types into the same session is
   * an ordinary conversation and neither counts against the concurrency cap nor reports back.
   */
  private readonly spawnWatch = new Map<string, { parentSessionId: string }>();

  /**
   * Spawns that have passed the cap check but whose session does not exist yet.
   *
   * Counted separately and incremented SYNCHRONOUSLY, because the model can ask for several
   * spawns in one turn and `runTools` runs them in parallel: two creates that both awaited
   * before either was visible would both pass a check made against `spawnWatch` alone.
   */
  private spawnReservations = 0;

  /** Finished children waiting for their parent to be idle, so a report never splits a turn. */
  private readonly childReports = new Map<string, string[]>();

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

  /**
   * Every tool call waiting on the user, in any conversation.
   *
   * Read by the cross-session inbox. An autonomous session raises approvals inside a
   * conversation nobody is looking at, so the answer has to be reachable from wherever the user
   * actually is - see ChatPendingApproval.
   */
  pendingApprovals(): ChatPendingApproval[] {
    return this.deps.approvals?.pendingApprovals() ?? [];
  }

  setSessionArchived(sessionId: string, archived: boolean): Promise<ChatSessionSummary | null> {
    return this.deps.store.setArchived(sessionId, archived);
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
      return { ok: true, session: await this.deps.store.create(model, { mode: 'code' }) };
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
      project: {
        directory,
        name: await projectDisplayName(directory),
        branch,
        workspace: request.workspace === true,
        workingDirectory,
        contextDirectories: (request.contextDirectories ?? []).map(entry => resolve(entry)),
      },
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

  /**
   * Set how much this conversation may do without asking.
   *
   * Reached from one IPC channel the composer pill calls, and from nothing else. It is not on
   * HostContext, it is not in ToolContext, and no tool schema mentions it - a tool able to
   * raise its own approval mode would turn a single prompt injection into unrestricted read
   * access to the machine, which is the one escalation this whole feature has to not have.
   */
  setApprovalMode(sessionId: string, mode: ChatApprovalMode): Promise<ChatSessionSummary | null> {
    return this.deps.store.setApprovalMode(sessionId, mode);
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
    // A deleted session is neither a child that can still report nor a parent that can still be
    // told. Dropping the watch here is also what gives its concurrency slot back, so deleting a
    // running spawned session does not leak one for the rest of the run.
    this.spawnWatch.delete(sessionId);
    this.childReports.delete(sessionId);
    for (const [childId, watch] of this.spawnWatch) {
      if (watch.parentSessionId === sessionId) this.spawnWatch.delete(childId);
    }
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

    const replyId = this.startReply(session, api);
    return { ok: true, messageId: replyId, ...(notice ? { notice } : {}) };
  }

  /**
   * Carry on a turn the loop's own budget stopped, in place.
   *
   * Genuine resumption, not a re-prompt: the completions endpoint is stateless, so a turn's
   * whole state IS its transcript, and an interrupted turn's transcript already ends on a
   * complete round of tool results - exactly the shape a fresh request continues from. Nothing
   * synthetic is appended, and the model picks up with every file it read and wrote still in
   * front of it. The one thing it does not get back is the ROUND STRUCTURE: the interrupted
   * turn's rounds were flattened into a single stored assistant message when it landed, so the
   * model sees all of its own tool calls as one batch rather than the sequence it made them in.
   * That is the same replay a typed follow-up gets today, and it costs the ordering, not the
   * work.
   *
   * Refused rather than silently re-prompting when the last turn was not budget-stopped, so
   * this can never be the thing that makes a finished conversation spend another turn.
   */
  async continueReply(sessionId: string): Promise<SendMessageResult> {
    if (this.active.has(sessionId)) return { ok: false, error: 'This conversation is still replying.' };

    const api = this.deps.getApiClient();
    if (!api) return { ok: false, error: 'Sign in to continue this reply.' };

    const session = await this.deps.store.get(sessionId);
    if (!session) return { ok: false, error: 'That conversation no longer exists.' };

    const last = session.messages[session.messages.length - 1];
    if (!last || last.role !== 'assistant' || !isTurnBudgetStop(last.stopReason)) {
      return { ok: false, error: 'There is nothing to continue here.' };
    }

    const replyId = this.startReply(session, api, {
      id: last.id,
      content: last.content,
      // A message stored before rounds were recorded resumes as one round holding everything it
      // said and everything it ran, which is the most the flat shape supports: the turn carries
      // on correctly, and only the ordering of what came BEFORE stays unrecoverable.
      rounds: last.rounds ?? [{ text: last.content, toolCallIds: (last.toolCalls ?? []).map(call => call.id) }],
      toolCalls: last.toolCalls ?? [],
      artifacts: last.artifacts ?? [],
    });
    return { ok: true, messageId: replyId };
  }

  /**
   * Put a reply in flight and own its lifetime. Returns the message id it will arrive under -
   * a fresh one, or the interrupted message's when this run is carrying that one on.
   */
  private startReply(
    session: ChatSession,
    api: AuthenticatedApiClient,
    resume?: ResumedReply & { id: string }
  ): string {
    const sessionId = session.id;
    const replyId = resume?.id ?? randomUUID();
    const controller = new AbortController();
    this.active.set(sessionId, controller);
    this.deps.activity?.replyStarted(sessionId);

    void this.runReply(session, replyId, api, controller, resume)
      // runReply already catches, so this only covers a throw from its own bookkeeping. A turn
      // whose end cannot be classified is treated as failed, which HOLDS the queue rather than
      // firing it - the safe direction when the outcome is unknown.
      .catch(() => 'failed' as const)
      .then(async outcome => {
        // Only clear if still ours: a delete-then-recreate could have installed a newer one, and
        // telling activity this reply ended would then mark a live one idle.
        if (this.active.get(sessionId) !== controller) return;
        this.active.delete(sessionId);
        this.deps.activity?.replyEnded(sessionId);
        // All three need the session to be idle, and this is the moment it becomes so: a
        // spawned run gives its concurrency slot back and reports to its parent, and a parent
        // that was mid-turn takes delivery of anything that finished while it was busy.
        // Reporting to the PARENT writes a different session's file, so it needs no ordering here.
        void this.settleSpawnedTurn(sessionId);

        // Awaited, and before the queue: both append to THIS session, and appendMessage is a
        // read-modify-write with no lock of its own - overlapping them would let the later
        // write drop the earlier message. Ordering them here is cheaper than a store-wide lock
        // and keeps the report above the turn that answers it.
        await this.flushChildReports(sessionId).catch(() => undefined);
        this.settleQueue(sessionId, outcome);
      });

    return replyId;
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
    controller: AbortController,
    resume?: ResumedReply
  ): Promise<TurnOutcome> {
    const sessionId = session.id;
    const limits = { ...TURN_LIMITS, ...this.deps.turnLimits };
    const deadline = Date.now() + limits.wallClockMs;
    this.deps.emit({ type: 'start', sessionId, messageId: replyId });

    // Seeded from the interrupted run on a resume, so `done` carries the whole reply: the
    // renderer replaces the message's text with it rather than extending what it already shows.
    let content = resume?.content ?? '';
    let stopReason: string | undefined;
    let usage: ChatUsage | undefined;
    const toolCalls: ChatToolCall[] = [...(resume?.toolCalls ?? [])];
    let thinking: unknown[] | undefined;
    let previousRound: string | null = null;
    let stalled = 0;
    // Only this run's rounds: the resumed ones were parsed and cleaned when they were stored,
    // and putting them back through the artifact parser would mint their ids a second time.
    const produced: RawRound[] = [];

    try {
      const serverConfig = await this.resolveServerConfig(api);
      const { roots, workingDirectory } = await this.resolveToolScope(session);
      const media = this.buildMediaContext(session, api, serverConfig.cdnUrl);
      const host = this.buildHostContext(session);
      const tools = toolsForRequest({ roots, media: !!media, host: !!host });
      const wire = await toCompletionMessages(
        session,
        (attachment: ChatAttachment) => this.deps.attachments?.read(session.id, attachment.id) ?? Promise.resolve(null)
      );
      wire.unshift(buildSystemMessage(roots, !!media, !!host, session.project));

      for (let roundIndex = 0; roundIndex < limits.rounds; roundIndex++) {
        const requested: RequestedTool[] = [];
        let turnText = '';
        let turnThinking: unknown[] | undefined;
        let turnUsage: ChatUsage | undefined;

        const failure = await streamRound(
          api.getAxiosInstance(),
          serverConfig.endpoint,
          { model: session.model, messages: wire, tools },
          event => {
            // `error` never reaches here (the transport throws on it); `meta` carries no reply.
            if (event.type === 'error' || event.type === 'meta') return;
            if (event.text) {
              // Every round streams into the SAME message, so without a break here the last
              // sentence of one round runs into the first word of the next. On the emitted
              // text only: the wire keeps its own round structure and needs no filler.
              const text = turnText.length === 0 ? paragraphBreak(content) + event.text : event.text;
              content += text;
              turnText += event.text;
              this.deps.emit({ type: 'delta', sessionId, messageId: replyId, text });
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

        // Recorded before the exits below, so the round that ENDS a turn - the one carrying the
        // answer, which by definition runs no tools - is part of the structure rather than the
        // one piece of prose the thread has to guess a home for.
        const round: RawRound = { text: turnText, toolCallIds: [] };
        produced.push(round);

        // Within one request the server's counts are cumulative, so the last report wins; across
        // the requests an agent turn makes they are separate bills, so the turn's cost is their
        // sum. Emitted here rather than only on 'done' so the status line can show a real number
        // from the first round trip on - the alternative is a field that stays blank for a
        // minute, or one filled in with a guess.
        usage = addUsage(usage, turnUsage);
        if (usage) this.deps.emit({ type: 'usage', sessionId, messageId: replyId, usage });

        // A turn whose context has run out is not a failed request to report: the rounds before
        // it did real work, and the same request cannot be made to succeed by trying again. It
        // ends the turn here, keeping what it has, with a reason of its own. See isTurnBudgetStop
        // - deliberately not one of them, because Continue would re-send the same oversized
        // conversation and fail identically.
        if (failure) {
          if (!isContextOverflow(failure)) throw failure;
          this.deps.logger.warn(`CHAT: turn stopped, context exhausted: ${failure.message}`);
          stopReason = 'context_limit';
          break;
        }

        if (controller.signal.aborted) break;
        if (requested.length === 0) break;

        // A round asking for exactly what the last one did has learned nothing from the
        // results. One repeat is ordinary work (re-running a test after an edit); this many in
        // a row is a loop, and stopping here costs the user one wasted round rather than the
        // minutes a round count would take to notice.
        const signature = roundSignature(requested);
        stalled = signature === previousRound ? stalled + 1 : 0;
        previousRound = signature;
        if (stalled >= limits.stalledRounds) {
          stopReason = 'tool_stall_limit';
          break;
        }

        thinking = turnThinking;
        const settled = await this.runTools(
          requested,
          { roots, workingDirectory, media, host, title: session.title },
          sessionId,
          replyId,
          controller.signal
        );
        toolCalls.push(...settled);
        round.toolCallIds = settled.map(call => call.id);

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

        // Checked after a round rather than before one, so a turn is never cut between asking
        // for a tool and reporting what it returned.
        if (Date.now() >= deadline) {
          stopReason = 'turn_time_limit';
          break;
        }
        if (roundIndex === limits.rounds - 1) stopReason = 'tool_turn_limit';
      }

      if (controller.signal.aborted) stopReason = 'aborted';

      // Artifacts are resolved BEFORE the message is stored or announced, so the thread never
      // shows raw <artifact> markup that is then replaced, and a reloaded conversation reads
      // back exactly what the live one showed. An aborted reply is included on purpose: a
      // complete artifact followed by a stop is still a complete artifact.
      // Parsed per round rather than over the whole reply: an artifact is emitted inside one
      // round's text and never spans two, and this is what keeps each round's prose and its own
      // cards together once the markup is out.
      const parsed = produced.map(round => ({ round, ...extractArtifacts(round.text) }));
      const newArtifacts = parsed.flatMap(entry => entry.artifacts);
      const published =
        newArtifacts.length > 0 && this.deps.artifacts
          ? await this.deps.artifacts.publish(newArtifacts, sessionId)
          : newArtifacts;
      // A resumed run only ever sees markup the rounds AFTER the interruption emitted - the
      // seeded rounds were stripped before they were stored - so the earlier artifacts are
      // carried across rather than parsed again, and none of them is published twice.
      const artifacts = [...(resume?.artifacts ?? []), ...published];

      const rounds = [
        ...(resume?.rounds ?? []),
        ...parsed
          // Trimmed so the join below lands exactly one blank line between rounds, and so a
          // round does not draw a gap under itself where the model happened to end on newlines.
          .map(entry => ({ text: entry.content.trim(), toolCallIds: entry.round.toolCallIds }))
          .filter(round => round.text.length > 0 || round.toolCallIds.length > 0),
      ];
      const finalContent = joinRounds(rounds.map(round => round.text));

      await this.settleReply(sessionId, !!resume, {
        id: replyId,
        role: 'assistant',
        content: finalContent,
        createdAt: new Date().toISOString(),
        stopReason,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(toolCalls.length > 0 ? { rounds } : {}),
        ...(thinking ? { thinking } : {}),
        ...(artifacts.length > 0 ? { artifacts } : {}),
      });
      this.deps.emit({
        type: 'done',
        sessionId,
        messageId: replyId,
        content: finalContent,
        stopReason,
        usage,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(toolCalls.length > 0 ? { rounds } : {}),
        ...(artifacts.length > 0 ? { artifacts } : {}),
      });
      // A truncated reply ('max_tokens'), a budget stop and a context stop all count as
      // completed: the model said something and the user can read it. Only the user's own stop
      // is 'aborted'.
      //
      // So a turn that ran out of budget with a message typed ahead of it sends that message
      // rather than offering Continue - the queued turn takes its place, and it resumes the
      // work too, since the model still sees the interrupted turn's tool results and now has
      // the user's next instruction as well. Deliberate: holding the queue here would strand a
      // message the user has already typed behind a button they may never press.
      return controller.signal.aborted ? 'aborted' : 'completed';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn(`CHAT: reply failed: ${message}`);

      // Persisted even though it failed: a thread that silently drops the turn leaves the
      // user's own prompt sitting there with no explanation next time they open it.
      await this.settleReply(sessionId, !!resume, {
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
   * Write a finished reply to its message: a new one normally, an overwrite when this run
   * carried on an earlier one.
   *
   * A resumed run keeps the original message rather than adding a second assistant turn beside
   * it, because it IS the same turn - one the budget interrupted. Two bubbles with a "stopped
   * short" chip stranded between them would describe the loop's bookkeeping rather than what
   * the model did.
   */
  private async settleReply(sessionId: string, resumed: boolean, message: ChatMessage): Promise<void> {
    if (!resumed) {
      await this.deps.store.appendMessage(sessionId, message);
      return;
    }
    // stopReason and error are set explicitly, undefined included: a resumed run that finishes
    // must clear the budget stop the previous one left behind, and `Partial` would keep it.
    await this.deps.store.updateMessage(sessionId, message.id, {
      content: message.content,
      stopReason: message.stopReason,
      error: message.error,
      toolCalls: message.toolCalls,
      rounds: message.rounds,
      thinking: message.thinking,
      artifacts: message.artifacts,
    });
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
    scope: {
      roots: readonly string[];
      workingDirectory: string | undefined;
      media: MediaContext | undefined;
      host: HostContext | undefined;
      /** The conversation's title, so a cross-session approval names it rather than its id. */
      title: string;
    },
    sessionId: string,
    messageId: string,
    signal: AbortSignal
  ): Promise<ChatToolCall[]> {
    const { roots, workingDirectory, media, host } = scope;
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
          ...(host ? { host } : {}),
          report,
        };

        // Asked BEFORE 'running' is announced, so the UI never shows a command as under way
        // while it is still waiting on the user, and nothing has run if they say no.
        const denial = await this.awaitApproval(tool, call, context, sessionId, scope.title, messageId, signal);
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
   * The app-control surface for one Code session, or undefined when there is nothing to scope to.
   *
   * Everything it offers is bounded by the caller's own project: it can see and change the
   * conversations in that project and no others. The one capability that creates something -
   * `spawn` - copies the caller's project binding verbatim, so the child's folder grants are
   * exactly the parent's. There is deliberately no argument through which a directory, a branch
   * or a worktree could be named: an agent that can pick where its child runs can grant itself
   * a root the user never approved, and the whole family rests on it not being able to.
   */
  private buildHostContext(session: ChatSession): HostContext | undefined {
    const project = session.project;
    if (!project) return undefined;

    const addressable = async (sessionId: string): Promise<ChatSession | null> => {
      if (!isValidSessionId(sessionId)) return null;
      const target = await this.deps.store.get(sessionId);
      // Project identity, not the working directory: two sessions in one project may sit in
      // different worktrees and are still the same group in the sidebar.
      if (!target?.project || target.project.directory !== project.directory) return null;
      return target;
    };

    return {
      spawn: (prompt, title) => this.spawnSession(session, prompt, title),

      listSessions: async ({ includeArchived }) => {
        const all = await this.deps.store.list();
        return all
          .filter(entry => entry.project?.directory === project.directory)
          .filter(entry => includeArchived || !entry.archived)
          .map(entry => this.toHostView(entry));
      },

      readSession: async sessionId => {
        const target = await addressable(sessionId);
        return target ? renderTranscript(target) : null;
      },

      setArchived: async (sessionId, archived) => {
        if (!(await addressable(sessionId))) return null;
        const updated = await this.deps.store.setArchived(sessionId, archived);
        return updated ? this.toHostView(updated) : null;
      },

      deleteSession: async sessionId => {
        if (!(await addressable(sessionId))) return false;
        await this.deleteSession(sessionId);
        return true;
      },

      describeSession: async sessionId => (await addressable(sessionId))?.title ?? null,
    };
  }

  private toHostView(entry: ChatSessionSummary): HostSessionView {
    return {
      id: entry.id,
      title: entry.title,
      messageCount: entry.messageCount,
      updatedAt: entry.updatedAt,
      archived: entry.archived === true,
      ...(entry.origin ? { spawnedBy: entry.origin.parentSessionId } : {}),
      status: this.deps.activity?.statusOf(entry.id) ?? 'done',
    };
  }

  /**
   * Create a session under the caller's project and set it running on `prompt`.
   *
   * Both caps are checked here and nowhere else, and the concurrency one reserves its slot
   * BEFORE the first await: `runTools` runs a turn's tool calls in parallel, so two spawns
   * asked for together would otherwise both read the count as it was before either of them.
   *
   * The child is created with the parent's model and the parent's project exactly as stored -
   * in particular its already-resolved `workingDirectory`, so spawning never creates a worktree
   * and never moves a checkout. A failure after the reservation releases it; a success hands it
   * to `spawnWatch`, which releases it when the seeded run ends.
   */
  private async spawnSession(parent: ChatSession, prompt: string, title?: string): Promise<SpawnOutcome> {
    const project = parent.project;
    if (!project) {
      return { ok: false, reason: 'no-project', message: 'Only a Code session, which has a project, can start one.' };
    }

    const seed = prompt.trim();
    if (!seed) {
      return { ok: false, reason: 'empty-prompt', message: 'A new session needs a prompt to work on.' };
    }

    const depth = (parent.origin?.depth ?? 0) + 1;
    if (depth > MAX_SPAWN_DEPTH) {
      return {
        ok: false,
        reason: 'depth',
        message:
          `Sessions may only be nested ${MAX_SPAWN_DEPTH} deep and this one is already at the limit. ` +
          'Do the work in this conversation instead; asking again will not help.',
      };
    }

    if (this.spawnLoad() >= MAX_CONCURRENT_SPAWNED) {
      return {
        ok: false,
        reason: 'concurrency',
        message:
          `${MAX_CONCURRENT_SPAWNED} started sessions are already running, which is the limit. ` +
          'Wait for one to finish before starting another, or do this work here.',
      };
    }
    this.spawnReservations++;

    try {
      const child = await this.deps.store.create(parent.model, {
        // Copied field by field rather than spread, so a field added to ChatProject later has
        // to be considered here: this object IS the child access to the filesystem.
        project: {
          directory: project.directory,
          name: project.name,
          branch: project.branch,
          workspace: project.workspace,
          workingDirectory: project.workingDirectory,
          contextDirectories: [...project.contextDirectories],
        },
        origin: { parentSessionId: parent.id, depth, seedPrompt: seed },
        // Inherit, never widen - the rule the folder grants above already follow - with one
        // ceiling on top of it: 'full' does not cross into a session nobody is watching. It
        // is the mode where a command may read any file on the machine, and it is already
        // scoped to the run of the app the user chose it in; handing it to an autonomous
        // child would make it outlive both the choice and the person who made it. There is
        // deliberately no argument on session_spawn through which a mode could be named.
        approvalMode: parent.approvalMode === 'full' ? 'auto' : parent.approvalMode,
      });

      const named = title?.trim() ? await this.deps.store.rename(child.id, title.trim()) : null;

      // Registered before the seed is sent: `send` resolves once the turn is accepted, and the
      // reply can finish - and look for its watch entry - before the await below returns.
      this.spawnWatch.set(child.id, { parentSessionId: parent.id });

      const sent = await this.send(child.id, seed);
      if (!sent.ok) {
        this.spawnWatch.delete(child.id);
        await this.deleteSession(child.id);
        return { ok: false, reason: 'no-project', message: `The new session could not start: ${sent.error}` };
      }

      this.deps.logger.debug(`CHAT: spawned ${child.id} from ${parent.id} at depth ${depth}`);
      return { ok: true, session: named ?? child };
    } finally {
      this.spawnReservations--;
    }
  }

  /** Autonomous runs in flight, counting the ones whose session is still being created. */
  private spawnLoad(): number {
    return this.spawnReservations + this.spawnWatch.size;
  }

  /**
   * A spawned session finished its seeded run: give the slot back and tell the parent.
   *
   * The parent is told through its transcript rather than by resuming it. Resuming would mean
   * the app starting a turn - and spending credits - with nobody having typed anything, which
   * is the unattended behaviour this task deliberately does not build. What lands instead is a
   * message the user reads and the model sees on the next turn either of them takes.
   */
  private async settleSpawnedTurn(sessionId: string): Promise<void> {
    const watch = this.spawnWatch.get(sessionId);
    if (!watch) return;
    this.spawnWatch.delete(sessionId);

    const child = await this.deps.store.get(sessionId);
    if (!child) return;
    await this.deliverChildReport(watch.parentSessionId, describeChildOutcome(child));
  }

  /**
   * Queue a finished child report for its parent, delivering it as soon as the parent is idle.
   *
   * Never appended into a turn that is running: the wire history is rebuilt from the stored
   * messages, and dropping a message in between a prompt and the reply it is still streaming
   * would leave two user turns back to back in the thread that replays next time.
   *
   * Queue first and then check, rather than the reverse - the parent can go idle between the
   * two, and the flush that would have carried this one has already run by then.
   */
  private async deliverChildReport(parentSessionId: string, text: string): Promise<void> {
    const queued = this.childReports.get(parentSessionId) ?? [];
    queued.push(text);
    this.childReports.set(parentSessionId, queued);
    if (!this.active.has(parentSessionId)) await this.flushChildReports(parentSessionId);
  }

  private async flushChildReports(sessionId: string): Promise<void> {
    const queued = this.childReports.get(sessionId);
    if (!queued || queued.length === 0) return;
    this.childReports.delete(sessionId);

    for (const text of queued) {
      const message: ChatMessage = {
        id: randomUUID(),
        role: 'user',
        content: text,
        createdAt: new Date().toISOString(),
        system: true,
      };
      const updated = await this.deps.store.appendMessage(sessionId, message);
      // The parent can have been deleted while its child was still running. The child keeps its
      // own row and its own transcript - it is a conversation in its own right - so the report
      // is simply dropped rather than the run being wasted.
      if (!updated) {
        this.deps.logger.debug(`CHAT: dropped a spawned-session report for ${sessionId}, which is gone`);
        return;
      }
      this.deps.emit({ type: 'message', sessionId, message });
    }
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
    sessionTitle: string,
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

    // An irreversible tool is asked every time, whatever was answered before: the standing set
    // is keyed on what a call WOULD do, and for something with no undo that is not a good
    // enough reason to skip asking. The gate refuses to record one for these either.
    if (!prompt.irreversible && gate.isStanding(sessionId, prompt.key)) return null;

    // Consulted AFTER tool.approval() ran, so a call that is refused outright - a path outside
    // every granted root - is still refused rather than waved through by a loose mode.
    if (await this.autoApproves(sessionId, call, prompt, context)) return null;

    const decision = await gate.request(
      sessionId,
      prompt.key,
      signal,
      {
        sessionTitle,
        toolName: call.name,
        detail: prompt.detail,
        ...(prompt.diff ? { diff: prompt.diff } : {}),
        ...(prompt.irreversible ? { irreversible: true } : {}),
      },
      approvalId => {
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
            ...(prompt.irreversible ? { approvalIrreversible: true } : {}),
          },
        });
      },
      { remember: !prompt.irreversible }
    );

    if (decision !== 'deny') return null;

    const denied: ChatToolCall = {
      ...call,
      status: 'denied',
      error: 'The user declined to run this. Do not try to run it again; ask them what to do instead.',
    };
    this.deps.emit({ type: 'tool-end', sessionId, messageId, call: denied });
    return denied;
  }

  /**
   * Whether this conversation's approval mode lets this particular call go ahead unasked.
   *
   * Read from the store rather than from the session captured when the turn started, so a user
   * who lowers the mode mid-reply is obeyed by the very next tool call rather than after it.
   *
   * The two exclusions hold in every mode, 'full' included. An irreversible call is asked
   * because there is nothing to undo it with, and a credit-spending call is asked because cost
   * is a different axis from filesystem risk: deciding the agent may edit files and run the
   * shell says nothing about whether the user wants to pay for an image.
   */
  private async autoApproves(
    sessionId: string,
    call: ChatToolCall,
    prompt: ApprovalPrompt,
    context: ToolContext
  ): Promise<boolean> {
    if (prompt.irreversible || spendsCredits(call.name)) return false;

    const mode = await this.deps.store.approvalMode(sessionId);
    if (mode === 'ask') return false;
    if (mode === 'full') return true;
    return (await assessApprovalRisk(call.name, call.input, prompt, context)) === 'contained';
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
function buildSystemMessage(
  roots: readonly string[],
  media: boolean,
  host: boolean,
  project?: ChatProject
): CompletionMessage {
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
        ...(host ? HOST_GUIDANCE : []),
        '',
        DESKTOP_ARTIFACT_PROMPT,
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
      ...(host ? HOST_GUIDANCE : []),
      '',
      DESKTOP_ARTIFACT_PROMPT,
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
 * What the model has to know about the app-control tools.
 *
 * Three things, and the first two are the ones that cost real money if it gets them wrong. A
 * spawned session is not a subroutine - it does not return a value into this turn, and a model
 * that treats it as one starts a second when the first "did not answer". And it starts with an
 * empty conversation: everything said here is invisible to it, so a prompt like "carry on with
 * that" spawns a session that cannot possibly know what "that" is.
 */
const HOST_GUIDANCE: readonly string[] = [
  'You can also work with the conversations in this project: session_list and session_read see',
  'them, session_spawn starts one, session_archive tidies one away and session_delete removes',
  'one permanently. They reach this project only, and a spawned session can read and change',
  'exactly the folders you can - it cannot be given others.',
  'A session you spawn runs on its own and does NOT report back into this turn. Finish your',
  'answer without it. Later, this conversation is told THAT it finished - never what it said,',
  'so use session_read on its id when you need that. Never start a second session because the',
  'first has not answered yet, and never start several to try',
  'variations of one task - each one spends the user credits and each one asks them to approve',
  'it first.',
  'A spawned session starts with an EMPTY conversation and cannot see anything said here, so its',
  'prompt has to carry the whole task: what to do, which files, and what "done" means.',
  'Prefer session_archive over session_delete. Deleting cannot be undone, the user is asked every',
  'single time, and you should only ever reach for it when they have asked for that particular',
  'conversation to be deleted.',
];

/**
 * One round's request, returning what went wrong instead of throwing it.
 *
 * The loop has to decide whether a failure ends the TURN or ends the REPLY, and that decision
 * needs the round's own bookkeeping - the text that did arrive, the running cost - to have been
 * recorded first. A throw out of the middle of the loop skips all of it.
 */
async function streamRound(...args: Parameters<typeof streamCompletion>): Promise<Error | null> {
  try {
    await streamCompletion(...args);
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Whether a failure is the conversation having outgrown the model's context window.
 *
 * Matched on the provider's own words, which is the only place it is said: the endpoint relays
 * the failure with a status, and every provider phrases this differently while all of them name
 * the window. Widened over time as new phrasings turn up - a miss here is an honest error
 * message in the thread rather than a wrong one, which is why it errs towards not matching.
 */
function isContextOverflow(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('context window') ||
    message.includes('context length') ||
    message.includes('context_length_exceeded') ||
    message.includes('too many tokens') ||
    (message.includes('maximum') && message.includes('tokens')) ||
    (message.includes('prompt') && message.includes('too long'))
  );
}

/**
 * Whatever newlines it takes to reach exactly one blank line at the end of `content`.
 *
 * Empty for empty content, which is what keeps a single-round reply - the common case - free of
 * a leading blank line.
 */
function paragraphBreak(content: string): string {
  if (content.length === 0) return '';
  const trailing = /\n*$/.exec(content)?.[0].length ?? 0;
  return trailing >= 2 ? '' : '\n'.repeat(2 - trailing);
}

/**
 * The rounds' prose as one reply. Uses the same rule the deltas are separated by, so what the
 * thread streams and what it reloads are the same text rather than nearly the same.
 */
function joinRounds(texts: readonly string[]): string {
  let joined = '';
  for (const text of texts) {
    if (text.length === 0) continue;
    joined += paragraphBreak(joined) + text;
  }
  return joined;
}

/**
 * What one round ASKED FOR, as a comparable string. Names and arguments only: a round is a
 * repeat of the last one when it requests the same work, and the per-call ids differ every time.
 */
function roundSignature(requested: readonly RequestedTool[]): string {
  return requested.map(tool => `${tool.name}(${tool.arguments ?? ''})`).join('\n');
}

/** One session as plain text, for session_read. Mirrors what the thread shows, minus the chrome. */
function renderTranscript(session: ChatSession): string {
  const lines = [`Conversation: ${session.title}`, `Last updated: ${session.updatedAt}`, ''];

  for (const message of session.messages) {
    const speaker = message.system ? 'App' : message.role === 'user' ? 'User' : 'Assistant';
    lines.push(`--- ${speaker} ---`);
    if (message.content) lines.push(message.content);
    // Named, not inlined. An artifact body is the largest thing a reply can carry, and a
    // transcript is read to find out WHAT a conversation did; without this line a session whose
    // whole answer was an artifact reads as though it produced nothing.
    for (const artifact of message.artifacts ?? []) {
      lines.push(`[artifact ${artifact.type}: ${artifact.title}]`);
    }
    for (const call of message.toolCalls ?? []) {
      lines.push(`[tool ${call.name} -> ${call.status}]`);
    }
    if (message.error) lines.push(`[failed: ${message.error}]`);
    lines.push('');
  }

  if (session.messages.length === 0) lines.push('(nothing has been said in it yet)');
  return lines.join('\n');
}

/**
 * What a finished spawned session tells its parent.
 *
 * The child's own output is NOT carried across. A spawned session runs on a prompt the parent
 * wrote, and piping its reply straight back in would put text the parent never read - produced
 * by a model the user was not watching - into the next request as though the user had typed it.
 * `stopReason` is stated when it means the run did not simply finish, because "it stopped after
 * too many tool calls" and "it answered" are very different things to build a next step on.
 *
 * `session_read` is how the parent gets the content, deliberately: one more tool call, held to
 * the same project scope, and visible in the transcript as a thing that was asked for.
 */
function describeChildOutcome(child: ChatSession): string {
  const last = [...child.messages].reverse().find(message => message.role === 'assistant');
  const header = `The session you started, "${child.title}" (${child.id}), has finished.`;
  const read = `Read it with session_read (${child.id}) if you need what it produced.`;

  if (!last) return `${header}\nIt produced no reply. ${read}`;
  if (last.error) return `${header}\nIt failed: ${last.error}`;

  const note = isTurnBudgetStop(last.stopReason)
    ? ' It ran out of its turn budget rather than finishing, so its work may be incomplete.'
    : last.stopReason === 'context_limit'
      ? ' It filled the model context and stopped, so its work may be incomplete.'
      : last.stopReason === 'max_tokens'
        ? ' Its reply was cut off at the length limit.'
        : last.stopReason === 'aborted'
          ? ' It was stopped before it finished.'
          : '';

  return `${header}${note}\n${read}`;
}

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
    // Artifact markup is stripped out of the stored text, so it has to go back in here: a model
    // that cannot see the artifact it just wrote cannot revise it.
    const text = restoreArtifactMarkup(message);

    if (calls.length === 0) {
      const attachments = message.attachments ?? [];
      if (attachments.length > 0) {
        const content = await toAttachedContent(text, attachments, readAttachment);
        if (content.length > 0) wire.push({ role: message.role, content });
        continue;
      }
      if (text.length > 0) wire.push({ role: message.role, content: text });
      continue;
    }

    wire.push({
      role: 'assistant',
      content: [
        ...(message.thinking ?? []),
        ...(text ? [{ type: 'text', text }] : []),
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
