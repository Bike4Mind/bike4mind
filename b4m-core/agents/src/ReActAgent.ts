import { EventEmitter } from 'events';
import { PermissionDeniedError, type IMessage, type MessageContent, type ICacheStrategy } from '@bike4mind/common';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type {
  AgentCheckpoint,
  AgentContext,
  AgentEvents,
  AgentResult,
  AgentRunOptions,
  AgentStep,
  IterationResult,
} from './types';
import {
  categorizeTools,
  executeToolsInParallel,
  shouldUseParallelExecution,
  defaultIsReadOnlyTool,
  getToolId,
  ToolExecutionAbortedError,
  type ToolExecutionPlan,
  type ToolResult,
  type ToolUseInfo,
} from './toolParallelizer';

/**
 * Placeholder tool_result content for a tool_use that never ran because the run
 * was aborted mid-batch. Emitting it keeps the hard provider invariant that
 * every tool_use block has a matching tool_result - without it an aborted
 * parallel batch leaves orphaned tool_use ids that fail the next turn or a
 * session resume with a provider 400 ("tool_use ids must have tool_result blocks").
 */
const CANCELLED_TOOL_RESULT = 'Tool call cancelled before execution (run aborted).';

/**
 * Map a tool execution result to the observation string appended to history.
 * Backfills a cancellation placeholder for tools that never ran (absent from the
 * results map) or were aborted mid-flight, so every advertised tool_use is
 * paired with a tool_result. Real successes and genuine tool errors are
 * preserved unchanged.
 */
function observationForResult(result: ToolResult | undefined): string {
  if (!result) return CANCELLED_TOOL_RESULT;
  if (result.status === 'fulfilled') return result.result ?? '';
  const message = result.error?.message ?? 'Unknown error';
  // An abort surfaces as a rejected result; present it as a clean cancellation
  // rather than an "Error:" so scoreToolResult does not flag it as a
  // low-confidence tool failure.
  if (message.toLowerCase().includes('aborted')) return CANCELLED_TOOL_RESULT;
  return `Error: ${message}`;
}

/**
 * True when an error is an abort/cancellation (user stop or execution timeout)
 * rather than a real failure. Aborts are benign and must NOT be logged at error
 * severity - error logs trip the CloudWatch ERROR -> LiveOps/Slack alert path and
 * page on routine cancellations.
 */
function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return true;
  // Case-insensitive: the shared retry helpers throw `new Error('Aborted')` (capital
  // A, name 'Error'), and SDKs phrase it differently ('Request aborted', 'operation
  // was aborted'). A lowercase compare catches all of them.
  return error.message.toLowerCase().includes('aborted');
}

/**
 * ReAct (Reasoning and Acting) Agent
 *
 * This agent uses the ReAct pattern to solve problems by:
 * 1. Thinking about what to do (Reasoning)
 * 2. Taking actions using tools (Acting)
 * 3. Observing the results
 * 4. Repeating until a final answer is reached
 *
 * Uses the LLM's native tool-calling instead of regex-parsing model output.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class ReActAgent extends EventEmitter {
  private context: AgentContext;
  private steps: AgentStep[] = [];
  private totalTokens = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCredits = 0;
  private totalCacheReadTokens = 0;
  private totalCacheWriteTokens = 0;
  private toolCallCount = 0;
  /**
   * Provider stop reason of the last LLM completion, preserve-last-non-null.
   * Surfaced on the checkpoint and persisted to `promptMeta.finishReason` for
   * chat parity - lets the client tell a truncated artifact from a completed
   * reply that merely contains an unclosed `<artifact>` tag in prose.
   */
  private lastStopReason?: string;
  private observationQueue: Array<{ toolId: string; toolName: string; result: unknown }> = [];
  private confidenceLog: Array<{
    toolName: string;
    confidence: number;
    source: 'deterministic' | 'llm_self_report' | 'heuristic' | 'default';
    timestamp: number;
  }> = [];
  /** Confidence scores collected during the current iteration (reset each iteration) */
  private iterationConfidences: number[] = [];

  // --- State for runIteration() / checkpoint support ---
  /** Conversation history, promoted from run()-local to instance for checkpoint/resume */
  private messages: IMessage[] = [];
  /** Current iteration count, promoted from run()-local to instance for checkpoint/resume */
  private iterations = 0;
  /** Whether runIteration() has been initialized (messages built, state reset) */
  private iterationInitialized = false;
  /**
   * Length of the initial messages array (system + previousMessages + user query)
   * before any ReAct iteration messages are appended. Used by trimConversationHistory
   * to protect the conversation prefix from being mistaken for iteration nudges.
   */
  private initialMessageCount = 0;

  constructor(context: AgentContext) {
    super();
    this.context = {
      ...context,
      maxIterations: context.maxIterations ?? 50,
      maxTokens: context.maxTokens ?? 4096,
      temperature: context.temperature ?? 0.7,
    };
  }

  /**
   * Return the live tools array used by this agent. Mutations (push/splice)
   * are reflected in subsequent ReAct iterations because the array is read
   * each turn at the top of the loop. Intended for hosts that load tool
   * schemas lazily (see `unknownToolResolver` and the CLI's tool_search
   * meta-tool). Prefer this over reaching into `agent.context.tools` via a
   * type cast.
   */
  getTools(): ICompletionOptionTools[] {
    return this.context.tools;
  }

  /**
   * Replace the live tools array. Used by hosts that need to swap the
   * tool set wholesale (e.g. hot-reload of feature module tools). Prefer
   * `getTools()` + array mutation for incremental additions - replacing
   * the reference invalidates any closures that captured the previous
   * array (e.g. `createToolSearchTool`'s `toolListAccessor`).
   */
  setTools(tools: ICompletionOptionTools[]): void {
    this.context.tools = tools;
  }

  /**
   * Update the system prompt. Used to hot-swap prompts when the user
   * cycles interaction modes (e.g. into plan mode) or when feature
   * modules reload.
   */
  setSystemPrompt(systemPrompt: string): void {
    this.context.systemPrompt = systemPrompt;
  }

  /**
   * Run the agent to completion
   *
   * @param query - The user's question or task (can be text or multimodal content with images)
   * @param options - Optional overrides for this run
   * @returns Agent result with final answer and all steps
   */
  async run(query: string | MessageContent, options: AgentRunOptions = {}): Promise<AgentResult> {
    // Reset state for new run
    this.steps = [];
    this.totalTokens = 0;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCredits = 0;
    this.totalCacheReadTokens = 0;
    this.totalCacheWriteTokens = 0;
    this.toolCallCount = 0;
    this.confidenceLog = [];
    this.iterationConfidences = [];
    this.lastStopReason = undefined;

    const maxIterations = options.maxIterations ?? this.context.maxIterations ?? 50;
    const temperature = options.temperature ?? this.context.temperature ?? 0.7;
    const maxTokens = options.maxTokens ?? this.context.maxTokens ?? 4096;
    const maxTotalTokens = options.maxTotalTokens ?? this.context.maxTotalTokens;
    const maxHistoryIterations = options.maxHistoryIterations ?? 4;

    // Declare variables that need to be accessible in catch block
    let iterations = 0;
    let reachedMaxTotalTokens = false;

    try {
      // Build initial message array with conversation history
      const messages: IMessage[] = [
        {
          role: 'system',
          content: options.context
            ? `${this.getSystemPrompt()}\n\nAdditional context:\n${options.context}`
            : this.getSystemPrompt(),
        },
        // Include previous conversation messages for context
        ...(options.previousMessages || []),
        // Add current user query
        {
          role: 'user',
          content: query,
        },
      ];
      this.messages = messages; // Keep instance state in sync for toCheckpoint()
      this.initialMessageCount = messages.length;

      messages.forEach((msg, i) => {
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        this.context.logger.debug(`  [${i}] ${msg.role}: ${content.substring(0, 150)}...`);
      });

      let finalAnswer = '';
      let reachedMaxIterations = false;

      // Main ReAct loop
      while (iterations < maxIterations) {
        // Check for abort signal at start of each iteration
        if (options.signal?.aborted) {
          this.context.logger.info('[ReActAgent] Operation aborted by user');

          const result: AgentResult = {
            finalAnswer: 'Interrupted',
            steps: this.steps,
            completionInfo: {
              totalTokens: this.totalTokens,
              totalInputTokens: this.totalInputTokens,
              totalOutputTokens: this.totalOutputTokens,
              totalCredits: this.totalCredits > 0 ? this.totalCredits : undefined,
              totalCacheReadTokens: this.totalCacheReadTokens > 0 ? this.totalCacheReadTokens : undefined,
              totalCacheWriteTokens: this.totalCacheWriteTokens > 0 ? this.totalCacheWriteTokens : undefined,
              iterations,
              toolCalls: this.toolCallCount,
              reachedMaxIterations: false,
            },
          };

          this.emit('complete', result);
          return result;
        }

        iterations++;
        this.iterations = iterations; // Keep instance state in sync for toCheckpoint()

        // Throttle iterations if delay is configured (e.g., idle agents)
        if (iterations > 1 && options.iterationDelayMs && options.iterationDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, options.iterationDelayMs));
        }

        this.context.logger.debug(`[ReActAgent] Starting iteration ${iterations}/${maxIterations}`);

        let iterationComplete = false;
        let currentText = '';
        const processedToolIds = new Set<string>(); // Track which tool calls we've already processed
        let hadToolCalls = false; // Track if this iteration had any tool calls
        let thoughtEmitted = false; // Dedupe per-iteration thought step across multi-frame streaming
        const iterStartInputTokens = this.totalInputTokens;
        const iterStartOutputTokens = this.totalOutputTokens;

        // Trim conversation history AND steps to last N iterations if configured.
        // Both are trimmed together to keep messages and steps arrays consistent
        // and prevent unbounded memory growth during long-running agent loops.
        if (maxHistoryIterations > 0 && iterations > 1) {
          trimConversationHistory(messages, maxHistoryIterations, this.initialMessageCount);
          trimSteps(this.steps, maxHistoryIterations);
        }

        // Build cache strategy for prompt caching (system prompt + tools are static across iterations)
        const cacheStrategy: ICacheStrategy | undefined = options.enableCaching
          ? {
              enableCaching: true,
              cacheSystemPrompt: true,
              cacheTools: this.context.tools.length > 0,
              cacheConversationHistory: false, // History changes each iteration
              cacheTTL: '5m',
            }
          : undefined;

        // Stream tokens so consumers (e.g. subagent UI) see live progress within
        // each iteration rather than a blackout until the full LLM response lands.
        // The backend callback fires per-delta with `texts` containing only the
        // new chunk(s) at the active content-block index.
        const iterationIndex = iterations - 1;
        await this.context.llm.complete(
          this.context.model,
          messages,
          {
            stream: true,
            tools: this.context.tools,
            maxTokens,
            temperature,
            abortSignal: options.signal,
            tool_choice: this.context.toolChoice,
            executeTools: false,
            thinking: this.context.thinking,
            cacheStrategy,
          },
          async (texts, completionInfo) => {
            // Collect text chunks and emit deltas for live token streaming
            for (const text of texts) {
              if (text) {
                currentText += text;
                this.emit('text_delta', { delta: text, iteration: iterationIndex });
              }
            }

            // Handle completion info (includes tool calls and token usage)
            if (completionInfo) {
              // Update token usage
              const inputTokens = completionInfo.inputTokens || 0;
              const outputTokens = completionInfo.outputTokens || 0;
              this.totalTokens += inputTokens + outputTokens;
              this.totalInputTokens += inputTokens;
              this.totalOutputTokens += outputTokens;

              // Preserve the last non-null stop reason (see lastStopReason).
              // Early streaming frames carry none; the final frame does.
              if (completionInfo.stopReason != null) {
                this.lastStopReason = completionInfo.stopReason;
              }

              // Accumulate cache stats if available
              if (completionInfo.cacheStats) {
                this.totalCacheReadTokens += completionInfo.cacheStats.cacheReadTokens || 0;
                this.totalCacheWriteTokens += completionInfo.cacheStats.cacheWriteTokens || 0;
              }

              // Update credit usage
              // TODO: deprecate creditsUsed from complete callback as this is always empty
              // Instead compute used credits base on input and output tokens or total tokens
              if (completionInfo.creditsUsed) {
                this.totalCredits += completionInfo.creditsUsed;
              }

              // Handle tool calls.
              // The final-answer / no-tools decision is deferred until after
              // `complete()` resolves (see post-stream block below).
              // Per-frame detection is unsafe: streaming backends pass
              // `{ toolsUsed }` on every text_delta cb, and `toolsUsed` only
              // populates as `tool_use` blocks finish. A preamble like
              // "I'll execute the tool calls now..." emitted before tool_use
              // would mis-fire the guard and end the loop at iteration 1.
              if (completionInfo.toolsUsed && completionInfo.toolsUsed.length > 0) {
                hadToolCalls = true;

                // Emit the model's preamble as a single thought step before
                // the first action of this iteration. Deduped across
                // multi-frame streaming via `thoughtEmitted`.
                if (!thoughtEmitted && currentText.trim()) {
                  const thoughtStep: AgentStep = {
                    type: 'thought',
                    content: currentText.trim(),
                    metadata: {
                      timestamp: Date.now(),
                    },
                  };

                  this.steps.push(thoughtStep);
                  this.emit('thought', thoughtStep);
                  thoughtEmitted = true;
                }

                // Get thinking blocks from completion info (for extended thinking)
                // These are required by Anthropic API when extended thinking is enabled
                const thinkingBlocks = (completionInfo as { thinking?: unknown[] }).thinking || [];

                // Filter to unprocessed tools only
                const unprocessedTools: ToolUseInfo[] = [];
                for (const toolUse of completionInfo.toolsUsed) {
                  const toolCallIdStr = getToolId(toolUse);
                  if (!processedToolIds.has(toolCallIdStr)) {
                    processedToolIds.add(toolCallIdStr);
                    unprocessedTools.push(toolUse);
                  }
                }

                if (unprocessedTools.length === 0) {
                  // All tools already processed, skip
                } else if (
                  options.parallelExecution &&
                  shouldUseParallelExecution(unprocessedTools, options.isReadOnlyTool ?? defaultIsReadOnlyTool)
                ) {
                  // PARALLEL EXECUTION PATH
                  this.context.logger.debug(
                    `[ReActAgent] Parallel execution enabled for ${unprocessedTools.length} tools`
                  );

                  // Phase 1: Emit all action steps first (so user sees them in order)
                  for (const toolUse of unprocessedTools) {
                    this.emitActionStep(toolUse);
                  }

                  // Phase 2: Categorize and execute tools in parallel. On abort this
                  // returns the partial results gathered so far instead of throwing,
                  // so Phase 3 still pairs a tool_result with every advertised tool_use.
                  const plan = categorizeTools(unprocessedTools, options.isReadOnlyTool ?? defaultIsReadOnlyTool);
                  const results = await this.runToolBatchAbortTolerant(plan, options.signal);

                  // Phase 3: Build messages and emit observations in original order.
                  // Tools that never ran (dropped when the abort unwound the batch)
                  // are backfilled with a "cancelled before execution" placeholder.
                  for (const toolUse of unprocessedTools) {
                    const result = results.get(getToolId(toolUse));
                    const observation = observationForResult(result);

                    this.appendToolMessages(messages, toolUse, observation, thinkingBlocks);
                    this.emitObservationStep(toolUse.name, observation);
                  }
                } else {
                  // SEQUENTIAL EXECUTION PATH
                  for (const toolUse of unprocessedTools) {
                    this.emitActionStep(toolUse);

                    // Check for queued observation first (backward compatibility with old pattern)
                    const queuedObs = this.observationQueue.find(obs => obs.toolId === getToolId(toolUse));
                    let observation: string;

                    if (queuedObs) {
                      // Old pattern: use queued observation (backend executed tool)
                      const result = queuedObs.result;
                      const index = this.observationQueue.indexOf(queuedObs);
                      this.observationQueue.splice(index, 1);
                      observation = typeof result === 'string' ? result : JSON.stringify(result);
                    } else {
                      // New pattern: execute tool locally (for executeTools=false backends)
                      observation = await this.executeToolWithQueueFallback(toolUse);
                      this.appendToolMessages(messages, toolUse, observation, thinkingBlocks);
                    }

                    this.emitObservationStep(toolUse.name, observation);
                  }
                }
              }
            }
          }
        );

        // Final-answer decision deferred from the streaming callback.
        // Only safe to decide "no more tools" once `complete()` has resolved -
        // at that point `hadToolCalls` reflects the entire turn, not whatever
        // was visible mid-stream. When subagent LLM calls use `stream: true`,
        // an in-callback guard would fire on the model's preamble before
        // tool_use blocks assembled, terminating tool-using runs at iteration 1.
        if (!hadToolCalls && currentText.trim()) {
          finalAnswer = currentText.trim();

          const iterInputTokens = this.totalInputTokens - iterStartInputTokens;
          const iterOutputTokens = this.totalOutputTokens - iterStartOutputTokens;

          const finalStep: AgentStep = {
            type: 'final_answer',
            content: finalAnswer,
            metadata: {
              timestamp: Date.now(),
              tokenUsage: {
                prompt: iterInputTokens,
                completion: iterOutputTokens,
                total: iterInputTokens + iterOutputTokens,
              },
            },
          };

          this.steps.push(finalStep);
          this.emit('final_answer', finalStep);
          iterationComplete = true;
        }

        // If we got a final answer, break out of the loop
        if (iterationComplete && finalAnswer) {
          break;
        }

        // Confidence gate check after tool execution
        if (hadToolCalls && options.confidenceGate && this.iterationConfidences.length > 0) {
          const iterAvg = this.iterationConfidences.reduce((a, b) => a + b, 0) / this.iterationConfidences.length;
          const decision = options.confidenceGate(iterAvg, iterations);

          if (decision.action === 'wait_for_human') {
            this.context.logger.info(
              `[ReActAgent] Confidence gate PAUSED at iteration ${iterations} (avg: ${iterAvg.toFixed(2)}): ${decision.reason}`
            );
            this.emit('gate_paused', { ...decision, iteration: iterations });
            // Exit loop - human must resume
            finalAnswer = `[Paused for review — confidence ${(iterAvg * 100).toFixed(0)}%] ${decision.reason}`;
            break;
          }
          if (decision.action === 'timed_gate') {
            this.context.logger.info(
              `[ReActAgent] Confidence gate TIMED at iteration ${iterations} (avg: ${iterAvg.toFixed(2)}): ${decision.reason}`
            );
            this.emit('gate_timed', { ...decision, iteration: iterations });
            // Exit loop - timer will resume later
            finalAnswer = `[Timed gate — confidence ${(iterAvg * 100).toFixed(0)}%] ${decision.reason}`;
            break;
          }
          // action === 'proceed'
          this.emit('gate_proceed', { ...decision, iteration: iterations });
        }

        // Reset iteration confidences for next iteration
        this.iterationConfidences = [];

        // After tools complete, nudge the agent to provide the final answer
        // This prevents the agent from forgetting the user's specific requirements (e.g., "list in detail")
        if (!iterationComplete && hadToolCalls) {
          messages.push({
            role: 'user',
            content: `Based on the tool results above, please provide a complete answer. If I asked for multiple things, make sure to address all of them.`,
          });
        }

        // Cost backstop: if cumulative tokens exceed the configured ceiling, exit cleanly.
        // Checked after the LLM call (when tokens have been accumulated) so the current
        // iteration always completes. Matters because the server pays for these tokens.
        if (maxTotalTokens !== undefined && this.totalTokens >= maxTotalTokens && !iterationComplete) {
          reachedMaxTotalTokens = true;
          finalAnswer =
            currentText.trim() ||
            `I stopped after reaching the cumulative token ceiling (${this.totalTokens}/${maxTotalTokens}) without arriving at a final answer.`;

          const finalStep: AgentStep = {
            type: 'final_answer',
            content: finalAnswer,
            metadata: {
              timestamp: Date.now(),
            },
          };

          this.steps.push(finalStep);
          this.emit('final_answer', finalStep);
          break;
        }

        // If we've reached max iterations without a final answer
        if (iterations >= maxIterations) {
          reachedMaxIterations = true;
          finalAnswer =
            currentText.trim() ||
            `I reached the maximum number of iterations (${iterations}/${maxIterations}) without arriving at a final answer.`;

          const finalStep: AgentStep = {
            type: 'final_answer',
            content: finalAnswer,
            metadata: {
              timestamp: Date.now(),
            },
          };

          this.steps.push(finalStep);
          this.emit('final_answer', finalStep);
        }
      }

      // Check if loop was terminated due to abort
      if (options.signal?.aborted && !finalAnswer) {
        finalAnswer = 'Interrupted';
      }

      // Compute confidence statistics
      const avgConfidence =
        this.confidenceLog.length > 0
          ? this.confidenceLog.reduce((sum, c) => sum + c.confidence, 0) / this.confidenceLog.length
          : undefined;
      const minConfidence =
        this.confidenceLog.length > 0 ? Math.min(...this.confidenceLog.map(c => c.confidence)) : undefined;

      const result: AgentResult = {
        finalAnswer,
        steps: this.steps,
        completionInfo: {
          totalTokens: this.totalTokens,
          totalInputTokens: this.totalInputTokens,
          totalOutputTokens: this.totalOutputTokens,
          totalCredits: this.totalCredits > 0 ? this.totalCredits : undefined,
          totalCacheReadTokens: this.totalCacheReadTokens > 0 ? this.totalCacheReadTokens : undefined,
          totalCacheWriteTokens: this.totalCacheWriteTokens > 0 ? this.totalCacheWriteTokens : undefined,
          iterations,
          toolCalls: this.toolCallCount,
          reachedMaxIterations,
          reachedMaxTotalTokens: reachedMaxTotalTokens || undefined,
          averageConfidence: avgConfidence,
          minConfidence,
          confidenceLog: this.confidenceLog.length > 0 ? this.confidenceLog : undefined,
        },
      };

      this.emit('complete', result);
      return result;
    } catch (error) {
      // Handle permission denial gracefully
      if (error instanceof PermissionDeniedError) {
        this.context.logger.info(
          `[ReActAgent] Permission denied for tool '${error.toolName}' - ending session gracefully`
        );

        const result: AgentResult = {
          finalAnswer: `Permission denied for tool '${error.toolName}'. You can use /trust ${error.toolName} to trust this tool permanently, or rephrase your request.`,
          steps: this.steps,
          completionInfo: {
            totalTokens: this.totalTokens,
            totalInputTokens: this.totalInputTokens,
            totalOutputTokens: this.totalOutputTokens,
            totalCredits: this.totalCredits > 0 ? this.totalCredits : undefined,
            iterations,
            toolCalls: this.toolCallCount,
            reachedMaxIterations: false,
          },
        };

        this.emit('complete', result);
        return result;
      }

      // Aborts (user cancel or execution timeout) are benign - log at warn so they
      // stay out of the LiveOps/Slack error alerts. Real failures still log
      // at error. The error still propagates so the caller handles it as before.
      if (isAbortError(error, options.signal)) {
        // Keep the error for stack/message context - only the severity is downgraded.
        this.context.logger.warn('[ReActAgent] Execution aborted (user cancel or timeout):', error);
      } else {
        this.context.logger.error('[ReActAgent] Error during execution:', error);
      }
      this.emit('error', error as Error);
      throw error;
    }
  }

  /**
   * Get the system prompt for the agent
   *
   * This can be overridden in the context or customized here
   */
  private getSystemPrompt(): string {
    const base = this.context.systemPrompt ? this.context.systemPrompt : this.buildDefaultSystemPrompt();

    // Compose: when a persona is set (Agent-mode running a configured agent),
    // prepend it so the agent speaks in character while keeping the operational
    // (ReAct tool-use) guidance below. When no persona, behavior is unchanged.
    const persona = this.context.personaPrompt?.trim();
    const composed = persona ? `${persona}\n\n${base}` : base;

    // Append artifact-emission guidance LAST (after persona + operational prompt)
    // when the host opted in - parity with chat completions, which inject the
    // same guidance so chart/code/HTML/SVG/Mermaid output is wrapped in
    // <artifact> tags. When unset, behavior is unchanged.
    const artifact = this.context.artifactEmissionPrompt?.trim();
    return artifact ? `${composed}\n\n${artifact}` : composed;
  }

  private buildDefaultSystemPrompt(): string {
    const toolNames = this.context.tools
      .map(tool => {
        // Extract tool name from the tool schema
        if (tool.toolSchema && 'name' in tool.toolSchema) {
          const description = 'description' in tool.toolSchema ? tool.toolSchema.description : 'No description';
          return `- ${tool.toolSchema.name}: ${description || 'No description'}`;
        }
        return null;
      })
      .filter(Boolean)
      .join('\n');

    return `You are an autonomous AI agent with access to tools. Your job is to solve problems by taking action, not by asking for clarification.

CORE PRINCIPLES:
1. Be proactive - Use tools to investigate and find answers
2. Make reasonable assumptions when information is unclear
3. Take action - Users expect you to DO things, not just explain them
4. Chain tools together to solve complex problems

Available tools:
${toolNames}

BEHAVIOR GUIDELINES:
- Always prefer using tools over asking clarifying questions
- If a tool fails, try alternative approaches before giving up
- Provide specific, detailed answers with actual data from tools
- Only ask for clarification after exhausting reasonable attempts

Remember: You are an autonomous AGENT. Act independently and solve problems proactively.`;
  }

  /**
   * Add an observation step (used by tool wrappers to record tool results).
   * Kept for backwards compatibility but no longer used. Observations are now
   * queued and drained in the completion callback for correct ordering.
   */
  addObservation(toolName: string, result: unknown): void {
    const observationStep: AgentStep = {
      type: 'observation',
      content: typeof result === 'string' ? result : JSON.stringify(result),
      metadata: {
        toolName,
        timestamp: Date.now(),
      },
    };

    this.steps.push(observationStep);
    this.emit('observation', observationStep);
  }

  /**
   * Get current steps
   */
  getSteps(): AgentStep[] {
    return [...this.steps];
  }

  /**
   * Get current token usage
   */
  getTokenUsage(): number {
    return this.totalTokens;
  }

  /**
   * Get tool call count
   */
  getToolCallCount(): number {
    return this.toolCallCount;
  }

  /**
   * Get current iteration count.
   * Cheap accessor for hot paths (e.g., per-step event listeners) - prefer this
   * over `toCheckpoint().iteration`, which deep-clones messages, steps, and
   * confidence log on every call.
   */
  getIteration(): number {
    return this.iterations;
  }

  /**
   * Surgically replace the observation content of the most recent tool_result
   * message matching `toolCallId`. Used to inject a Lambda-dispatched
   * subagent's terminal answer into the parent's message history without
   * appending a new message (Anthropic rejects consecutive user-role messages,
   * so we replace the placeholder observation in place).
   *
   * Throws if the underlying backend doesn't support this surgery or if no
   * matching message is found.
   */
  replaceLastToolResultObservation(toolCallId: string, newObservation: string): void {
    if (!this.context.llm.replaceLastToolResultObservation) {
      throw new Error(
        `ReActAgent.replaceLastToolResultObservation: backend (${this.context.llm.currentModel}) does not implement replaceLastToolResultObservation — cannot resume after subagent handoff`
      );
    }
    this.context.llm.replaceLastToolResultObservation(this.messages, toolCallId, newObservation);
  }

  /**
   * Locate the LLM-assigned id of the most recent tool call with the given name.
   * Delegates to the backend so each provider's message shape (Anthropic
   * content-block `tool_use` vs OpenAI `assistant.tool_calls`) is handled
   * correctly. Returns `undefined` if the backend doesn't implement the lookup
   * or no matching call exists.
   */
  getLatestToolCallId(toolName: string): string | undefined {
    if (!this.context.llm.getLatestToolCallId) return undefined;
    return this.context.llm.getLatestToolCallId(this.messages, toolName);
  }

  /**
   * Serialize the agent's current execution state for persistence.
   *
   * Call this after each iteration to create a durable checkpoint that can
   * survive Lambda timeouts, process restarts, or network failures.
   * The checkpoint is JSON-serializable and can be stored in MongoDB, DynamoDB, etc.
   */
  toCheckpoint(): AgentCheckpoint {
    return {
      iteration: this.iterations,
      messages: structuredClone(this.messages),
      steps: structuredClone(this.steps),
      totalTokens: this.totalTokens,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalCacheReadTokens: this.totalCacheReadTokens,
      totalCacheWriteTokens: this.totalCacheWriteTokens,
      totalCredits: this.totalCredits,
      toolCallCount: this.toolCallCount,
      confidenceLog: structuredClone(this.confidenceLog),
      iterationConfidences: [...this.iterationConfidences],
      initialMessageCount: this.initialMessageCount,
      finishReason: this.lastStopReason,
    };
  }

  /**
   * Restore the agent's execution state from a previously saved checkpoint.
   *
   * Call this before `runIteration()` to resume execution from where it left off.
   * The agent will continue from the next iteration after the checkpoint.
   *
   * **Important:** The agent context (tools, LLM backend, model) must be compatible
   * with the checkpoint - tools are rebuilt per Lambda invocation, not serialized.
   */
  fromCheckpoint(checkpoint: AgentCheckpoint): void {
    this.iterations = checkpoint.iteration;
    this.messages = structuredClone(checkpoint.messages);
    this.steps = structuredClone(checkpoint.steps);
    this.totalTokens = checkpoint.totalTokens;
    this.totalInputTokens = checkpoint.totalInputTokens;
    this.totalOutputTokens = checkpoint.totalOutputTokens;
    this.totalCacheReadTokens = checkpoint.totalCacheReadTokens;
    this.totalCacheWriteTokens = checkpoint.totalCacheWriteTokens;
    this.totalCredits = checkpoint.totalCredits;
    this.toolCallCount = checkpoint.toolCallCount;
    this.confidenceLog = structuredClone(checkpoint.confidenceLog);
    this.iterationConfidences = [...checkpoint.iterationConfidences];
    // Fall back to messages.length for legacy checkpoints written before this
    // field existed; safe because at the point fromCheckpoint runs, no iteration
    // messages have been appended yet for the resumed run.
    this.initialMessageCount = checkpoint.initialMessageCount ?? this.messages.length;
    // Restore so a run finishing in a continuation Lambda still persists the
    // stop reason; the finishing Lambda's final completion re-sets it regardless.
    this.lastStopReason = checkpoint.finishReason;
    // observationQueue is always drained within a single LLM callback -
    // it cannot contain data at checkpoint boundaries. Clear it explicitly.
    this.observationQueue = [];
    // Mark as initialized since we're resuming from a checkpoint (messages already built)
    this.iterationInitialized = true;
  }

  /**
   * Execute a single ReAct iteration and return the result with a checkpoint.
   *
   * This is the serverless-native entry point. Unlike `run()` which loops internally,
   * `runIteration()` gives the caller control over the execution loop so it can:
   * - Checkpoint after each iteration (persist to MongoDB)
   * - Stream progress to the client
   * - Check timeout watchdog (self-dispatch before Lambda timeout)
   * - Apply permission prompts between iterations
   * - Deduct credits per iteration
   *
   * **First call:** Pass `query` to initialize the conversation.
   * **Subsequent calls / resumed from checkpoint:** `query` is ignored (messages already built).
   *
   * @param query - The user's question or task. Required on first call, ignored when resumed from checkpoint.
   * @param options - Run options (maxIterations, temperature, etc.)
   * @returns Iteration result with step, completion status, and checkpoint
   *
   * @remarks
   * **No `'complete'` event:** Unlike `run()`, this method does not emit a `'complete'` event.
   * The caller controls the iteration loop and is responsible for detecting completion
   * via `IterationResult.isComplete`.
   *
   * **Not concurrency-safe:** This method mutates agent state (messages, steps, tokens).
   * Do not call concurrently on the same instance. Designed for single-threaded Lambda execution.
   *
   * TODO: The iteration body (LLM call, tool execution, confidence gating) is
   * duplicated between run() and runIteration(). Extract into a shared private method
   * once runIteration() is validated in production.
   */
  async runIteration(query?: string | MessageContent, options: AgentRunOptions = {}): Promise<IterationResult> {
    const maxIterations = options.maxIterations ?? this.context.maxIterations ?? 50;
    const temperature = options.temperature ?? this.context.temperature ?? 0.7;
    const maxTokens = options.maxTokens ?? this.context.maxTokens ?? 4096;
    const maxTotalTokens = options.maxTotalTokens ?? this.context.maxTotalTokens;

    // Initialize on first call (not resumed from checkpoint)
    if (!this.iterationInitialized) {
      if (!query) {
        throw new Error(
          'query is required on the first call to runIteration(). Pass the user query, or call fromCheckpoint() first to resume.'
        );
      }

      this.steps = [];
      this.totalTokens = 0;
      this.totalInputTokens = 0;
      this.totalOutputTokens = 0;
      this.totalCredits = 0;
      this.totalCacheReadTokens = 0;
      this.totalCacheWriteTokens = 0;
      this.toolCallCount = 0;
      this.confidenceLog = [];
      this.iterationConfidences = [];
      this.lastStopReason = undefined;
      this.iterations = 0;

      this.messages = [
        {
          role: 'system',
          content: options.context
            ? `${this.getSystemPrompt()}\n\nAdditional context:\n${options.context}`
            : this.getSystemPrompt(),
        },
        ...(options.previousMessages || []),
        { role: 'user', content: query },
      ] as IMessage[];

      this.initialMessageCount = this.messages.length;
      this.iterationInitialized = true;
    }

    // Check if already complete
    if (this.iterations >= maxIterations) {
      const finalStep: AgentStep = {
        type: 'final_answer',
        content: `I reached the maximum number of iterations (${this.iterations}/${maxIterations}) without arriving at a final answer.`,
        metadata: { timestamp: Date.now(), iteration: Math.max(0, this.iterations - 1) },
      };
      this.steps.push(finalStep);
      return {
        step: finalStep,
        allSteps: [finalStep],
        isComplete: true,
        reachedMaxIterations: true,
        checkpoint: this.toCheckpoint(),
      };
    }

    // Check abort signal
    if (options.signal?.aborted) {
      const finalStep: AgentStep = {
        type: 'final_answer',
        content: 'Interrupted',
        metadata: { timestamp: Date.now(), iteration: Math.max(0, this.iterations - 1) },
      };
      this.steps.push(finalStep);
      return {
        step: finalStep,
        allSteps: [finalStep],
        isComplete: true,
        reachedMaxIterations: false,
        checkpoint: this.toCheckpoint(),
      };
    }

    // Snapshot state before mutation so we can fully rollback on error.
    // Only iterations-- is insufficient - steps, messages, tokens, and tool counts
    // are also mutated during the iteration body.
    const preIterationCheckpoint = this.toCheckpoint();

    this.iterations++;
    this.iterationConfidences = [];
    const iterationSteps: AgentStep[] = [];

    try {
      // Throttle if configured
      if (this.iterations > 1 && options.iterationDelayMs && options.iterationDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, options.iterationDelayMs));
      }

      this.context.logger.debug(`[ReActAgent] Starting iteration ${this.iterations}/${maxIterations}`);

      // Trim conversation history and steps to last N iterations
      const maxHistoryIterations = options.maxHistoryIterations ?? 4;
      if (maxHistoryIterations > 0 && this.iterations > 1) {
        trimConversationHistory(this.messages, maxHistoryIterations, this.initialMessageCount);
        trimSteps(this.steps, maxHistoryIterations);
      }

      let iterationComplete = false;
      let currentText = '';
      let finalAnswer = '';
      const processedToolIds = new Set<string>();
      let hadToolCalls = false;
      let thoughtEmitted = false; // Dedupe per-iteration thought step across multi-frame streaming
      const iterStartInputTokens = this.totalInputTokens;
      const iterStartOutputTokens = this.totalOutputTokens;

      const cacheStrategy: ICacheStrategy | undefined = options.enableCaching
        ? {
            enableCaching: true,
            cacheSystemPrompt: true,
            cacheTools: this.context.tools.length > 0,
            cacheConversationHistory: false,
            cacheTTL: '5m',
          }
        : undefined;

      // Stream tokens so consumers see live progress within the iteration.
      const iterationIndex = this.iterations - 1;
      // Execute one LLM call + tool execution cycle
      await this.context.llm.complete(
        this.context.model,
        this.messages,
        {
          stream: true,
          tools: this.context.tools,
          maxTokens,
          temperature,
          abortSignal: options.signal,
          tool_choice: this.context.toolChoice,
          executeTools: false,
          thinking: this.context.thinking,
          cacheStrategy,
        },
        async (texts, completionInfo) => {
          for (const text of texts) {
            if (text) {
              currentText += text;
              this.emit('text_delta', { delta: text, iteration: iterationIndex });
            }
          }

          if (completionInfo) {
            const inputTokens = completionInfo.inputTokens || 0;
            const outputTokens = completionInfo.outputTokens || 0;
            this.totalTokens += inputTokens + outputTokens;
            this.totalInputTokens += inputTokens;
            this.totalOutputTokens += outputTokens;

            // Preserve the last non-null stop reason (see lastStopReason).
            // A prior tool_use turn is overwritten by the final completion.
            if (completionInfo.stopReason != null) {
              this.lastStopReason = completionInfo.stopReason;
            }

            if (completionInfo.cacheStats) {
              this.totalCacheReadTokens += completionInfo.cacheStats.cacheReadTokens || 0;
              this.totalCacheWriteTokens += completionInfo.cacheStats.cacheWriteTokens || 0;
            }

            if (completionInfo.creditsUsed) {
              this.totalCredits += completionInfo.creditsUsed;
            }

            // Handle tool calls.
            // The final-answer / no-tools decision is deferred until after
            // `complete()` resolves (see post-stream block below). See the
            // matching comment in `run()` for the streaming rationale.
            if (completionInfo.toolsUsed && completionInfo.toolsUsed.length > 0) {
              hadToolCalls = true;

              // Emit the model's preamble as a single thought step before
              // the first action of this iteration. Deduped via
              // `thoughtEmitted` across multi-frame streaming.
              if (!thoughtEmitted && currentText.trim()) {
                const thoughtStep: AgentStep = {
                  type: 'thought',
                  content: currentText.trim(),
                  // `this.iterations` is 1-indexed at the start of each
                  // runIteration (incremented at the top of the method). Subtract 1 so the
                  // persisted iteration matches the 0-indexed convention used
                  // on the WS wire and by IterationStream's groupByIteration.
                  metadata: { timestamp: Date.now(), iteration: this.iterations - 1 },
                };
                this.steps.push(thoughtStep);
                iterationSteps.push(thoughtStep);
                this.emit('thought', thoughtStep);
                thoughtEmitted = true;
              }

              const thinkingBlocks = (completionInfo as { thinking?: unknown[] }).thinking || [];

              const unprocessedTools: ToolUseInfo[] = [];
              for (const toolUse of completionInfo.toolsUsed) {
                const toolCallIdStr = getToolId(toolUse);
                if (!processedToolIds.has(toolCallIdStr)) {
                  processedToolIds.add(toolCallIdStr);
                  unprocessedTools.push(toolUse);
                }
              }

              if (unprocessedTools.length > 0) {
                if (
                  options.parallelExecution &&
                  shouldUseParallelExecution(unprocessedTools, options.isReadOnlyTool ?? defaultIsReadOnlyTool)
                ) {
                  for (const toolUse of unprocessedTools) {
                    const actionStep = this.buildActionStep(toolUse);
                    iterationSteps.push(actionStep);
                  }
                  // On abort this returns the partial results instead of throwing, so the
                  // loop below still pairs a tool_result with every advertised tool_use.
                  // That keeps the aborted iteration's checkpoint self-consistent (every
                  // tool_use paired) rather than relying on the catch-block rollback, so a
                  // resumed session replays cleanly with no orphaned tool_use ids.
                  const plan = categorizeTools(unprocessedTools, options.isReadOnlyTool ?? defaultIsReadOnlyTool);
                  const results = await this.runToolBatchAbortTolerant(plan, options.signal);
                  for (const toolUse of unprocessedTools) {
                    const result = results.get(getToolId(toolUse));
                    const observation = observationForResult(result);
                    this.appendToolMessages(this.messages, toolUse, observation, thinkingBlocks);
                    const obsStep = this.buildObservationStep(toolUse.name, observation);
                    iterationSteps.push(obsStep);
                  }
                } else {
                  for (const toolUse of unprocessedTools) {
                    const actionStep = this.buildActionStep(toolUse);
                    iterationSteps.push(actionStep);

                    const queuedObs = this.observationQueue.find(obs => obs.toolId === getToolId(toolUse));
                    let observation: string;
                    if (queuedObs) {
                      const result = queuedObs.result;
                      const index = this.observationQueue.indexOf(queuedObs);
                      this.observationQueue.splice(index, 1);
                      observation = typeof result === 'string' ? result : JSON.stringify(result);
                    } else {
                      observation = await this.executeToolWithQueueFallback(toolUse);
                      this.appendToolMessages(this.messages, toolUse, observation, thinkingBlocks);
                    }
                    const obsStep = this.buildObservationStep(toolUse.name, observation);
                    iterationSteps.push(obsStep);
                  }
                }
              }
            }
          }
        }
      );

      // Final-answer decision deferred from the streaming callback. See the
      // matching comment in `run()` for full rationale.
      if (!hadToolCalls && currentText.trim()) {
        finalAnswer = currentText.trim();

        const iterInputTokens = this.totalInputTokens - iterStartInputTokens;
        const iterOutputTokens = this.totalOutputTokens - iterStartOutputTokens;

        const finalStep: AgentStep = {
          type: 'final_answer',
          content: finalAnswer,
          metadata: {
            timestamp: Date.now(),
            iteration: this.iterations - 1,
            tokenUsage: {
              prompt: iterInputTokens,
              completion: iterOutputTokens,
              total: iterInputTokens + iterOutputTokens,
            },
          },
        };
        this.steps.push(finalStep);
        iterationSteps.push(finalStep);
        this.emit('final_answer', finalStep);
        iterationComplete = true;
      }

      // Confidence gate check
      if (hadToolCalls && options.confidenceGate && this.iterationConfidences.length > 0) {
        const iterAvg = this.iterationConfidences.reduce((a, b) => a + b, 0) / this.iterationConfidences.length;
        const decision = options.confidenceGate(iterAvg, this.iterations);

        if (decision.action === 'wait_for_human' || decision.action === 'timed_gate') {
          const eventName = decision.action === 'wait_for_human' ? 'gate_paused' : 'gate_timed';
          this.emit(eventName, { ...decision, iteration: this.iterations });

          const label = decision.action === 'wait_for_human' ? 'Paused for review' : 'Timed gate';
          finalAnswer = `[${label} — confidence ${(iterAvg * 100).toFixed(0)}%] ${decision.reason}`;

          const gateStep: AgentStep = {
            type: 'final_answer',
            content: finalAnswer,
            metadata: { timestamp: Date.now(), iteration: this.iterations - 1 },
          };
          this.steps.push(gateStep);
          iterationSteps.push(gateStep);

          return {
            step: gateStep,
            allSteps: iterationSteps,
            isComplete: true,
            reachedMaxIterations: false,
            checkpoint: this.toCheckpoint(),
          };
        }
        this.emit('gate_proceed', { ...decision, iteration: this.iterations });
      }

      // Reset iteration confidences for next iteration
      this.iterationConfidences = [];

      // Add nudge for next iteration if tools were called but no final answer
      if (!iterationComplete && hadToolCalls) {
        this.messages.push({
          role: 'user',
          content:
            'Based on the tool results above, please provide a complete answer. If I asked for multiple things, make sure to address all of them.',
        } as IMessage);
      }

      // Cost backstop: if cumulative tokens exceeded the ceiling, terminate this run.
      // The check runs after token accumulation so the current iteration's work is preserved.
      if (!iterationComplete && maxTotalTokens !== undefined && this.totalTokens >= maxTotalTokens) {
        finalAnswer =
          currentText.trim() ||
          `I stopped after reaching the cumulative token ceiling (${this.totalTokens}/${maxTotalTokens}) without arriving at a final answer.`;

        const ceilingStep: AgentStep = {
          type: 'final_answer',
          content: finalAnswer,
          metadata: { timestamp: Date.now(), iteration: this.iterations - 1 },
        };
        this.steps.push(ceilingStep);
        iterationSteps.push(ceilingStep);
        this.emit('final_answer', ceilingStep);

        return {
          step: ceilingStep,
          allSteps: iterationSteps,
          isComplete: true,
          reachedMaxIterations: false,
          reachedMaxTotalTokens: true,
          checkpoint: this.toCheckpoint(),
        };
      }

      // Check if we've reached max iterations
      if (!iterationComplete && this.iterations >= maxIterations) {
        finalAnswer =
          currentText.trim() ||
          `I reached the maximum number of iterations (${this.iterations}/${maxIterations}) without arriving at a final answer.`;

        const maxStep: AgentStep = {
          type: 'final_answer',
          content: finalAnswer,
          metadata: { timestamp: Date.now(), iteration: this.iterations - 1 },
        };
        this.steps.push(maxStep);
        iterationSteps.push(maxStep);
        this.emit('final_answer', maxStep);

        return {
          step: maxStep,
          allSteps: iterationSteps,
          isComplete: true,
          reachedMaxIterations: true,
          checkpoint: this.toCheckpoint(),
        };
      }

      // Determine the primary step for this iteration. Use findLast (not
      // find) for the same reason agentExecutor's persistence sites do:
      // the streaming LLM callback can push multiple `final_answer` steps
      // per iteration (one per delta, each holding the accumulated text so
      // far), and only the last entry contains the complete reply.
      const primaryStep = iterationSteps.findLast(s => s.type === 'final_answer') ||
        iterationSteps[iterationSteps.length - 1] || {
          type: 'thought' as const,
          content: currentText.trim() || 'No output from this iteration',
          metadata: { timestamp: Date.now() },
        };

      return {
        step: primaryStep,
        allSteps: iterationSteps,
        isComplete: iterationComplete,
        reachedMaxIterations: false,
        checkpoint: this.toCheckpoint(),
      };
    } catch (error) {
      // Capture the in-flight iteration index BEFORE rollback. `this.iterations`
      // was incremented to N at the top of this method; `N - 1` is the 0-indexed iteration this
      // body was running. After `fromCheckpoint(preIterationCheckpoint)`,
      // `this.iterations` reverts to N-1 and `this.iterations - 1` would
      // resolve to N-2 - stamping the error step into the wrong iteration
      // accordion (off-by-one). Stash it now so the post-rollback stamp is
      // correct for all error paths below.
      const inFlightIteration = Math.max(0, this.iterations - 1);
      // Full rollback: restore all mutable state so the caller can retry from a clean slate.
      // Only rolling back this.iterations is insufficient - steps, messages, tokens,
      // and tool counts mutated during the iteration would leave inconsistent state.
      this.fromCheckpoint(preIterationCheckpoint);

      if (error instanceof PermissionDeniedError) {
        this.context.logger.info(
          `[ReActAgent] Permission denied for tool '${error.toolName}' in runIteration - ending gracefully`
        );
        const errorStep: AgentStep = {
          type: 'final_answer',
          content: `Permission denied for tool '${error.toolName}'.`,
          metadata: { timestamp: Date.now(), iteration: inFlightIteration },
        };
        this.steps.push(errorStep);
        iterationSteps.push(errorStep);
        // Mirror the other ceiling paths (max tokens / max iterations) which
        // emit before returning. Without this, consumers subscribed to step
        // events (web queue handler's `streamStep`, CLI's `agent.on('final_answer')`)
        // never see the "Permission denied for tool X" line in the iteration
        // trace - they only learn of the failure via the higher-level `failed`
        // event, which loses the per-step context.
        this.emit('final_answer', errorStep);
        return {
          step: errorStep,
          allSteps: iterationSteps,
          isComplete: true,
          reachedMaxIterations: false,
          checkpoint: this.toCheckpoint(),
        };
      }

      // Aborts are benign (see run() catch) - warn, don't error, to avoid LiveOps
      // alert noise. Real failures still log at error and propagate.
      if (isAbortError(error, options.signal)) {
        // Keep the error for stack/message context - only the severity is downgraded.
        this.context.logger.warn('[ReActAgent] Iteration aborted (user cancel or timeout):', error);
      } else {
        this.context.logger.error('[ReActAgent] Error during runIteration:', error);
      }
      this.emit('error', error as Error);
      throw error;
    }
  }

  /**
   * Reset the iteration state so the next `runIteration()` call starts fresh.
   * Call this when starting a new query (not when resuming from checkpoint).
   * The next `runIteration()` call will re-initialize all state from scratch.
   */
  resetIteration(): void {
    this.iterationInitialized = false;
  }

  /**
   * Build an action step, increment tool call count, push to steps, and emit.
   * Returns the step for callers that need to collect iteration steps.
   */
  private buildActionStep(toolUse: ToolUseInfo): AgentStep {
    this.toolCallCount++;
    const actionStep: AgentStep = {
      type: 'action',
      content: `Using tool: ${toolUse.name}`,
      metadata: {
        toolName: toolUse.name,
        toolInput: toolUse.arguments,
        timestamp: Date.now(),
        iteration: this.iterations - 1,
      },
    };
    this.steps.push(actionStep);
    this.emit('action', actionStep);
    return actionStep;
  }

  /**
   * Create and emit an action step for a tool use (delegates to buildActionStep)
   */
  private emitActionStep(toolUse: ToolUseInfo): void {
    this.buildActionStep(toolUse);
  }

  /**
   * Build an observation step, score confidence, push to steps, and emit.
   * Returns the step for callers that need to collect iteration steps.
   */
  private buildObservationStep(toolName: string, observation: string): AgentStep {
    const confidence = this.scoreToolResult(toolName, observation);
    const confidenceSource: 'deterministic' | 'default' = observation.startsWith('Error:')
      ? 'deterministic'
      : 'default';

    this.confidenceLog.push({ toolName, confidence, source: confidenceSource, timestamp: Date.now() });
    this.iterationConfidences.push(confidence);

    const observationStep: AgentStep = {
      type: 'observation',
      content: observation,
      metadata: {
        toolName,
        timestamp: Date.now(),
        iteration: this.iterations - 1,
        confidence,
        confidenceSource,
      },
    };
    this.steps.push(observationStep);
    this.emit('observation', observationStep);
    return observationStep;
  }

  /**
   * Create and emit an observation step, scoring confidence for the result
   */
  private emitObservationStep(toolName: string, observation: string): void {
    this.buildObservationStep(toolName, observation);
  }

  /**
   * Score the confidence of a tool result.
   * Deterministic scoring for errors; default stub (0.7) for everything else.
   * This is the extension point for tool-level score functions.
   */
  private scoreToolResult(toolName: string, result: string): number {
    // Deterministic: errors get low confidence
    if (result.startsWith('Error:')) {
      return 0.1;
    }
    // Deterministic: empty results are suspicious
    if (!result || result.trim().length === 0) {
      return 0.3;
    }
    // Stub phase: all non-error tool results get a fixed 0.7 confidence score.
    // Intentional - real confidence signals (tool-specific validators, LLM
    // self-reported certainty, output schema conformance) will replace this
    // when the confidence calibration system is built. The 0.7 baseline keeps
    // the confidence gate functional without triggering false pauses.
    return 0.7;
  }

  /**
   * Parse tool arguments, handling both string and object forms.
   *
   * Recovers from common malformed-JSON patterns models emit before failing:
   * - Trailing commas before `]` or `}` (frequent across providers)
   * - Markdown code fences wrapping the JSON (`` ```json ... ``` ``)
   *
   * If recovery succeeds, logs at debug level so provider-specific patterns
   * can be tracked. If recovery fails, re-throws the original parse error
   * so the failure mode stays visible.
   */
  private parseToolArguments(args: string | unknown): unknown {
    if (typeof args !== 'string') return args;
    return parseToolArgsLenient(args, this.context.logger);
  }

  /**
   * Run a categorized tool batch, tolerating a mid-batch abort.
   *
   * executeToolsInParallel throws a ToolExecutionAbortedError when the signal
   * fires between or within phases; that error carries the results gathered so
   * far. We unwrap it and return the partial map instead of propagating, so the
   * caller's message-pairing loop still runs for EVERY advertised tool_use
   * (completed tools keep their real result; the rest are backfilled as
   * cancelled). Non-abort errors propagate unchanged so real failures still surface.
   */
  private async runToolBatchAbortTolerant(
    plan: ToolExecutionPlan,
    signal?: AbortSignal
  ): Promise<Map<string, ToolResult>> {
    try {
      return await executeToolsInParallel(plan, toolUse => this.executeToolWithQueueFallback(toolUse), signal);
    } catch (error) {
      if (error instanceof ToolExecutionAbortedError) return error.partialResults;
      throw error;
    }
  }

  /**
   * Execute a tool and return the result as a string.
   * Checks observation queue first for backward compatibility.
   */
  private async executeToolWithQueueFallback(toolUse: ToolUseInfo): Promise<string> {
    // Check for queued observation first (backward compatibility)
    const queuedObs = this.observationQueue.find(obs => obs.toolId === getToolId(toolUse));
    if (queuedObs) {
      const result = queuedObs.result;
      const index = this.observationQueue.indexOf(queuedObs);
      this.observationQueue.splice(index, 1);
      return typeof result === 'string' ? result : JSON.stringify(result);
    }

    // Execute tool locally
    const tool = this.context.tools.find(t => t.toolSchema.name === toolUse.name);
    if (!tool) {
      // Deferred-tool fallback: ask the host to resolve the unknown name.
      // If the host returns a tool, register it (so subsequent calls find
      // it directly) and return a hint observation rather than executing -
      // the model's call here was made without seeing the schema, so its
      // arguments are likely guesses. Retrying on the next iteration with
      // the schema in front of the model produces correct args.
      if (this.context.unknownToolResolver) {
        const resolved = await this.context.unknownToolResolver(toolUse.name);
        if (resolved) {
          this.context.tools.push(resolved);
          return `Tool '${toolUse.name}' was deferred and its schema is now loaded. The previous call was made without the schema visible — please re-issue the call with valid parameters per the schema below.\n\n<function>${JSON.stringify(
            {
              description: resolved.toolSchema.description,
              name: resolved.toolSchema.name,
              parameters: resolved.toolSchema.parameters,
            }
          )}</function>`;
        }
      }
      // A tool the model insists on calling is genuinely not in this context (e.g. never
      // registered for this sub-agent, or stripped after a tool-call cap). A bare
      // "Error: Tool X not found" gives the model no exit - under an eager "you MUST call X"
      // prompt it re-emits the same call every iteration and grinds to maxIterations.
      // Keep the "Error:" prefix so scoreToolResult/confidenceSource still treat this as a
      // low-confidence error (they key off `startsWith('Error:')`), but add an explicit
      // instruction to stop retrying and PROCEED - without forcing the whole turn to end, in
      // case the missing tool was peripheral and the plan has other valid steps left.
      return (
        `Error: Tool "${toolUse.name}" is not available in this context and cannot be called. ` +
        `Do NOT attempt to call it again. Proceed without it — call other available tools if your ` +
        `plan still needs them, or compose your final answer from the information already gathered ` +
        `if no more tools are needed.`
      );
    }
    try {
      const params = this.parseToolArguments(toolUse.arguments);
      const result = await tool.toolFn(params);
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error: ${message}`;
    }
  }

  /**
   * Build and append tool call/result messages for the conversation history.
   * Delegates to the backend's pushToolMessages so each provider formats
   * messages according to its own API requirements.
   */
  private appendToolMessages(
    messages: Array<{ role: string; content: unknown }>,
    toolUse: ToolUseInfo,
    observation: string,
    thinkingBlocks: unknown[]
  ): void {
    const params = this.parseToolArguments(toolUse.arguments);
    const toolId = toolUse.id || `${toolUse.name}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const parameters = typeof toolUse.arguments === 'string' ? toolUse.arguments : JSON.stringify(params);

    this.context.llm.pushToolMessages(
      messages as Parameters<typeof this.context.llm.pushToolMessages>[0],
      { id: toolId, name: toolUse.name, parameters },
      observation,
      thinkingBlocks
    );
  }
}

// Type-safe event emitter
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface ReActAgent {
  on<K extends keyof AgentEvents>(event: K, listener: AgentEvents[K]): this;
  emit<K extends keyof AgentEvents>(event: K, ...args: Parameters<AgentEvents[K]>): boolean;
}

// ---------------------------------------------------------------------------
// Lenient tool argument parsing
// ---------------------------------------------------------------------------

/**
 * Parse JSON tool arguments with recovery for common LLM mistakes.
 *
 * Strategy: try standard parse first (the happy path, no allocation). On
 * failure, attempt targeted fixes one at a time and retry. Each recovery
 * step is conservative - it only handles patterns that have a low risk of
 * silently corrupting valid input.
 *
 * Exported for direct use and unit testing.
 */
export function parseToolArgsLenient(
  args: string,
  logger?: { debug?: (msg: string, ...rest: unknown[]) => void }
): unknown {
  // Happy path
  try {
    return JSON.parse(args);
  } catch (originalError) {
    const recoveries: Array<{ name: string; transform: (s: string) => string }> = [
      { name: 'strip-code-fence', transform: stripCodeFence },
      { name: 'strip-trailing-commas', transform: stripTrailingCommas },
      { name: 'strip-code-fence+strip-trailing-commas', transform: s => stripTrailingCommas(stripCodeFence(s)) },
    ];

    for (const { name, transform } of recoveries) {
      const candidate = transform(args);
      if (candidate === args) continue;
      try {
        const result = JSON.parse(candidate);
        logger?.debug?.(`[ReActAgent] Recovered malformed tool args via ${name}`);
        return result;
      } catch {
        // try next recovery
      }
    }

    throw originalError;
  }
}

/**
 * Remove a wrapping markdown code fence, e.g. `` ```json\n{...}\n``` ``.
 * Preserves input if no recognizable fence is found.
 */
function stripCodeFence(input: string): string {
  const trimmed = input.trim();
  const fenceMatch = trimmed.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```$/);
  return fenceMatch ? fenceMatch[1].trim() : input;
}

/**
 * Strip commas that immediately precede `}` or `]` (with optional whitespace).
 * Conservative: doesn't touch commas inside strings because the regex only
 * matches commas followed by whitespace and a closing bracket.
 *
 * Preserves input if no trailing-comma pattern is found.
 */
function stripTrailingCommas(input: string): string {
  const result = input.replace(/,(\s*[}\]])/g, '$1');
  return result;
}

// ---------------------------------------------------------------------------
// History Trimming
// ---------------------------------------------------------------------------

/**
 * Trim the steps array to keep only the last N iterations worth of steps.
 *
 * Each iteration produces 1-5 steps (thought, action(s), observation(s), final_answer).
 * With parallel tool calls an iteration can produce more: 1 thought + N actions + N observations.
 * For 3 parallel tools = 7 steps, so we use 7 as the estimate.
 * The failure mode is benign: over-trim loses old steps (harmless), under-trim keeps
 * a few extra (also harmless - bounded by the next trim call).
 */
function trimSteps(steps: AgentStep[], maxIterations: number): void {
  const estimatedStepsPerIteration = 7;
  const maxSteps = maxIterations * estimatedStepsPerIteration;

  if (steps.length > maxSteps) {
    const removeCount = steps.length - maxSteps;
    steps.splice(0, removeCount);
  }
}

/**
 * Trim conversation history to keep the protected prefix (system + previousMessages
 * + current user query) plus the last N iterations of assistant/tool/user messages.
 *
 * Each ReAct iteration adds ~3-5 messages (assistant with tool calls, tool results,
 * user nudge). Keeping all iterations causes input tokens to grow quadratically.
 * Trimming to the last N iterations keeps the agent grounded in recent context
 * while dramatically reducing token accumulation.
 *
 * @param protectedPrefixCount - Length of the initial messages array before any
 *   ReAct iteration messages were appended. Required when previousMessages is
 *   used, otherwise prior-turn user messages get mistaken for iteration nudges
 *   and trimmed away (including, eventually, the current user query itself).
 */
function trimConversationHistory(messages: IMessage[], maxIterations: number, protectedPrefixCount: number): void {
  const dynamicStart = protectedPrefixCount;
  const dynamicMessages = messages.slice(dynamicStart);
  if (dynamicMessages.length === 0) return;

  // Count iterations by counting user nudge messages ("Based on the tool results above...")
  // Each iteration ends with a user nudge (except possibly the last)
  const nudgeIndices: number[] = [];
  for (let i = 0; i < dynamicMessages.length; i++) {
    if (dynamicMessages[i].role === 'user' && typeof dynamicMessages[i].content === 'string') {
      nudgeIndices.push(i);
    }
  }

  // If we have more iterations than the max, trim older ones
  if (nudgeIndices.length <= maxIterations) return;

  // Keep messages from the Nth-from-last nudge onward
  const cutoffNudgeIndex = nudgeIndices[nudgeIndices.length - maxIterations];
  const keepFrom = dynamicStart + cutoffNudgeIndex;

  // Replace: keep initial messages + recent iterations
  messages.splice(dynamicStart, keepFrom - dynamicStart);
}
