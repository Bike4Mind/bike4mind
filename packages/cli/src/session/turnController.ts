/**
 * Turn lifecycle (issue #228, phase 2).
 *
 * `runTurn` owns a single user turn end to end: user input -> auto-compact
 * check -> agent run -> persist -> queue drain. It is transport-agnostic and
 * React-free - all collaborators arrive through `TurnContext`, and the active
 * session is read from / written to the Zustand store rather than React state
 * (the single source of truth established in #227). This is what lets the turn
 * be exercised in tests with a fake agent, without mounting Ink; `index.tsx`
 * keeps only a thin wrapper that builds the context from its render state.
 */
import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { ReActAgent } from '@bike4mind/agents';
import type { ModelInfo } from '@bike4mind/common';
import type { SessionStore, ConfigStore, CommandHistoryStore, Session, Message, CliConfig } from '../storage';
import type { CustomCommandStore } from '../storage/CustomCommandStore.js';
import type { MessageBuilder } from '../utils/messageBuilder.js';
import type { AgentStore } from '../agents/AgentStore.js';
import type { BackgroundAgentManager } from '../agents/BackgroundAgentManager.js';
import type { FeatureModuleRegistry } from '../features/FeatureModuleRegistry.js';
import { useCliStore } from '../store';
import { getProcessHooks } from '../utils/processHooks.js';
import { bridgePresence } from '../features/bridgePresence/index.js';
import { getTokenCounter } from '../utils/tokenCounter.js';
import { buildSystemPrompt } from '../core/prompts';
import { deferredToolRegistry } from '../tools/deferredToolRegistry.js';
import { ConversationContext, reconstructTurnBlocks } from '../context/ConversationContext.js';
import { buildCompactionPrompt, createCompactedSession } from '../utils/compaction.js';
import { createReactiveCompactionHandler } from '../utils/reactiveCompaction.js';
import { buildWorkflowState, withFlushedWorkflowState, type WorkflowStores } from '../utils/workflowState.js';
import { formatStep, extractCompactInstructions } from '../utils';
import { renderWorkflowReminder } from '../utils/workflowReminder.js';
import { logger } from '../utils/Logger';
import { isTransientNetworkError } from '../llm/retryPolicy';
import { isReadOnlyTool } from '../config/toolSafety.js';
import type { TodoStore } from '../tools/writeTodosTool.js';
import type { DecisionStore } from '../tools/decisionLogTool.js';
import type { BlockerStore } from '../tools/blockerTool.js';

/**
 * Collaborators a single turn needs. React-free by design: the two setters are
 * plain callbacks a test can stub, and every store/service is injectable. The
 * active session is deliberately absent - it lives solely in `useCliStore`.
 */
export interface TurnContext {
  agent: ReActAgent | null;
  sessionStore: SessionStore;
  configStore: ConfigStore;
  commandHistoryStore: CommandHistoryStore;
  customCommandStore: CustomCommandStore;
  messageBuilder: MessageBuilder | null;
  config: CliConfig | undefined;
  availableModels: ModelInfo[] | undefined;
  agentStore: AgentStore | null;
  contextContent: string;
  additionalDirectories: string[];
  featureRegistry: FeatureModuleRegistry | null;
  backgroundManager: BackgroundAgentManager | null;
  /**
   * Live workflow stores (todos / decisions / blockers) backing the
   * per-iteration workflow reminder (issue: re-inject live workflow state).
   * Null when the host has no workflow tooling - the reminder is skipped.
   */
  todoStore: TodoStore | null;
  decisionStore: DecisionStore | null;
  blockerStore: BlockerStore | null;
  /**
   * In-memory durable-workflow stores. Flushed onto the session before
   * compaction so decisions/blockers logged this turn are not dropped when a
   * stale `metadata.workflow` snapshot is copied into the compacted session.
   */
  workflowStores: WorkflowStores;
  /** Mirror the persisted command history into the input's up-arrow recall. */
  setCommandHistory: (history: string[]) => void;
  /** Publish the turn's abort controller so the ESC handler / tavern can cancel it. */
  setAbortController: (controller: AbortController | null) => void;
}

/**
 * Run one user turn to completion. Never throws: transport, auth, and abort
 * errors are handled and surfaced to the console; the queue-drain in `finally`
 * recurses with the same context for messages submitted mid-turn.
 */
export async function runTurn(message: string, ctx: TurnContext): Promise<void> {
  const {
    agent,
    sessionStore,
    configStore,
    commandHistoryStore,
    customCommandStore,
    messageBuilder,
    config,
    availableModels,
    agentStore,
    contextContent,
    additionalDirectories,
    featureRegistry,
    backgroundManager,
    todoStore,
    decisionStore,
    blockerStore,
    workflowStores,
    setCommandHistory,
    setAbortController,
  } = ctx;

  // Read session fresh from the Zustand store, never from the caller-captured
  // context. On the message-queue drain this turn is re-entered with the same
  // ctx from the turn that queued it: the previous turn already wrote its user
  // message into the store, but a captured session snapshot would still point
  // at the pre-turn object. Reading a stale snapshot and writing it back would
  // clobber the previous turn's user prompt (it would "disappear" from history).
  const storeSession = useCliStore.getState().session;
  if (!agent || !storeSession) {
    console.error('❌ CLI failed to initialize. Try restarting b4m.\n');
    return;
  }

  // Process-hook (host action_required signal): a new user prompt clears any
  // stale block sentinel.
  void getProcessHooks()?.fireUserPromptSubmit();

  // Mirror the user turn into the tavern transcript so remote viewers see
  // it immediately. `text` clamped to the schema's 4000-char cap; the
  // bridge is a no-op if cc-bridge isn't running.
  void bridgePresence.emitEvent({ type: 'message', role: 'user', text: message.slice(0, 4000) });
  void bridgePresence.emitEvent({ type: 'status', status: 'running', text: message.slice(0, 240) });

  // Add to command history
  await commandHistoryStore.add(message);
  const updatedHistory = await commandHistoryStore.list();
  setCommandHistory(updatedHistory);

  // Check for auto-compact before processing
  let activeSession = storeSession;
  if (config?.preferences.autoCompact !== false && activeSession.messages.length >= 6) {
    const tokenCounter = getTokenCounter();
    const contextWindow = tokenCounter.getContextWindow(activeSession.model, availableModels);

    const systemPrompt = buildSystemPrompt(config?.preferences.promptVariant ?? 'current', {
      contextContent: contextContent,
      agentStore: agentStore || undefined,
      customCommands: customCommandStore.getAllCommands(),
      enableSkillTool: config?.preferences.enableSkillTool !== false,
      additionalDirectories: additionalDirectories,
      featureModulePrompts: featureRegistry?.getSystemPromptSections() || undefined,
      deferredToolNames: deferredToolRegistry.getDirectoryNames(),
    });

    // ConversationContext owns the compaction trigger: it measures the full
    // session as it would actually be replayed (bounded tool traces included)
    // plus the system prompt, so a session whose weight lives in tool traces
    // still compacts at the 80% mark. Tool schemas ship with every completion
    // request too (same accounting the /context meter uses), so a tool-heavy
    // session is folded in here as well - otherwise it could slip past the
    // 80% check on message text alone.
    const systemPromptTokens =
      tokenCounter.countTokens(systemPrompt) + tokenCounter.countToolSchemaTokens(agent.getTools());
    const shouldCompact = ConversationContext.fromSession(activeSession).needsCompaction(
      systemPromptTokens,
      { model: activeSession.model, contextWindow },
      0.8
    );

    if (shouldCompact) {
      console.log('\n⚠️  Context window 80% full. Auto-compacting...\n');

      // Set thinking state for compaction
      useCliStore.getState().setIsThinking(true);

      try {
        const { prompt: compactionPrompt, preservedMessages } = buildCompactionPrompt(activeSession.messages, {
          claudeMdInstructions: extractCompactInstructions(contextContent || ''),
        });

        if (compactionPrompt) {
          const result = await agent.run(compactionPrompt, { maxIterations: 1 });

          // Flush decisions/blockers logged in prior turns but not yet synced
          // onto the session, so the compacted session carries current workflow
          // state instead of a stale snapshot.
          const sessionToCompact = withFlushedWorkflowState(activeSession, workflowStores);
          await sessionStore.save(sessionToCompact);
          const newSession = createCompactedSession(
            sessionToCompact,
            result.finalAnswer,
            preservedMessages,
            !!(process.env.B4M_SESSION_ID || process.env.B4M_RESUME_ID)
          );

          await logger.initialize(newSession.id);
          useCliStore.getState().setSession(newSession);
          useCliStore.getState().clearPendingMessages();

          console.log('✅ Auto-compacted. Continuing with your message...\n');

          // Update local reference to use new session for remaining code
          activeSession = newSession;
        }
      } finally {
        useCliStore.getState().setIsThinking(false);
      }
    }
  }

  // Set thinking state to show loading indicator
  useCliStore.getState().setIsThinking(true);

  // Create abort controller for this operation
  const abortController = new AbortController();
  setAbortController(abortController);

  try {
    // Check if message contains images and build multimodal message if needed.
    // any: content is either the raw string or the adapter's multimodal content
    // block array (an untyped LLM-adapter shape); agent.run accepts both.
    let messageContent: any = message;
    let userMessageContent = message;

    if (messageBuilder && messageBuilder.hasImages(message)) {
      const { message: multimodalMessage } = await messageBuilder.buildMessage(message);
      messageContent = multimodalMessage.content;
      userMessageContent = message; // Keep original text with placeholders for display
    }

    // Create user message
    const userMessage: Message = {
      id: uuidv4(),
      role: 'user',
      content: userMessageContent,
      timestamp: new Date().toISOString(),
    };

    // Create a pending assistant message to show steps as they come in
    const pendingAssistantMessage: Message = {
      id: uuidv4(),
      role: 'assistant',
      content: '...',
      timestamp: new Date().toISOString(),
      metadata: {
        steps: [],
      },
    };

    // Add user message to session.messages (already complete)
    // Use activeSession which may have been updated by auto-compact
    const sessionWithUserMessage: Session = {
      ...activeSession,
      messages: [...activeSession.messages, userMessage],
      updatedAt: new Date().toISOString(),
    };
    useCliStore.getState().setSession(sessionWithUserMessage);

    // Add pending assistant message to pendingMessages (dynamic, will update in real-time)
    useCliStore.getState().addPendingMessage(pendingAssistantMessage);

    // Build conversation history through the one owner of turn assembly:
    // token-aware windowing + lossless mapping, replacing the old slice(-20).
    // Built from activeSession (before the user message just added).
    const contextWindow = getTokenCounter().getContextWindow(activeSession.model, availableModels);
    const previousMessages = ConversationContext.fromSession(activeSession).buildPreviousMessages(messageContent, {
      model: activeSession.model,
      contextWindow,
    });

    // Run agent with conversation history, using multimodal content if images present
    const cliConfig = await configStore.get();

    // Set turn ID for grouped background agent notifications
    const turnId = `turn-${randomBytes(4).toString('hex')}`;
    backgroundManager?.setCurrentTurn(turnId);

    // Per-iteration workflow reminder: re-render open todos/blockers/recent
    // decisions from the live stores before every LLM call so recorded state
    // doesn't decay as the turn grows (the agent replaces it in place, so the
    // context cost is a fixed ceiling). Disabled via the workflowReminders
    // preference or when the host wired no workflow stores.
    const workflowReminder =
      cliConfig.preferences.workflowReminders !== false && (todoStore || decisionStore || blockerStore)
        ? () => {
            const { text, elided } = renderWorkflowReminder(
              {
                todos: todoStore?.todos ?? [],
                decisions: decisionStore?.decisions ?? [],
                blockers: blockerStore?.blockers ?? [],
              },
              { maxTokens: cliConfig.preferences.workflowReminderMaxTokens }
            );
            if (elided > 0) {
              logger.debug(`[workflowReminder] elided ${elided} item(s) to fit the token cap`);
            }
            return text;
          }
        : undefined;

    let result;
    try {
      result = await agent.run(messageContent, {
        previousMessages: previousMessages.length > 0 ? previousMessages : undefined,
        signal: abortController.signal,
        parallelExecution: cliConfig.preferences.enableParallelToolExecution === true,
        isReadOnlyTool,
        workflowReminder,
        // Mid-loop recovery if a provider context-window error interrupts this
        // turn: compact the in-flight history once and retry, instead of
        // failing the turn and losing the user's work.
        onContextLimit: createReactiveCompactionHandler(agent, activeSession, 1 + previousMessages.length + 1),
      });
    } finally {
      backgroundManager?.setCurrentTurn(null);
    }

    // Check if permission was denied
    const permissionDenied = result.finalAnswer.startsWith('Permission denied for tool');

    // Provide immediate feedback if permission was denied
    if (permissionDenied) {
      console.log('\n⚠️  Action denied by user\n');
    }

    // Count successful tool calls from result.steps (observations = completed tools)
    const successfulToolCalls = result.steps.filter(s => s.type === 'observation').length;

    // Create the final assistant message. richContent carries the lossless
    // tool trace so the next turn can replay tool results, not just the prose.
    const richContent = reconstructTurnBlocks(result.steps, result.finalAnswer);
    const finalAssistantMessage: Message = {
      id: pendingAssistantMessage.id, // Preserve the original message ID
      role: 'assistant',
      content: result.finalAnswer,
      ...(richContent ? { richContent } : {}),
      timestamp: pendingAssistantMessage.timestamp,
      metadata: {
        tokenUsage: {
          prompt: 0,
          completion: 0,
          total: result.completionInfo.totalTokens,
        },
        creditsUsed: result.completionInfo.totalCredits,
        steps: result.steps.map(formatStep), // Complete history: thoughts, actions, observations
        permissionDenied,
      },
    };

    // Move the pending message to session.messages (history)
    useCliStore.getState().completePendingMessage(0, finalAssistantMessage);

    // Get the updated session and update metadata
    const currentSession = useCliStore.getState().session;
    if (!currentSession) return;

    const updatedSession: Session = {
      ...currentSession,
      metadata: {
        ...currentSession.metadata,
        totalTokens: currentSession.metadata.totalTokens + result.completionInfo.totalTokens,
        totalCredits: (currentSession.metadata.totalCredits || 0) + (result.completionInfo.totalCredits || 0),
        toolCallCount: currentSession.metadata.toolCallCount + successfulToolCalls,
        // Sync durable workflow state so decisions/blockers logged this turn are
        // persisted (and current for the next turn's auto-compaction), not left
        // only in the in-memory stores until a /save or handoff.
        workflow:
          buildWorkflowState(workflowStores, currentSession.metadata.workflow?.handoff) ??
          currentSession.metadata.workflow,
      },
    };

    useCliStore.getState().setSession(updatedSession);

    // Auto-save session
    await sessionStore.save(updatedSession);
  } catch (error) {
    // Clear pending messages on error
    useCliStore.getState().clearPendingMessages();

    // Handle abort (user pressed ESC)
    if (error instanceof Error && error.name === 'AbortError') {
      logger.debug('[ABORT] Operation aborted by user');

      // Add cancellation message to session
      const currentSession = useCliStore.getState().session;
      if (currentSession) {
        const cancelMessage: Message = {
          id: uuidv4(),
          role: 'assistant',
          content: '⚠️ Operation cancelled by user',
          timestamp: new Date().toISOString(),
          metadata: {
            cancelled: true,
          },
        };

        // Flush workflow state too: a decision/blocker logged before the user
        // hit ESC would otherwise live only in the in-memory store and be lost
        // if the process exits before the next successful turn's save.
        const sessionWithCancel = withFlushedWorkflowState(
          {
            ...currentSession,
            messages: [...currentSession.messages, cancelMessage],
            updatedAt: new Date().toISOString(),
          },
          workflowStores
        );

        useCliStore.getState().setSession(sessionWithCancel);
        await sessionStore.save(sessionWithCancel);
      }
      return;
    }

    // Handle authentication errors gracefully (without stack trace)
    if (error instanceof Error) {
      if (error.message.includes('Authentication failed') || error.message.includes('Authentication expired')) {
        console.log('\n❌ Authentication failed');
        console.log('💡 Run /login to authenticate with your API environment.\n');
        return;
      }
    }

    // Defense in depth: a bare network-level abort (e.g. `Error: aborted`
    // from a TLS socket close, the symptom that rendered as a cryptic
    // "❌ aborted") is not the user cancelling - it's the connection dropping.
    // The streaming backend retries these and rewrites the message, but if a
    // bare one ever reaches here from another path (other backends, etc.),
    // surface something the user can act on rather than a one-word error.
    // Reuse the shared retry-policy classifier so this stays in lockstep with
    // the full set of transient patterns both transports retry (ETIMEDOUT,
    // terminated, fetch failed, UND_ERR_SOCKET, ...) - not a hand-maintained subset.
    const rawMessage = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && isTransientNetworkError(error)) {
      console.error('\n❌ The connection to the server dropped mid-response. Type "continue" to resume.\n');
      logger.debug(`Full error details: ${error.stack || error.message}`);
      return;
    }

    // Handle other errors - clean message for users, full stack in debug logs
    console.error(`\n❌ ${rawMessage}\n`);
    logger.debug(`Full error details: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  } finally {
    // Tavern: the ReAct turn has settled. Parity with Claude Code's
    // tavern integration: a finished turn means "your turn now" - emit
    // `awaiting_input` so the chime/toast/tab-badge fire and a remote
    // user knows to come back. The exception is a user-initiated abort
    // (ESC): they're already at the keyboard, so emit silent `idle`.
    // Read from the local `abortController` created at the top of this turn -
    // the controller published via setAbortController is already null by now
    // because the ESC handler clears it eagerly.
    const wasAborted = abortController.signal.aborted;
    setAbortController(null);
    useCliStore.getState().setIsThinking(false);
    // Process-hook (host action_required signal): end of turn - clear any block
    // sentinel (covers a *denied* permission, which never reaches PostToolUse).
    void getProcessHooks()?.fireStop();
    void bridgePresence.emitEvent({
      type: 'status',
      status: wasAborted ? 'idle' : 'awaiting_input',
    });
    // Drain the user-message queue: if the user submitted more messages
    // while this one was processing, collate ALL of them into a single
    // combined prompt (separated by blank lines) and submit as one
    // request. Fewer round-trips and the model can address everything
    // at once. ESC clears the queue (see ESC handler), so an aborted
    // turn falls through with an empty queue. setImmediate defers the
    // recursive call out of this finally to avoid re-entering
    // runTurn synchronously.
    if (!wasAborted) {
      const queued = useCliStore.getState().dequeueAllMessages();
      if (queued.length > 0) {
        const combined = queued.join('\n\n');
        setImmediate(() => {
          void runTurn(combined, ctx);
        });
      }
    }
  }
}
