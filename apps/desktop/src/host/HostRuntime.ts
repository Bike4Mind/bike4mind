import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ChatModels } from '@bike4mind/common';
import type { ChatApprovalAnswer, ChatSessionMode, SendMessageRequest } from '@shared/chat';
import { ApprovalModePreference } from '../main/chat/ApprovalModePreference';
import { ChatService, type ChatServiceDeps, type ChatServiceLogger } from '../main/chat/ChatService';
import { createCompletionRunMinter } from '../main/chat/completionRuns';
import { DeferredToolsSetting, parseDeferredToolsOverride } from '../main/chat/DeferredToolsSetting';
import { MessageQueue } from '../main/chat/MessageQueue';
import { ModelPreference } from '../main/chat/ModelPreference';
import { ApprovalLog } from '../main/chat/permissions/ApprovalLog';
import { DependencyInstaller } from '../main/chat/project/dependencyInstall';
import { PromptCacheTtlPreference } from '../main/chat/PromptCacheTtlPreference';
import { parseReasoningEffortSetting } from '../main/chat/reasoningEffort';
import { rendererNotes } from '../main/chat/rendererNotes';
import { archiveFromSidebar, type ConfirmArchive } from '../main/chat/sessionArchive';
import { SessionActivity } from '../main/chat/SessionActivity';
import { BackgroundJobsFeed } from '../main/chat/backgroundJobsFeed';
import { BACKGROUND_EXIT_HOLD_MS } from '../main/chat/backgroundWake';
import { sessionScopeForChat } from '../main/chat/sessionScope';
import { SessionEventLog } from '../main/chat/SessionEventLog';
import { SessionStore } from '../main/chat/SessionStore';
import { TurnExtensionsPreference } from '../main/chat/TurnExtensionsPreference';
import { AccessStore } from '../main/chat/tools/AccessStore';
import { ApprovalGate } from '../main/chat/tools/ApprovalGate';
import { BackgroundProcessRegistry } from '../main/chat/tools/BackgroundProcessRegistry';
import { ForegroundCommandRegistry } from '../main/chat/tools/ForegroundCommandRegistry';
import { keepSessionWritesIn } from '../main/chat/tools/sessionScripts';
import type {
  HostAuth,
  HostCollaborators,
  HostEnvironment,
  HostEventSink,
  HostHooks,
  HostMachineTools,
  HostProtection,
} from './ports';

/** Diagnosis only; see apps/desktop/docs/model-wait-findings.md. */
const TURN_TIMING = process.env.B4M_DESKTOP_TURN_TIMING === '1';

/**
 * The model a new conversation prefers until the user has picked one (see ModelPreference),
 * and when the deployment does not offer the one they picked.
 *
 * A PREFERENCE, not a list: the real set comes from the server (see ModelCatalog), and a
 * deployment that does not offer this one gets the first model it does offer instead. It is
 * also the fixed fallback for a session file with no model saved on it - deliberately not the
 * remembered pick, so an old conversation never changes model because of a choice made in
 * another one.
 */
const PREFERRED_MODEL: string = ChatModels.CLAUDE_5_OPUS;

/**
 * The reasoning effort a conversation starts on, read per launch so a benchmark can compare
 * efforts without a rebuild. The user's own choice is per session and outranks this - see
 * SessionStore - so this only reaches a conversation that has never been given one.
 */
const REASONING_EFFORT = parseReasoningEffortSetting(process.env.B4M_DESKTOP_REASONING_EFFORT);

/** Local overrides of the server's deferred tool loading setting; see parseDeferredToolsOverride. */
const DEFERRED_TOOLS_OVERRIDE = parseDeferredToolsOverride(
  process.env.B4M_DESKTOP_DEFERRED_TOOLS,
  process.env.B4M_DESKTOP_DEFERRED_START_MAX_TOKENS
);

export type HostRuntimeOptions = {
  environment: HostEnvironment;
  events: HostEventSink;
  auth: HostAuth;
  logger: ChatServiceLogger;
  protection: HostProtection;
  machine?: HostMachineTools;
  collaborators?: HostCollaborators;
  hooks?: HostHooks;
};

/**
 * The agent runtime of one machine: the session store, the chat service and the collaborators
 * that build it, with no dependency on Electron. Desktop drives it in-process through IPC; a
 * headless host will drive the same object over its protocol. The methods below are the core
 * session operations that protocol serves, each a thin delegation to the service.
 */
export class HostRuntime {
  readonly store: SessionStore;
  readonly access: AccessStore;
  readonly turnExtensions: TurnExtensionsPreference;
  readonly approvals: ApprovalGate;
  readonly approvalLog: ApprovalLog;
  readonly activity: SessionActivity;
  readonly queue: MessageQueue;
  readonly background: BackgroundProcessRegistry;
  readonly foreground: ForegroundCommandRegistry;
  readonly service: ChatService;
  /** One sequence per session across the service and the emitters that bypass it. */
  readonly eventLog = new SessionEventLog();
  private readonly pullRequests: HostCollaborators['pullRequests'];

  constructor(options: HostRuntimeOptions) {
    const { environment, events, auth, logger, protection, machine = {}, collaborators = {}, hooks = {} } = options;
    const { pullRequests, ...passedThrough } = collaborators;
    const dataDirectory = environment.dataDirectory;
    this.pullRequests = pullRequests;

    // App-wide like approval-mode.json: a record of decisions, kept after their conversations.
    this.approvalLog = new ApprovalLog(join(dataDirectory, 'approval-log.jsonl'), message => logger.warn(message));
    // Beside approval-mode.json and app-wide like it; see ModelPreference for why.
    const modelPreference = new ModelPreference(join(dataDirectory, 'model-preference.json'));
    // Unconditional: it is the one way to check which model a launch will start conversations on
    // without opening the picker. The read also warms the cache, so the first new conversation
    // does not wait on the file.
    void modelPreference
      .read()
      .then(remembered =>
        logger.warn(
          `CHAT: preferred model for new conversations: ${remembered ?? PREFERRED_MODEL} (${remembered ? 'remembered pick' : 'built-in default'})`
        )
      );
    // Beside the sessions directory rather than inside it: everything in there is migrated into
    // a scope folder on first use, and this records how the user likes to work rather than
    // anything belonging to one conversation or one account.
    const approvalModes = new ApprovalModePreference(join(dataDirectory, 'approval-mode.json'));
    const deferredTools = new DeferredToolsSetting({
      filePath: join(dataDirectory, 'deferred-tools.json'),
      getApiClient: () => auth.getApiClient(),
      getEnvironmentUrl: () => auth.getState().environment.url,
      logger,
      override: DEFERRED_TOOLS_OVERRIDE,
    });
    // Asked at launch so the first turn already has the server's answer.
    void deferredTools.refresh();
    // Scoped to the backend and the account, not just to this machine: one install reaches
    // production and a local server, and can be signed in as a different person on each. The
    // provider is read per operation, so a switch takes effect on the next list with nothing
    // here to invalidate. See main/chat/sessionScope for the key and the one-time migration.
    this.store = new SessionStore(
      join(dataDirectory, 'sessions'),
      PREFERRED_MODEL,
      randomUUID(),
      () => sessionScopeForChat(auth.getState()),
      approvalModes,
      REASONING_EFFORT,
      new PromptCacheTtlPreference(join(dataDirectory, 'prompt-cache-ttl.json'))
    );
    keepSessionWritesIn(this.store);
    this.access = new AccessStore(join(dataDirectory, 'tool-access.json'));
    this.turnExtensions = new TurnExtensionsPreference(join(dataDirectory, 'turn-extensions.json'));

    // Declared before the two things that feed it, because both take it as a constructor
    // argument: the gate reports who is waiting on the user, the service reports who is
    // replying, and this turns the pair into the one status a sidebar row draws.
    this.activity = new SessionActivity((event, statusChanged) => {
      events.sessionStatus(event, statusChanged);
      // A session changes status only once the service below exists.
      this.service.sessionStatusChanged(event);
    });

    // Typed-ahead messages, on their own channel: this is per-session state that outlives any
    // one reply, so it travels beside the status pushes rather than inside the reply stream.
    this.queue = new MessageQueue(event => events.queueChanged(event));

    this.approvals = new ApprovalGate({
      requested: sessionId => this.activity.approvalRequested(sessionId),
      settled: sessionId => this.activity.approvalSettled(sessionId),
    });

    // Output and status go out on the same channel as reply tokens: a background process is
    // still something that conversation is doing, and a renderer that reloads re-subscribes to
    // one stream rather than two.
    // Holds Waiting across the wake's coalesce gap after a job ends on its own; see BackgroundJobsFeed.
    const backgroundJobs = new BackgroundJobsFeed(
      (sessionId, jobs) => this.activity.backgroundChanged(sessionId, jobs),
      BACKGROUND_EXIT_HOLD_MS
    );
    this.background = new BackgroundProcessRegistry({
      output: (sessionId, processId, stream, text) =>
        events.streamEvent(this.eventLog.append({ type: 'background-output', sessionId, processId, stream, text })),
      status: (sessionId, process) => {
        events.streamEvent(this.eventLog.append({ type: 'background-status', sessionId, process }));
        // Only ever fires from start/finish, after `background` has been assigned.
        backgroundJobs.update(sessionId, this.background.wakingJobs(sessionId), process.status);
      },
      // Only ever fires once a process has run, long after the service below exists.
      exited: (sessionId, processId) => this.service.backgroundExited(sessionId, processId),
    });
    this.foreground = new ForegroundCommandRegistry();

    const agentPullRequests: ChatServiceDeps['pullRequests'] = pullRequests && {
      bindForAgent: (sessionId, target) => pullRequests().bindForAgent(sessionId, target),
      dismiss: sessionId => pullRequests().dismiss(sessionId),
    };

    this.service = new ChatService({
      ...passedThrough,
      ...machine,
      store: this.store,
      access: this.access,
      logger,
      mintCompletionRun: createCompletionRunMinter(message =>
        logger.warn(`CHAT: could not mint a completion run: ${message}`)
      ),
      turnTiming: TURN_TIMING,
      preferredModel: PREFERRED_MODEL,
      modelMemory: modelPreference,
      turnExtensions: () => this.turnExtensions.read(),
      approvals: this.approvals,
      approvalLog: this.approvalLog,
      background: this.background,
      foreground: this.foreground,
      dependencies: new DependencyInstaller(this.background),
      activity: this.activity,
      queue: this.queue,
      pullRequests: agentPullRequests,
      // The data directory holds the auth vault. Without this a user who shares their home folder
      // would be one `cat` away from the access token, which breaks the rule that tokens never
      // leave the runtime's process.
      get protectedPaths() {
        return protection.tool.paths();
      },
      get unresolvedProtectedPaths() {
        return protection.tool.unresolved();
      },
      get uncoverablePaths() {
        return protection.permission.paths();
      },
      get deferredTools() {
        return deferredTools.current();
      },
      getApiClient: () => auth.getApiClient(),
      eventLog: this.eventLog,
      isDeviceLocal: () => sessionScopeForChat(auth.getState())?.local === true,
      getEnvironmentUrl: () => auth.getState().environment.url,
      emit: event => {
        events.streamEvent(event);
        try {
          hooks.observeStream?.(event);
        } catch {
          logger.warn('FLEET: activity observer failed');
        }
      },
      summaryChanged: summary => events.sessionSummary(summary),
      taskDecisionsChanged: decisions => events.taskDecisions(decisions),
      loopChanged: (sessionId, state) => events.loopChanged(sessionId, state),
      sessionClosed: hooks.sessionClosed,
      releaseSessionTerminals: hooks.releaseSessionTerminals,
    });
  }

  listSessions() {
    return this.service.listSessions();
  }

  getSession(sessionId: string, viewed: boolean) {
    return this.service.getSession(sessionId, viewed);
  }

  createSession(mode?: Exclude<ChatSessionMode, 'code'>) {
    return this.service.createSession(mode);
  }

  renameSession(sessionId: string, title: string) {
    return this.service.renameSession(sessionId, title);
  }

  /** Archiving a parent asks first; `confirm` is how this host puts that question to its user. */
  setSessionArchived(sessionId: string, archived: boolean, confirm: ConfirmArchive) {
    return archiveFromSidebar(this.service, this.store, sessionId, archived, confirm);
  }

  async deleteSession(sessionId: string, removeWorktree: boolean): Promise<void> {
    await this.service.deleteSession(sessionId, removeWorktree);
    await this.pullRequests?.().forget(sessionId);
  }

  sendMessage(request: SendMessageRequest) {
    return this.service.send(request.sessionId, request.text, request.attachments, {
      notes: rendererNotes(request.notes),
    });
  }

  stopReply(sessionId: string): void {
    this.service.stop(sessionId);
  }

  /** The one path that answers a tool approval, whichever surface the answer came from. */
  respondToApproval(approvalId: string, answer: ChatApprovalAnswer) {
    return this.approvals.resolve(approvalId, answer);
  }

  sessionStatuses() {
    return this.service.sessionStatuses();
  }

  async draftDefaults() {
    return this.store.defaultsForNewSession(await this.service.modelForNewSession());
  }

  listModels(force: boolean | 'local') {
    return this.service.listModels(force);
  }

  queuedMessages(sessionId: string) {
    return this.service.queuedMessages(sessionId);
  }

  cancelQueued(sessionId: string, queuedId: string): void {
    this.service.cancelQueued(sessionId, queuedId);
  }

  sendQueuedNow(sessionId: string, queuedId: string): void {
    this.service.sendQueuedNow(sessionId, queuedId);
  }
}
