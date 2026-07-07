/**
 * ACP agent-side server. Bridges the Agent Client Protocol to the same B4M
 * ReAct agent core the interactive TUI and headless modes drive, so an
 * ACP-capable editor (Zed, etc.) can host a thread while we keep auth, credits,
 * and model routing server-side.
 *
 * Design notes:
 * - The heavy agent stack (LLM transport, tools, MCP, orchestrator) is built
 *   ONCE, lazily, on the first session. Individual ACP sessions are lightweight
 *   conversation contexts (history + cwd + mode) that reuse the shared agent.
 * - Because sessions share one agent instance and one process working
 *   directory, prompt turns are serialized through a single mutex. This is
 *   stricter than the spec's per-session requirement and guarantees histories
 *   can never interleave.
 * - Permission requests bridge to session/request_permission and FAIL CLOSED:
 *   a client timeout, disconnect, or cancel all resolve to a denial.
 */

import { randomUUID } from 'crypto';
import { Mutex } from 'async-mutex';
import type { ICompletionBackend, ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { AgentStep, AgentResult, ConversationMessage, ReActAgent } from '@bike4mind/agents';
import type { UserQuestionPayload, UserQuestionResponse } from '@bike4mind/services';

import { ConfigStore, SessionStore, type CliConfig, type Session, type Message } from '../storage';
import { CustomCommandStore } from '../storage/CustomCommandStore.js';
import { RemoteSkillSource } from '../storage/RemoteSkillSource.js';
import { CheckpointStore } from '../storage/CheckpointStore.js';
import { ApiClient } from '../auth/ApiClient';
import { requireApiUrl, type AgentContext } from '../utils';
import { PermissionManager } from '../utils';
import type { PermissionResponse } from '../components';
import { isReadOnlyTool } from '../config/toolSafety.js';
import { logger } from '../utils/Logger';

import { buildLlmBackend } from '../bootstrap/buildLlmBackend.js';
import { buildSandbox } from '../bootstrap/buildSandbox.js';
import { buildSupportingStores } from '../bootstrap/buildSupportingStores.js';
import { buildAgent } from '../bootstrap/buildAgent.js';
import type { InteractionMode } from '../bootstrap/types.js';
import { FallbackLlmBackend } from '../llm/FallbackLlmBackend';
import { NotifyingLlmBackend } from '../llm/NotifyingLlmBackend.js';
import { setWebSocketToolExecutor } from '../llm/ToolRouter';
import { createToolSearchTool } from '../tools/toolSearchTool.js';
import { deferredToolRegistry } from '../tools/deferredToolRegistry.js';
import { createAgentDelegateTool } from '../agents/delegateTool.js';
import { createBackgroundAgentTools } from '../agents/backgroundTools.js';
import { createCoordinateTaskTool } from '../agents/coordinatorTool.js';
import type { SubagentOrchestrator } from '../agents/SubagentOrchestrator.js';
import type { AgentStore } from '../agents/AgentStore.js';
import type { BackgroundAgentManager } from '../agents/BackgroundAgentManager.js';
import {
  createWriteTodosTool,
  createTodoStore,
  createSkillTool,
  createFindDefinitionTool,
  createGetFileStructureTool,
} from '../tools';

import { RequestError, methods, type AcpClientContext, type schema } from './acpSdk.js';
import {
  ACP_PROTOCOL_VERSION,
  AGENT_INFO,
  DEFAULT_ACP_MODE,
  acpModeToInteraction,
  buildSessionModeState,
  buildPermissionOptions,
  permissionResponseFromOutcome,
  contentBlocksToText,
  agentMessageChunk,
  agentThoughtChunk,
  userMessageChunk,
  toolCallStart,
  toolCallCompleted,
  toolCallTitle,
  toolKind,
  currentModeUpdate,
} from './protocol.js';
import { assertConfinedCwd } from './cwd.js';

/** Fail-closed deadline for a client permission decision. */
const PERMISSION_TIMEOUT_MS = 5 * 60_000;

/** Per-session conversation context. The agent itself is shared and stateless. */
interface AcpSessionState {
  id: string;
  cwd: string;
  mode: InteractionMode;
  history: ConversationMessage[];
  /** Set while a prompt turn runs; session/cancel aborts it. */
  abortController: AbortController | null;
  persisted: Session;
}

/** The active prompt turn's routing context, read by the shared permission callback. */
interface ActiveTurn {
  client: AcpClientContext;
  sessionId: string;
  signal: AbortSignal;
}

/** Materials built once and shared across all sessions. */
interface AgentStack {
  agent: ReActAgent;
  buildPromptForMode: (mode: InteractionMode) => string;
  permissionManager: PermissionManager;
  modelId: string;
  cleanup: () => Promise<void>;
}

const silentLogger = {
  log: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

export class AcpServer {
  private readonly configStore = new ConfigStore();
  private readonly sessionStore = new SessionStore();
  private readonly customCommandStore = new CustomCommandStore();
  private readonly sessions = new Map<string, AcpSessionState>();
  private readonly turnMutex = new Mutex();

  private stackPromise: Promise<AgentStack> | null = null;
  private stack: AgentStack | null = null;
  private activeTurn: ActiveTurn | null = null;

  /**
   * @param connectionSignal aborts when the ACP connection closes; used to fail
   *   permission prompts closed.
   * @param version CLI version reported to the client as `agentInfo.version`.
   */
  constructor(
    private readonly connectionSignal: AbortSignal,
    private readonly version: string
  ) {}

  // -------------------------------------------------------------------------
  // ACP request handlers
  // -------------------------------------------------------------------------

  initialize(_params: schema.InitializeRequest): schema.InitializeResponse {
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentInfo: { name: AGENT_INFO.name, title: AGENT_INFO.title, version: this.version },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
      },
    };
  }

  async newSession(params: schema.NewSessionRequest): Promise<schema.NewSessionResponse> {
    const cwd = assertConfinedCwd(params.cwd);
    const stack = await this.ensureStack();

    const id = randomUUID();
    const persisted: Session = {
      id,
      name: `ACP ${new Date().toISOString()}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      model: stack.modelId,
      messages: [],
      metadata: { totalTokens: 0, totalCost: 0, toolCallCount: 0 },
    };
    this.sessions.set(id, {
      id,
      cwd,
      mode: acpModeToInteraction(DEFAULT_ACP_MODE) ?? 'normal',
      history: [],
      abortController: null,
      persisted,
    });

    return { sessionId: id, modes: buildSessionModeState(DEFAULT_ACP_MODE) };
  }

  async loadSession(params: schema.LoadSessionRequest, ctx: AcpClientContext): Promise<schema.LoadSessionResponse> {
    const cwd = assertConfinedCwd(params.cwd);
    await this.ensureStack();

    const persisted = await this.sessionStore.load(params.sessionId);
    if (!persisted) {
      throw RequestError.resourceNotFound(params.sessionId);
    }

    const history: ConversationMessage[] = persisted.messages
      .filter((m): m is Message & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));

    this.sessions.set(params.sessionId, {
      id: params.sessionId,
      cwd,
      mode: acpModeToInteraction(DEFAULT_ACP_MODE) ?? 'normal',
      history,
      abortController: null,
      persisted,
    });

    // Replay history so the editor can render the prior conversation.
    for (const message of history) {
      const update = message.role === 'user' ? userMessageChunk(message.content) : agentMessageChunk(message.content);
      await ctx.notify(methods.client.session.update, { sessionId: params.sessionId, update });
    }

    return { modes: buildSessionModeState(DEFAULT_ACP_MODE) };
  }

  setSessionMode(params: schema.SetSessionModeRequest, ctx: AcpClientContext): schema.SetSessionModeResponse {
    const session = this.requireSession(params.sessionId);
    const mode = acpModeToInteraction(params.modeId);
    if (!mode) {
      // Rejecting unknown / unsafe mode ids is what keeps no-prompt modes off the wire.
      throw RequestError.invalidParams(undefined, `Unsupported session mode: ${params.modeId}`);
    }
    session.mode = mode;
    void ctx.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: currentModeUpdate(params.modeId),
    });
    return {};
  }

  /** session/cancel is a notification: abort the running turn for this session. */
  cancel(params: schema.CancelNotification): void {
    const session = this.sessions.get(params.sessionId);
    session?.abortController?.abort();
  }

  async prompt(
    params: schema.PromptRequest,
    ctx: AcpClientContext,
    requestSignal: AbortSignal
  ): Promise<schema.PromptResponse> {
    const session = this.requireSession(params.sessionId);

    // An empty prompt is a no-op turn: skip the mutex, bootstrap, and an LLM
    // round-trip entirely rather than running the agent on "".
    const userText = contentBlocksToText(params.prompt);
    if (!userText.trim()) {
      return { stopReason: 'end_turn' };
    }

    const stack = await this.ensureStack();

    // Serialize every turn: sessions share one agent and one process cwd.
    return this.turnMutex.runExclusive(async () => {
      const abortController = new AbortController();
      session.abortController = abortController;
      // Cancel the turn if the client cancels the request or drops the connection.
      const onExternalAbort = () => abortController.abort();
      requestSignal.addEventListener('abort', onExternalAbort);
      this.connectionSignal.addEventListener('abort', onExternalAbort);

      this.activeTurn = { client: ctx, sessionId: params.sessionId, signal: abortController.signal };

      // Confine file tools to this session's cwd, and align the system prompt
      // with the session's interaction mode.
      process.chdir(session.cwd);
      stack.agent.setSystemPrompt(stack.buildPromptForMode(session.mode));

      const detachEvents = this.wireTurnEvents(stack.agent, ctx, params.sessionId, abortController.signal);

      let result: AgentResult | null = null;
      try {
        result = await stack.agent.run(userText, {
          signal: abortController.signal,
          previousMessages: session.history,
          isReadOnlyTool,
          maxHistoryIterations: 4,
        });
      } catch (error) {
        if (abortController.signal.aborted) {
          return { stopReason: 'cancelled' };
        }
        throw RequestError.internalError(undefined, error instanceof Error ? error.message : String(error));
      } finally {
        detachEvents();
        requestSignal.removeEventListener('abort', onExternalAbort);
        this.connectionSignal.removeEventListener('abort', onExternalAbort);
        session.abortController = null;
        this.activeTurn = null;
      }

      if (abortController.signal.aborted) {
        return { stopReason: 'cancelled' };
      }

      // Commit the turn to history and persist (best-effort).
      session.history.push({ role: 'user', content: userText });
      session.history.push({ role: 'assistant', content: result.finalAnswer });
      await this.persistTurn(session, userText, result).catch(err => {
        logger.debug(`[acp] Failed to persist session: ${err instanceof Error ? err.message : String(err)}`);
      });

      return {
        stopReason: this.stopReasonFor(result),
        usage: {
          totalTokens: result.completionInfo.totalTokens,
          inputTokens: result.completionInfo.totalInputTokens,
          outputTokens: result.completionInfo.totalOutputTokens,
        },
      };
    });
  }

  /** Tear down shared resources when the connection closes. */
  async close(): Promise<void> {
    this.activeTurn = null;
    if (this.stack) {
      await this.stack.cleanup().catch(() => {});
      this.stack = null;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireSession(sessionId: string): AcpSessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams(undefined, `Unknown session: ${sessionId}`);
    }
    return session;
  }

  private stopReasonFor(result: AgentResult): schema.StopReason {
    if (result.completionInfo.reachedMaxTotalTokens) return 'max_tokens';
    if (result.completionInfo.reachedMaxIterations) return 'max_turn_requests';
    return 'end_turn';
  }

  /**
   * Forward the main agent's ReAct events to the client as session/update
   * notifications for the duration of one turn. Text is streamed via
   * text_delta; the final_answer is emitted only if nothing streamed, to avoid
   * duplicating the message. Returns a detach function.
   */
  private wireTurnEvents(
    agent: ReActAgent,
    client: AcpClientContext,
    sessionId: string,
    signal: AbortSignal
  ): () => void {
    let streamedAnyText = false;
    // FIFO of synthesized tool-call ids keyed by tool name, to pair
    // action -> observation. Best-effort under parallel tool execution.
    const pendingToolCalls = new Map<string, string[]>();

    const notify = (update: schema.SessionUpdate) => {
      if (signal.aborted) return;
      void client.notify(methods.client.session.update, { sessionId, update }).catch(() => {});
    };

    const onTextDelta = (info: { delta: string }) => {
      if (!info.delta) return;
      streamedAnyText = true;
      notify(agentMessageChunk(info.delta));
    };
    const onThought = (step: AgentStep) => {
      if (step.content) notify(agentThoughtChunk(step.content));
    };
    const onAction = (step: AgentStep) => {
      const toolName = step.metadata?.toolName ?? 'tool';
      const toolCallId = `tool-${randomUUID()}`;
      const queue = pendingToolCalls.get(toolName) ?? [];
      queue.push(toolCallId);
      pendingToolCalls.set(toolName, queue);
      notify(toolCallStart(toolCallId, step));
    };
    const onObservation = (step: AgentStep) => {
      const toolName = step.metadata?.toolName;
      const toolCallId = this.dequeueToolCall(pendingToolCalls, toolName);
      if (!toolCallId) return;
      notify(toolCallCompleted(toolCallId, typeof step.content === 'string' ? step.content : ''));
    };
    const onFinalAnswer = (step: AgentStep) => {
      if (!streamedAnyText && step.content) notify(agentMessageChunk(step.content));
    };

    agent.on('text_delta', onTextDelta);
    agent.on('thought', onThought);
    agent.on('action', onAction);
    agent.on('observation', onObservation);
    agent.on('final_answer', onFinalAnswer);

    return () => {
      agent.off('text_delta', onTextDelta);
      agent.off('thought', onThought);
      agent.off('action', onAction);
      agent.off('observation', onObservation);
      agent.off('final_answer', onFinalAnswer);
    };
  }

  private dequeueToolCall(pending: Map<string, string[]>, toolName: string | undefined): string | undefined {
    if (toolName) {
      const queue = pending.get(toolName);
      if (queue && queue.length > 0) {
        const id = queue.shift();
        if (queue.length === 0) pending.delete(toolName);
        return id;
      }
    }
    // Fallback: match the oldest pending call regardless of tool.
    for (const [name, queue] of pending.entries()) {
      if (queue.length > 0) {
        const id = queue.shift();
        if (queue.length === 0) pending.delete(name);
        return id;
      }
    }
    return undefined;
  }

  private async persistTurn(session: AcpSessionState, userText: string, result: AgentResult): Promise<void> {
    const now = new Date().toISOString();
    session.persisted.messages.push(
      { id: randomUUID(), role: 'user', content: userText, timestamp: now },
      { id: randomUUID(), role: 'assistant', content: result.finalAnswer, timestamp: now }
    );
    session.persisted.updatedAt = now;
    session.persisted.metadata.totalTokens += result.completionInfo.totalTokens;
    session.persisted.metadata.toolCallCount += result.completionInfo.toolCalls;
    await this.sessionStore.save(session.persisted);
  }

  // -------------------------------------------------------------------------
  // Permission bridge (fail closed)
  // -------------------------------------------------------------------------

  private readonly promptFn = async (
    toolName: string,
    args: unknown,
    preview?: string
  ): Promise<{ action: PermissionResponse }> => {
    const turn = this.activeTurn;
    // No active turn should never happen, but deny rather than assume.
    if (!turn) return { action: 'deny' };

    const toolCallId = `perm-${randomUUID()}`;
    const toolCall: schema.ToolCallUpdate = {
      toolCallId,
      title: toolCallTitle(toolName, args),
      kind: toolKind(toolName),
      status: 'pending',
      rawInput: args,
      content: preview ? [{ type: 'content', content: { type: 'text', text: preview.slice(0, 4000) } }] : undefined,
    };

    const decisionController = new AbortController();
    const timer = setTimeout(() => decisionController.abort(), PERMISSION_TIMEOUT_MS);
    const onClose = () => decisionController.abort();
    turn.signal.addEventListener('abort', onClose);
    this.connectionSignal.addEventListener('abort', onClose);

    try {
      const action = await Promise.race<PermissionResponse>([
        turn.client
          .request(
            methods.client.session.requestPermission,
            { sessionId: turn.sessionId, toolCall, options: buildPermissionOptions() },
            { cancellationSignal: decisionController.signal }
          )
          .then(res => permissionResponseFromOutcome(res?.outcome))
          .catch(() => 'deny' as PermissionResponse),
        // Fail closed if the client never answers or the connection drops.
        new Promise<PermissionResponse>(resolve => {
          decisionController.signal.addEventListener('abort', () => resolve('deny'), { once: true });
        }),
      ]);
      return { action };
    } finally {
      clearTimeout(timer);
      turn.signal.removeEventListener('abort', onClose);
      this.connectionSignal.removeEventListener('abort', onClose);
    }
  };

  private readonly userQuestionFn = (_payload: UserQuestionPayload): Promise<UserQuestionResponse> => {
    // ACP v1 has no interactive question channel; answer empty so the agent proceeds.
    return Promise.resolve({ answers: [] });
  };

  // -------------------------------------------------------------------------
  // Lazy agent-stack bootstrap (built once, shared across sessions)
  // -------------------------------------------------------------------------

  private ensureStack(): Promise<AgentStack> {
    if (!this.stackPromise) {
      this.stackPromise = this.buildStack().then(stack => {
        this.stack = stack;
        return stack;
      });
    }
    return this.stackPromise;
  }

  private async buildStack(): Promise<AgentStack> {
    const config = await this.configStore.load();
    await this.loadCustomCommands();

    const authTokens = await this.configStore.getAuthTokens();
    if (!authTokens) {
      throw RequestError.authRequired(undefined, 'Not authenticated. Run `b4m /login` first.');
    }
    if (new Date(authTokens.expiresAt) <= new Date()) {
      await this.configStore.clearAuthTokens();
      throw RequestError.authRequired(undefined, 'Authentication expired. Run `b4m /login` again.');
    }

    const apiBaseURL = requireApiUrl(config.apiConfig);
    const apiClient = new ApiClient(apiBaseURL, this.configStore);
    const tokenGetter = async () => (await this.configStore.getAuthTokens())?.accessToken ?? null;

    await this.mergeRemoteSkills(config, apiClient);

    const startupLog: string[] = [];
    const { llm, wsManager, modelInfo } = await buildLlmBackend({ config, apiClient, tokenGetter, startupLog });

    const permissionManager = new PermissionManager(config.trustedTools ?? [], undefined, config.tools.disabled ?? []);

    const checkpointStore = new CheckpointStore(this.configStore.getProjectConfigDir() ?? process.cwd());
    const stackSessionId = randomUUID();
    const { sandboxOrchestrator } = await buildSandbox({
      config,
      sessionId: stackSessionId,
      permissionManager,
      checkpointStore,
    });

    const additionalDirectories = await this.resolveAdditionalDirectories();
    const agentContext: AgentContext = { currentAgent: null, observationQueue: [] };

    const { agentStore, contextResult, loadedB4mTools, orchestrator, backgroundManager, mcpManager } =
      await buildSupportingStores({
        config,
        llm,
        modelId: modelInfo.id,
        permissionManager,
        apiClient,
        configStore: this.configStore,
        customCommandStore: this.customCommandStore,
        checkpointStore,
        sandboxOrchestrator,
        additionalDirectories,
        agentContext,
        promptFn: this.promptFn,
        userQuestionFn: this.userQuestionFn,
        startupLog,
        silentLogger,
        onBackgroundStatusChange: () => {},
        onGroupCompletion: () => {},
      });

    const llmWithFallback: ICompletionBackend =
      config.fallbackModels && config.fallbackModels.length > 0
        ? new FallbackLlmBackend(llm, config.fallbackModels, (from, to, error) =>
            logger.debug(`[acp] Model "${from}" failed (${error.message}); falling back to "${to}"`)
          )
        : llm;
    const notifyingLlm = new NotifyingLlmBackend(llmWithFallback, backgroundManager);

    const cliTools = this.buildCliTools({
      config,
      orchestrator,
      agentStore,
      backgroundManager,
      sessionId: stackSessionId,
    });

    const agentToolsRef: { current: ICompletionOptionTools[] | null } = { current: null };
    const toolSearchTool =
      deferredToolRegistry.size() > 0
        ? createToolSearchTool(() => {
            if (!agentToolsRef.current) throw new Error('tool_search invoked before agent context was wired');
            return agentToolsRef.current;
          })
        : null;
    const allTools = [...loadedB4mTools, ...(toolSearchTool ? [toolSearchTool] : []), ...cliTools];

    const { agent, buildPromptForMode } = buildAgent({
      config,
      modelId: modelInfo.id,
      notifyingLlm,
      allTools,
      agentContext,
      agentToolsRef,
      silentLogger,
      sessionId: stackSessionId,
      initialInteractionMode: 'normal',
      contextContent: contextResult.mergedContent,
      agentStore,
      customCommandStore: this.customCommandStore,
      enableSkillTool: config.preferences.enableSkillTool !== false,
      additionalDirectories,
      featureModulePrompts: '',
    });

    const cleanup = async () => {
      await mcpManager.disconnect().catch(() => {});
      wsManager?.disconnect();
      setWebSocketToolExecutor(null);
      agent.removeAllListeners();
    };

    return { agent, buildPromptForMode, permissionManager, modelId: modelInfo.id, cleanup };
  }

  private buildCliTools(input: {
    config: CliConfig;
    orchestrator: SubagentOrchestrator;
    agentStore: AgentStore;
    backgroundManager: BackgroundAgentManager;
    sessionId: string;
  }): ICompletionOptionTools[] {
    const { config, orchestrator, agentStore, backgroundManager, sessionId } = input;
    const tools: ICompletionOptionTools[] = [
      createAgentDelegateTool(orchestrator, agentStore, sessionId, backgroundManager),
      ...createBackgroundAgentTools(backgroundManager),
      createWriteTodosTool(createTodoStore()),
      createFindDefinitionTool(),
      createGetFileStructureTool(),
    ];
    if (config.preferences.enableSkillTool !== false) {
      tools.push(
        createSkillTool({ customCommandStore: this.customCommandStore, subagentOrchestrator: orchestrator, sessionId })
      );
    }
    if (config.preferences.enableCoordinatorMode === true) {
      tools.push(createCoordinateTaskTool(orchestrator, agentStore, sessionId));
    }
    return tools;
  }

  private async loadCustomCommands(): Promise<void> {
    try {
      await this.customCommandStore.loadCommands();
    } catch {
      // Custom commands are optional.
    }
  }

  private async mergeRemoteSkills(config: CliConfig, apiClient: ApiClient): Promise<void> {
    const enabled = process.env.B4M_NO_REMOTE_SKILLS !== '1' && config.preferences.enableRemoteSkills !== false;
    if (!enabled) return;
    try {
      this.customCommandStore.setRemoteSource(new RemoteSkillSource(apiClient));
      await this.customCommandStore.mergeRemoteCommands();
    } catch {
      // Remote skills are best-effort; a fetch failure must not block startup.
    }
  }

  private async resolveAdditionalDirectories(): Promise<string[]> {
    const configDirs = await this.configStore.getAdditionalDirectories();
    return [...new Set([...configDirs, ...this.parseEnvDirs()])];
  }

  /** Parse B4M_ADDITIONAL_DIRS defensively - a malformed value must not brick bootstrap. */
  private parseEnvDirs(): string[] {
    const raw = process.env.B4M_ADDITIONAL_DIRS;
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string') : [];
    } catch {
      logger.debug(`[acp] Ignoring malformed B4M_ADDITIONAL_DIRS: ${raw}`);
      return [];
    }
  }
}
