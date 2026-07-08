import { ReActAgent, filterToolsByPatterns, humanizeToolName } from '@bike4mind/agents';
import type { AgentResult, AgentStep, ThoroughnessLevel, ServerAgentDefinition } from '@bike4mind/agents';
import { getTextModelCost, type ModelInfo } from '@bike4mind/common';
import type { ICompletionBackend, ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import { usdToCredits } from '@bike4mind/utils';

/** Maximum delegation depth rendered inline in the UI. Children at this
 * depth and beyond have `delegate_to_agent` stripped so nesting stays bounded. */
export const MAX_SUBAGENT_DEPTH = 3;

/** Tools denied only when a subagent has reached the depth cap. */
const DEPTH_CAP_DENIED = ['delegate_to_agent'];

/** Timeout per thoroughness level - very_thorough gets more time for multi-page enumeration */
export const SUBAGENT_TIMEOUT_BY_THOROUGHNESS: Record<ThoroughnessLevel, number> = {
  quick: 2 * 60 * 1000, // 2 minutes
  // 3 min: reduced from 5min to prevent cascading timeouts across multiple delegations.
  // 30-45s was recommended; 3 min is a conservative midpoint to preserve
  // graceful partial-result recovery while still tightening the budget.
  medium: 3 * 60 * 1000,
  very_thorough: 10 * 60 * 1000, // 10 minutes
};

/**
 * Buffer the parent must keep in reserve when polling a Lambda-dispatched child.
 * If the parent's remaining Lambda time drops below this, we self-dispatch via
 * the continuation queue so the parent can resume in a fresh Lambda once the
 * child completes. Sized to leave room for the handoff write + SQS round-trip.
 *
 * Exported so the Agent Executor's resume-after-handoff poller uses the same
 * threshold - if the two drift apart, the parent could self-dispatch from the
 * orchestrator's poll loop and then immediately again from the resume loop
 * (or vice versa), wasting Lambda invocations.
 */
export const PARENT_DEADLINE_BUFFER_MS = 90 * 1000;

/**
 * Wall-clock the parent must have remaining in order to safely run a subagent
 * in-process. If remaining time is below this, the orchestrator dispatches the
 * child to its own Lambda instead - even if the parent has enough time to
 * START the child, an in-process run that exceeds remaining time would be
 * killed mid-execution without producing partial results.
 */
const PARENT_INPROCESS_SAFETY_MS = 60 * 1000;

/** Polling backoff for Lambda-dispatched subagents. Start at 2s, double up to 30s. */
const POLL_INITIAL_MS = 2_000;
const POLL_MAX_MS = 30_000;

/**
 * Snapshot of subagent runtime knobs persisted on a child execution doc when the
 * child is dispatched to its own Lambda. Mirrors `ISubagentConfig` in the database
 * model but kept structurally separate to avoid a cross-package type dependency.
 */
export interface SubagentDispatchConfig {
  agentName: string;
  thoroughness: ThoroughnessLevel;
  maxIterations: number;
  variables?: Record<string, string>;
  attachedFiles?: Array<{ fabFileId: string; filename: string; mimeType?: string }>;
}

/**
 * Terminal status shapes the orchestrator's poll loop expects from `pollChildStatus`.
 * Aligns loosely with `AgentExecutionStatus` but kept here so the orchestrator stays
 * decoupled from the database package.
 */
export interface ChildExecutionStatus {
  status:
    | 'pending'
    | 'running'
    | 'continuing'
    | 'awaiting_permission'
    | 'awaiting_subagent'
    | 'awaiting_dag_children'
    | 'paused'
    | 'completed'
    | 'failed'
    | 'aborted';
  result?: { answer?: string; steps?: AgentStep[]; totalCredits?: number; iterations?: number };
  error?: string;
  abortedAt?: Date;
}

/**
 * Side-channel ref the orchestrator uses to signal the executor that the parent
 * ran out of time mid-poll on a synchronous Lambda-dispatched child. Set on the
 * SHARED ref, NOT thrown - `ReActAgent.executeToolWithQueueFallback` swallows
 * tool exceptions and converts them to "Error: ..." observation strings, so a
 * throw would silently degrade into a regular observation.
 *
 * The executor reads this ref AFTER `runIteration()` returns and, if populated,
 * persists `awaiting_subagent` state + self-dispatches via the continuation queue.
 */
export interface SubagentHandoffSignal {
  awaitingSubagent?: {
    childExecutionId: string;
    agentName: string;
  };
}

/**
 * Lifecycle hooks that let a caller (e.g., the Agent Executor Lambda) persist
 * subagent execution state alongside the parent's. Optional - when omitted, the
 * orchestrator runs in-process with no external bookkeeping (matches the
 * ChatCompletionProcess flow).
 */
export interface ServerSubagentTracker {
  /**
   * Called once when the subagent is about to start. Returns an opaque tracking
   * id (e.g., child AgentExecutionDoc id) that the orchestrator passes back to
   * subsequent hooks so callers can correlate events.
   */
  onStart(info: {
    agentName: string;
    task: string;
    model: string;
    thoroughness: ThoroughnessLevel;
    maxIterations: number;
    /** Whether this child will run as a background execution (independent of the parent's lifecycle). */
    isBackground: boolean;
    /**
     * True when the child will be dispatched to its own Lambda (either background OR
     * sync-with-handoff). Trackers should create the child doc in `pending` status so
     * the dispatched Lambda can CAS-claim it. When false (in-process), the tracker can
     * create with `running` directly since the agent runs immediately in this Lambda.
     */
    willDispatchToLambda: boolean;
    /**
     * The execution id of the direct parent that is spawning this child.
     * Defaults to the top-level execution id when omitted. Set by
     * `createDelegateToAgentTool` for grandchildren so the tracker can emit the
     * correct parent scope on WS events and persist the right `parentExecutionId`
     * in the DB, enabling correct store placement on the client.
     */
    parentExecutionId?: string;
  }): Promise<string>;

  /**
   * Called for each notable agent step so callers can stream nested progress
   * to the parent's UI.
   *
   * Best-effort delivery: the orchestrator dispatches step events with
   * fire-and-forget `.catch()` so a slow consumer cannot stall the agent loop.
   * Implementations must tolerate out-of-order arrival under backpressure.
   */
  onStep?(info: { childExecutionId: string; agentName: string; step: AgentStep; iteration: number }): Promise<void>;

  /**
   * Called for each token delta emitted by the subagent's streaming LLM call
   * within a single iteration. Lets the UI render partial responses live
   * instead of blacking out for 3-5s between steps. Same best-effort delivery
   * contract as `onStep` - fire-and-forget, slow consumer can drop events.
   * `iteration` is 0-indexed, matching the wire convention used by `onStep`.
   */
  onTextDelta?(info: { childExecutionId: string; agentName: string; iteration: number; delta: string }): Promise<void>;

  /**
   * Humanized in-flight status string for the child (e.g. "Searching...",
   * "Working..."). Fired alongside `onStep` for every `action` step the
   * child agent emits. Trackers forward this to the client via a `subagent_progress`
   * WS event keyed by `childExecutionId` so the UI can render what the child is
   * doing right now instead of a static "running" label. Optional - when omitted,
   * the orchestrator falls back to the legacy parent `onProgress` channel for
   * backward compatibility with callers that don't render per-child status.
   */
  onChildProgress?(info: { childExecutionId: string; status: string }): Promise<void>;

  /** Called once on successful completion of the subagent. */
  onComplete(info: { childExecutionId: string; result: ServerAgentExecutionResult }): Promise<void>;

  /**
   * Called once on failure (including timeouts). `partialResult` is included when
   * the orchestrator was able to recover partial output before the failure.
   */
  onFailure(info: {
    childExecutionId: string;
    error: string;
    isTimeout: boolean;
    partialResult?: ServerAgentExecutionResult;
  }): Promise<void>;

  /**
   * Called when the child needs to run in its own Lambda invocation rather than
   * in-process - either because `background: true` was requested OR because the
   * parent's remaining Lambda time is insufficient for the child's thoroughness
   * budget. Implementations should persist `subagentConfig` on the child doc and
   * publish to the dispatch queue.
   */
  onLambdaDispatch?(info: {
    childExecutionId: string;
    subagentConfig: SubagentDispatchConfig;
    isBackground: boolean;
    /** Delegation depth of the child being dispatched. The dispatched Lambda
     * must forward this to its orchestrator so the depth cap fires at the correct level. */
    depth?: number;
  }): Promise<void>;

  /**
   * Poll the child execution's current status. Used during the synchronous
   * Lambda-dispatched path to wait for the child to finish. Returning `null` means
   * "child doc disappeared" - orchestrator treats this as a failure.
   */
  pollChildStatus?(childExecutionId: string): Promise<ChildExecutionStatus | null>;

  /** Propagate an abort from the parent to the dispatched child. */
  abortChild?(childExecutionId: string): Promise<void>;
}

/**
 * Dependencies required by the server-side orchestrator
 */
export interface ServerOrchestratorDeps {
  userId: string;
  llm: ICompletionBackend;
  logger: Logger;
  /** Parent's already-built tools (both B4M native + MCP) */
  parentTools: ICompletionOptionTools[];
  /** Abort signal from the parent request (user cancellation, Lambda timeout) */
  signal?: AbortSignal;
  /** Available models for credit computation */
  availableModels?: ModelInfo[];
  /** Callback to send progress updates to the client during subagent execution */
  onProgress?: (status: string) => Promise<void>;
  /** Extended thinking configuration to propagate to subagents */
  thinking?: { enabled: boolean; budget_tokens: number };
  /**
   * Resolve a fresh LLM backend for the given model ID.
   * Used when agentDef.model requires a different provider than the parent's backend
   * (e.g., agent needs Bedrock but parent uses OpenAI).
   */
  resolveBackend?: (modelId: string) => ICompletionBackend | null;
  /**
   * Optional tracker for persisting subagent execution lifecycle (Phase 2).
   * Used by the Agent Executor Lambda to record child AgentExecutionDocs;
   * unused by ChatCompletionProcess where subagents stay in-process only.
   */
  tracker?: ServerSubagentTracker;
  /**
   * Returns the parent Lambda's remaining wall-clock time in milliseconds.
   * When provided, the orchestrator uses this to decide whether to run a subagent
   * in-process or dispatch it to its own Lambda. Omit (or have it return Infinity)
   * for callers that never run under a Lambda deadline.
   */
  getRemainingTimeMs?: () => number;
  /**
   * Mutable side-channel ref the orchestrator populates when the parent runs out of
   * time mid-poll on a sync Lambda-dispatched child. See `SubagentHandoffSignal`.
   */
  handoffSignal?: SubagentHandoffSignal;
  /**
   * Current delegation depth of this orchestrator instance.
   * 1 = direct child of the top-level execution, 2 = grandchild, etc.
   * When depth >= MAX_SUBAGENT_DEPTH, `delegate_to_agent` is stripped from the
   * child's tool list to enforce the UI depth cap. Defaults to 1.
   */
  depth?: number;
}

/**
 * Options for spawning a server-side subagent
 */
export interface ServerSpawnOptions {
  task: string;
  agentDef: ServerAgentDefinition;
  thoroughness?: ThoroughnessLevel;
  variables?: Record<string, string>;
  attachedFiles?: Array<{ fabFileId: string; filename: string; mimeType?: string }>;
}

/**
 * Result of a background dispatch - no execution result is available yet; the
 * caller surfaces the child execution id to the LLM so it can be referenced later.
 */
export interface BackgroundDispatchResult {
  childExecutionId: string;
  agentName: string;
  thoroughness: ThoroughnessLevel;
}

/**
 * Result from a server-side subagent execution
 */
export interface ServerAgentExecutionResult extends AgentResult {
  agentName: string;
  thoroughness: ThoroughnessLevel;
  summary: string;
  /** Model the delegation actually ran on, for cost attribution by the caller. */
  model: string;
}

/**
 * Server-side SubagentOrchestrator
 *
 * Simplified version of the CLI's SubagentOrchestrator, designed for
 * server/Lambda environments. No hooks, no background execution,
 * no permission prompts, no filesystem-based agent loading.
 */
export class ServerSubagentOrchestrator {
  private deps: ServerOrchestratorDeps;

  constructor(deps: ServerOrchestratorDeps) {
    this.deps = deps;
  }

  async delegateToAgent(options: ServerSpawnOptions): Promise<ServerAgentExecutionResult> {
    const { task, agentDef, thoroughness, variables, attachedFiles } = options;

    // Use the agent's preferred model if specified, fall back to parent's model
    const effectiveModel = agentDef.model || this.deps.llm.currentModel;
    const effectiveThoroughness = thoroughness || agentDef.defaultThoroughness;
    const maxIterations = agentDef.maxIterations[effectiveThoroughness];

    // If the parent's remaining Lambda time is insufficient for an in-process run of
    // this subagent's thoroughness budget, dispatch the child to its own Lambda and
    // poll instead. Parent-owned timeouts always rule: running in-process when we know
    // the parent will be killed mid-execution would lose all work + tracker state.
    if (this.shouldDispatchToLambda(effectiveThoroughness)) {
      return this.dispatchAndPollSubagent({
        agentDef,
        task,
        thoroughness: effectiveThoroughness,
        maxIterations,
        variables,
        attachedFiles,
        effectiveModel,
      });
    }

    // Build denied list: agent's deniedTools + depth cap enforcement.
    // Allow delegate_to_agent at depth < MAX_SUBAGENT_DEPTH so children can
    // spawn grandchildren; deny it at the cap to bound recursion.
    const currentDepth = this.deps.depth ?? 1;
    const deniedTools = [
      ...(agentDef.deniedTools || []),
      ...(currentDepth >= MAX_SUBAGENT_DEPTH ? DEPTH_CAP_DENIED : []),
    ];

    // Filter parent's tools for the subagent
    const filteredTools = filterToolsByPatterns(this.deps.parentTools, agentDef.allowedTools, deniedTools);

    // Substitute variables in system prompt
    let systemPrompt = agentDef.systemPrompt;
    // Use split/join instead of regex to avoid injection via special replacement patterns
    systemPrompt = systemPrompt.split('$TASK').join(task);
    if (variables) {
      for (const [key, value] of Object.entries(variables)) {
        systemPrompt = systemPrompt.split(`$${key}`).join(value);
      }
    }

    // Resolve the LLM backend: if the agent's model differs from the parent's,
    // create a fresh backend for the correct provider (e.g., Bedrock vs OpenAI).
    let effectiveLlm = this.deps.llm;
    if (agentDef.model && agentDef.model !== this.deps.llm.currentModel && this.deps.resolveBackend) {
      const agentBackend = this.deps.resolveBackend(agentDef.model);
      if (agentBackend) {
        agentBackend.currentModel = agentDef.model;
        effectiveLlm = agentBackend;
        this.deps.logger.info(
          `🤖🔄 [SubagentOrchestrator] Resolved fresh backend for agent model "${agentDef.model}" ` +
            `(parent uses "${this.deps.llm.currentModel}")`
        );
      } else {
        this.deps.logger.warn(
          `🤖⚠️ [SubagentOrchestrator] Could not resolve backend for "${agentDef.model}", ` +
            `falling back to parent's backend ("${this.deps.llm.currentModel}")`
        );
      }
    }

    this.deps.logger.info(
      `🤖🚀 [SubagentOrchestrator] Spawning "${agentDef.name}" with ${filteredTools.length} tools, ` +
        `model: ${effectiveModel}, ` +
        `thoroughness: ${effectiveThoroughness}, max iterations: ${maxIterations}`
    );

    // Notify tracker (if any) BEFORE constructing the agent so the child execution
    // doc exists by the time the first `onStep` callback fires.
    let childExecutionId: string | undefined;
    if (this.deps.tracker) {
      try {
        childExecutionId = await this.deps.tracker.onStart({
          agentName: agentDef.name,
          task,
          model: effectiveModel,
          thoroughness: effectiveThoroughness,
          maxIterations,
          isBackground: false,
          willDispatchToLambda: false,
        });
      } catch (err) {
        // Tracker failures must not abort the agent - fall back to untracked execution.
        this.deps.logger.warn(
          `🤖⚠️ [SubagentOrchestrator] tracker.onStart failed; continuing without tracking: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    const agent = new ReActAgent({
      userId: this.deps.userId,
      logger: this.deps.logger,
      llm: effectiveLlm,
      model: effectiveModel,
      tools: filteredTools,
      maxIterations,
      systemPrompt,
      thinking: this.deps.thinking,
    });

    // Wire up progress updates so the client sees live status during subagent
    // execution. Prefer the tracker's per-child channel (`onChildProgress` ->
    // `subagent_progress` WS event) when available so `SubagentStepNest` can
    // render the humanized status under the correct child. Fall back to
    // the parent's `onProgress` channel only when no tracker is wired, since
    // routing child status through the parent's `progress` event clobbers the
    // parent's own status and drops the child correlation.
    if (this.deps.tracker?.onChildProgress && childExecutionId) {
      const onChildProgress = this.deps.tracker.onChildProgress;
      const childId = childExecutionId;
      agent.on('action', (step: AgentStep) => {
        const action = humanizeToolName(step.metadata?.toolName);
        const status = action ? `${action}...` : 'Working...';
        // Match the `onStep` forwarding pattern: log on failure rather than
        // swallow silently. A WS send failure here is best-effort UX (the user
        // briefly sees a stale label) but the agent run continues either way -
        // log so the failure is at least visible in CloudWatch.
        onChildProgress({ childExecutionId: childId, status }).catch(err => {
          this.deps.logger.warn(`🤖⚠️ [SubagentOrchestrator] tracker.onChildProgress failed: ${err}`);
        });
      });
    } else if (this.deps.onProgress) {
      const onProgress = this.deps.onProgress;
      agent.on('action', (step: AgentStep) => {
        const action = humanizeToolName(step.metadata?.toolName);
        const status = action ? `${action}...` : 'Working...';
        onProgress(status).catch(() => {});
      });
    }

    // Wire up structured step streaming for nested progress.
    // Distinct from `onProgress` (humanized text) so the parent can render typed
    // step events with parent/child correlation.
    if (this.deps.tracker?.onStep && childExecutionId) {
      const tracker = this.deps.tracker;
      const childId = childExecutionId;
      const agentName = agentDef.name;
      const forwardStep = (step: AgentStep) => {
        // `getIteration()` is a cheap accessor - `toCheckpoint()` would
        // deep-clone messages/steps/confidenceLog on every step event.
        // ReActAgent increments `iterations` to 1 before emitting the first
        // step, so `getIteration()` returns 1 during iteration 1. The wire
        // convention (mirrored in `agentExecutor.ts` parent emission) is
        // 0-indexed, so subtract 1 to keep parent and child on the same axis.
        const iteration = Math.max(0, agent.getIteration() - 1);
        tracker.onStep!({ childExecutionId: childId, agentName, step, iteration }).catch(err => {
          this.deps.logger.warn(`🤖⚠️ [SubagentOrchestrator] tracker.onStep failed: ${err}`);
        });
      };
      agent.on('thought', forwardStep);
      agent.on('action', forwardStep);
      agent.on('observation', forwardStep);
      agent.on('final_answer', forwardStep);

      // Forward streaming text deltas so the parent's UI can render partial
      // responses live. Skipped when the tracker doesn't implement
      // onTextDelta so legacy trackers keep the same payload volume.
      if (tracker.onTextDelta) {
        const onTextDelta = tracker.onTextDelta.bind(tracker);
        agent.on('text_delta', ({ delta, iteration }) => {
          onTextDelta({ childExecutionId: childId, agentName, iteration, delta }).catch(err => {
            this.deps.logger.warn(`🤖⚠️ [SubagentOrchestrator] tracker.onTextDelta failed: ${err}`);
          });
        });
      }
    }

    // Combine parent abort signal with a per-subagent timeout (scaled by thoroughness)
    // to prevent indefinite hangs from slow MCP tools or network issues.
    const timeoutMs = SUBAGENT_TIMEOUT_BY_THOROUGHNESS[effectiveThoroughness];
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = this.deps.signal ? AbortSignal.any([this.deps.signal, timeoutSignal]) : timeoutSignal;

    // Append structured file context so the subagent has exact filenames and fabFileIds
    let taskWithFiles = task;
    if (attachedFiles?.length) {
      const fileLines = attachedFiles.map(
        f => `  - "${f.filename}" (${f.mimeType || 'unknown'}) → fabFileId: ${f.fabFileId}`
      );
      taskWithFiles += `\n\n[ATTACHED FILES — Use these fabFileId values when calling upload tools. Use the exact filename and fabFileId provided.]\n${fileLines.join('\n')}`;
    }

    const startTime = Date.now();
    try {
      const result = await agent.run(taskWithFiles, { maxIterations, signal: combinedSignal, maxHistoryIterations: 4 });
      const duration = Date.now() - startTime;

      // Compute credits from token usage if model info is available
      if (!result.completionInfo.totalCredits && this.deps.availableModels) {
        const modelInfo = this.deps.availableModels.find(m => m.id === effectiveModel);
        if (modelInfo) {
          const { totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens } =
            result.completionInfo;
          // Cache-aware so this fallback stays on the same basis as the cache-aware
          // costUsd recorded by delegateToAgent's onCredits (see #151) - otherwise a
          // fallback-computed credit sits next to a cache-aware cost in the same row.
          const usdCost = getTextModelCost(
            modelInfo,
            totalInputTokens,
            totalOutputTokens,
            totalCacheReadTokens ?? 0,
            totalCacheWriteTokens ?? 0
          );
          result.completionInfo.totalCredits = usdToCredits(usdCost);
        }
      }

      const summary = this.summarizeResult(result, agentDef);

      this.deps.logger.info(
        `🤖✅ [SubagentOrchestrator] Agent "${agentDef.name}" completed in ${duration}ms, ` +
          `${result.completionInfo.iterations} iterations, ${result.completionInfo.totalTokens} tokens, ` +
          `${result.completionInfo.totalCredits ?? 0} credits` +
          `${summary}`
      );

      const finalResult: ServerAgentExecutionResult = {
        ...result,
        agentName: agentDef.name,
        thoroughness: effectiveThoroughness,
        summary,
        model: effectiveModel,
      };

      if (this.deps.tracker && childExecutionId) {
        try {
          await this.deps.tracker.onComplete({ childExecutionId, result: finalResult });
        } catch (err) {
          this.deps.logger.warn(
            `🤖⚠️ [SubagentOrchestrator] tracker.onComplete failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      return finalResult;
    } catch (error) {
      // Graceful timeout handling: return partial results instead of losing all work
      const isAbortError = error instanceof Error && (error.name === 'AbortError' || error.message.includes('aborted'));

      if (isAbortError) {
        const duration = Date.now() - startTime;
        this.deps.logger.warn(
          `⚠️ [SubagentOrchestrator] Agent "${agentDef.name}" timed out after ${duration}ms, returning partial results`
        );

        // Build partial result from whatever the agent accumulated
        const partialAnswer =
          agent
            .getSteps()
            .filter(s => s.type === 'observation' || s.type === 'thought')
            .map(s => s.content)
            .join('\n\n') || 'Agent timed out before producing results.';

        const partialResult: AgentResult = {
          finalAnswer: partialAnswer,
          steps: agent.getSteps(),
          completionInfo: {
            totalTokens: agent.getTokenUsage(),
            totalInputTokens: 0,
            totalOutputTokens: 0,
            iterations: 0,
            toolCalls: agent.getToolCallCount(),
            reachedMaxIterations: false,
          },
        };

        const summary = this.summarizeResult(partialResult, agentDef);
        const partialServerResult: ServerAgentExecutionResult = {
          ...partialResult,
          agentName: agentDef.name,
          thoroughness: effectiveThoroughness,
          summary: `⚠️ **Partial results (timed out after ${Math.round(duration / 1000)}s)**\n\n${summary}`,
          model: effectiveModel,
        };

        if (this.deps.tracker && childExecutionId) {
          try {
            await this.deps.tracker.onFailure({
              childExecutionId,
              error: error instanceof Error ? error.message : String(error),
              isTimeout: true,
              partialResult: partialServerResult,
            });
          } catch (err) {
            this.deps.logger.warn(
              `🤖⚠️ [SubagentOrchestrator] tracker.onFailure failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }

        return partialServerResult;
      }

      // Non-abort error - notify tracker, then rethrow
      if (this.deps.tracker && childExecutionId) {
        try {
          await this.deps.tracker.onFailure({
            childExecutionId,
            error: error instanceof Error ? error.message : String(error),
            isTimeout: false,
          });
        } catch (err) {
          this.deps.logger.warn(
            `🤖⚠️ [SubagentOrchestrator] tracker.onFailure failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      throw error;
    } finally {
      // Defensive cleanup: the agent goes out of scope so listeners are
      // collected with it, but explicit removal avoids any chance of stray
      // emissions (e.g., async tool callbacks finishing after `run()` returns).
      agent.removeAllListeners();
    }
  }

  /**
   * Dispatch a subagent to its own Lambda invocation without waiting for it. Returns
   * immediately once the child doc is created and the dispatch is published.
   *
   * The parent's iteration continues with a structured result that surfaces the
   * `childExecutionId` so the client can correlate the eventual `subagent_completed`
   * WS event with the original tool call. Background children outlive their parent -
   * the parent's `completed` WS event may fire before the child finishes.
   */
  async dispatchBackgroundAgent(options: ServerSpawnOptions): Promise<BackgroundDispatchResult> {
    const { task, agentDef, thoroughness, variables, attachedFiles } = options;

    if (!this.deps.tracker?.onStart || !this.deps.tracker.onLambdaDispatch) {
      throw new Error(
        'delegate_to_agent: background mode requires a tracker that implements onStart and onLambdaDispatch'
      );
    }

    const effectiveModel = agentDef.model || this.deps.llm.currentModel;
    const effectiveThoroughness = thoroughness || agentDef.defaultThoroughness;
    const maxIterations = agentDef.maxIterations[effectiveThoroughness];

    this.deps.logger.info(
      `🤖🚀 [SubagentOrchestrator] Background-dispatching "${agentDef.name}" ` +
        `(model: ${effectiveModel}, thoroughness: ${effectiveThoroughness}, maxIterations: ${maxIterations})`
    );

    const childExecutionId = await this.deps.tracker.onStart({
      agentName: agentDef.name,
      task,
      model: effectiveModel,
      thoroughness: effectiveThoroughness,
      maxIterations,
      isBackground: true,
      willDispatchToLambda: true,
    });

    await this.deps.tracker.onLambdaDispatch({
      childExecutionId,
      subagentConfig: {
        agentName: agentDef.name,
        thoroughness: effectiveThoroughness,
        maxIterations,
        variables,
        attachedFiles,
      },
      isBackground: true,
      depth: this.deps.depth,
    });

    return {
      childExecutionId,
      agentName: agentDef.name,
      thoroughness: effectiveThoroughness,
    };
  }

  /**
   * Returns true when the orchestrator should dispatch a child to its own Lambda
   * rather than running in-process. Triggered when the parent's remaining wall-clock
   * minus a safety buffer is less than the child's worst-case thoroughness budget.
   *
   * Returns false when `getRemainingTimeMs` is not provided (no Lambda deadline) so
   * non-Lambda callers (e.g., `ChatCompletionProcess`) keep the existing in-process
   * behaviour.
   */
  private shouldDispatchToLambda(thoroughness: ThoroughnessLevel): boolean {
    if (!this.deps.getRemainingTimeMs) return false;
    const remaining = this.deps.getRemainingTimeMs();
    if (!Number.isFinite(remaining)) return false;
    const budgetMs = SUBAGENT_TIMEOUT_BY_THOROUGHNESS[thoroughness];
    return remaining - PARENT_INPROCESS_SAFETY_MS < budgetMs;
  }

  /**
   * Sync dispatch path: create the child doc, kick the child Lambda, and poll until
   * the child reaches a terminal state. If the parent itself runs out of time mid-poll,
   * set `handoffSignal.awaitingSubagent` and return a placeholder. The executor reads
   * the signal after `runIteration()` returns and persists `awaiting_subagent` state.
   */
  private async dispatchAndPollSubagent(args: {
    agentDef: ServerAgentDefinition;
    task: string;
    thoroughness: ThoroughnessLevel;
    maxIterations: number;
    variables?: Record<string, string>;
    attachedFiles?: Array<{ fabFileId: string; filename: string; mimeType?: string }>;
    effectiveModel: string;
  }): Promise<ServerAgentExecutionResult> {
    const { agentDef, task, thoroughness, maxIterations, variables, attachedFiles, effectiveModel } = args;

    if (!this.deps.tracker?.onStart || !this.deps.tracker.onLambdaDispatch || !this.deps.tracker.pollChildStatus) {
      // Without tracker hooks we have no way to dispatch or poll; the only safe
      // fallback is to NOT delegate. Throw a clear error so callers see why.
      throw new Error(
        'delegate_to_agent: insufficient parent Lambda time for in-process execution and tracker is missing onLambdaDispatch/pollChildStatus — cannot run subagent'
      );
    }

    this.deps.logger.info(
      `🤖🚀 [SubagentOrchestrator] Dispatching "${agentDef.name}" to its own Lambda ` +
        `(remaining parent time too short for in-process); will poll for completion`
    );

    const childExecutionId = await this.deps.tracker.onStart({
      agentName: agentDef.name,
      task,
      model: effectiveModel,
      thoroughness,
      maxIterations,
      isBackground: false,
      willDispatchToLambda: true,
    });

    await this.deps.tracker.onLambdaDispatch({
      childExecutionId,
      subagentConfig: {
        agentName: agentDef.name,
        thoroughness,
        maxIterations,
        variables,
        attachedFiles,
      },
      isBackground: false,
      depth: this.deps.depth,
    });

    await this.deps.onProgress?.(`Dispatched ${agentDef.name} to background, waiting…`);

    // Poll loop - exp backoff capped at POLL_MAX_MS. Honor parent abort, propagate
    // to child. Bail to handoff signal when parent's remaining time runs low.
    let delay = POLL_INITIAL_MS;
    while (true) {
      if (this.deps.signal?.aborted) {
        await this.deps.tracker.abortChild?.(childExecutionId).catch(() => {});
        throw new Error('Parent aborted while waiting on subagent');
      }

      if (this.deps.getRemainingTimeMs && this.deps.getRemainingTimeMs() < PARENT_DEADLINE_BUFFER_MS) {
        // Parent must self-dispatch - signal to the executor and return a placeholder.
        if (this.deps.handoffSignal) {
          this.deps.handoffSignal.awaitingSubagent = {
            childExecutionId,
            agentName: agentDef.name,
          };
        }
        this.deps.logger.info(
          `🤖⏸  [SubagentOrchestrator] Parent deadline approaching; handing off subagent "${agentDef.name}" (childExecutionId: ${childExecutionId})`
        );
        return this.buildPlaceholderResult(agentDef, thoroughness, childExecutionId, effectiveModel);
      }

      const status = await this.deps.tracker.pollChildStatus(childExecutionId);
      if (!status) {
        throw new Error(`Subagent execution ${childExecutionId} disappeared mid-poll`);
      }

      if (status.status === 'completed') {
        return this.buildResultFromChildStatus(agentDef, thoroughness, status, effectiveModel, { partial: false });
      }
      if (status.status === 'aborted') {
        return this.buildResultFromChildStatus(agentDef, thoroughness, status, effectiveModel, {
          partial: true,
          aborted: true,
        });
      }
      if (status.status === 'failed') {
        throw new Error(`Subagent "${agentDef.name}" failed: ${status.error ?? 'unknown error'}`);
      }

      await this.deps.onProgress?.(`Waiting on ${agentDef.name}…`);
      await this.sleep(delay);
      delay = Math.min(delay * 2, POLL_MAX_MS);
    }
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private buildPlaceholderResult(
    agentDef: ServerAgentDefinition,
    thoroughness: ThoroughnessLevel,
    childExecutionId: string,
    model: string
  ): ServerAgentExecutionResult {
    const summary =
      `**${agentDef.name} Agent — Dispatched**\n\n` +
      `Subagent dispatched to its own Lambda; parent ran out of time before completion. ` +
      `Resuming on continuation Lambda. (childExecutionId: ${childExecutionId})`;
    return {
      agentName: agentDef.name,
      thoroughness,
      summary,
      model,
      finalAnswer: summary,
      steps: [],
      completionInfo: {
        totalTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        iterations: 0,
        toolCalls: 0,
        reachedMaxIterations: false,
      },
    };
  }

  private buildResultFromChildStatus(
    agentDef: ServerAgentDefinition,
    thoroughness: ThoroughnessLevel,
    status: ChildExecutionStatus,
    model: string,
    opts: { partial: boolean; aborted?: boolean }
  ): ServerAgentExecutionResult {
    const result = status.result;
    const partialResult: AgentResult = {
      finalAnswer: result?.answer ?? '',
      steps: result?.steps ?? [],
      completionInfo: {
        totalTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        iterations: result?.iterations ?? 0,
        toolCalls: 0,
        totalCredits: result?.totalCredits,
        reachedMaxIterations: false,
      },
    };
    const baseSummary = this.summarizeResult(partialResult, agentDef);
    const summary = opts.aborted
      ? `⚠️ **Subagent aborted**\n\n${baseSummary}`
      : opts.partial
        ? `⚠️ **Partial results**\n\n${baseSummary}`
        : baseSummary;
    return {
      ...partialResult,
      agentName: agentDef.name,
      thoroughness,
      model,
      summary,
    };
  }

  private summarizeResult(result: AgentResult, agentDef: ServerAgentDefinition): string {
    const { finalAnswer, completionInfo } = result;
    const maxLength = 2000;
    const truncated =
      finalAnswer.length > maxLength ? finalAnswer.slice(0, maxLength) + '\n\n...(truncated)' : finalAnswer;

    const capitalizedName = agentDef.name.charAt(0).toUpperCase() + agentDef.name.slice(1);
    return [
      `**${capitalizedName} Agent Results**\n`,
      `*${agentDef.description}*`,
      `*Execution: ${completionInfo.iterations} iterations, ${completionInfo.toolCalls} tool calls*\n`,
      truncated,
    ].join('\n');
  }
}
