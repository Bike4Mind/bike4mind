import { Logger } from '@bike4mind/observability';
import { ChatModels, IMessage, ModelBackend, PermissionDeniedError, type ModelInfo } from '@bike4mind/common';
import { executeToolsBatch } from '../executeToolsBatch';
import {
  ChoiceEndReason,
  type CompletionInfo,
  DEFAULT_MAX_TOOL_CALLS,
  IChoiceEndToolUse,
  ICompletionBackend,
  ICompletionOptions,
  ICompletionResponseChunk,
} from '../backend';
import { getCachingAdapter } from '../caching/adapters';
import { handleToolResultStreaming } from '../toolStreamingHelper';
import { injectJsonSchemaInstruction, isBestEffortJsonSchema } from '../responseFormatHelpers';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';

interface BedrockOptions {
  region: string;
  stream: boolean;
}

// Harden Bedrock retries for transient 503 (ServiceUnavailableException) and
// throttling. The AWS SDK default is maxAttempts:3 with sub-second standard backoff -
// too shallow for brief Bedrock capacity blips.
//
// NOTE the unit difference: AWS `maxAttempts` is TOTAL attempts (initial call + retries),
// whereas the Anthropic SDK's `maxRetries` counts retries only. So maxAttempts:6 = 5
// retries, matching the Anthropic client's `maxRetries:5` in actual retry count.
// Adaptive mode adds AWS's token-bucket backoff + client-side rate limiting
// (recommended for throttle/503-prone workloads). This absorbs brief blips; sustained
// outages still need provider/model fallback (tracked separately).
const BEDROCK_RETRY_CONFIG = { maxAttempts: 6, retryMode: 'adaptive' as const };

/**
 * Detect cancellation errors so they propagate past tool-error containment to
 * the outer catch (which has dedicated abort handling). Without this, aborts
 * would be converted into tool_result strings and the model would keep
 * responding to a cancelled request.
 *
 * Prefer structured fields (`name`, `code`) - the canonical signals from
 * AbortController/DOMException and Node. The message-substring fallback
 * preserves compatibility with upstream callers that wrap aborts and lose
 * `name`/`code` (mirrors `retry.ts` and `anthropicBackend.ts`). Tool errors
 * whose message happens to contain "aborted" will be misclassified by the
 * fallback - accepted risk, same as those sibling backends.
 */
function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return true;
  const code = (err as { code?: string }).code;
  if (code === 'ABORT_ERR' || code === 'ERR_ABORTED') return true;
  return err.message.includes('aborted');
}

export abstract class BaseBedrockBackend implements ICompletionBackend {
  private _options: BedrockOptions;
  private _bedrockRuntime: BedrockRuntimeClient;
  private _usEast1Models: string[] = [];
  public currentModel: string = '';

  constructor(options?: Partial<BedrockOptions>) {
    this._usEast1Models = [
      ChatModels.CLAUDE_3_5_SONNET_BEDROCK,
      ChatModels.CLAUDE_3_HAIKU_BEDROCK,
      ChatModels.LLAMA3_INSTRUCT_8B_V1,
      ChatModels.LLAMA3_INSTRUCT_70B_V1,
      ChatModels.TITAN_TEXT_G1_EXPRESS,
      ChatModels.TITAN_TEXT_G1_LITE,
    ];

    this._options = {
      region: 'us-east-2', // Default region, will be updated per model
      stream: true,
      ...options,
    };
    this._bedrockRuntime = new BedrockRuntimeClient({
      region: this._options.region,
      ...BEDROCK_RETRY_CONFIG,
    });
  }

  protected getRegionForModel(model: string): string {
    return this._usEast1Models.includes(model) ? 'us-east-1' : 'us-east-2';
  }

  protected updateClientForModel(model: string): void {
    const requiredRegion = this.getRegionForModel(model);
    this._options.region = requiredRegion;
    // Always create a fresh client to avoid stale credentials in warm Lambdas
    this._bedrockRuntime = new BedrockRuntimeClient({
      region: this._options.region,
      ...BEDROCK_RETRY_CONFIG,
    });
  }

  async complete(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>,
    callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>,
    toolsUsed: Array<{ name: string; arguments?: string; id?: string }> = []
  ): Promise<void> {
    this.currentModel = model;
    // Update client region if needed for this specific model
    this.updateClientForModel(model);

    // Tool chaining safeguard: Track and limit recursive tool calls
    const toolCallCount = options._internal?.toolCallCount ?? 0;
    const maxToolCalls = options._internal?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;

    // Multi-turn token accumulators. Each Bedrock InvokeModel call (every
    // recursive tool round-trip) is billed independently, so we add each
    // turn's usage and emit the running total. cliCompletions' assign-not-add
    // wrappedOnChunk means the last cb's tokens win - emitting accum+thisTurn
    // keeps the running total across recursive turns.
    const accumInputTokens = options._internal?.accumInputTokens ?? 0;
    const accumOutputTokens = options._internal?.accumOutputTokens ?? 0;

    // Check if we've exceeded the tool call limit (only when there are tools to execute)
    if (toolCallCount >= maxToolCalls && options.tools?.length) {
      Logger.globalInstance.warn(
        `⚠️ Max tool calls limit (${maxToolCalls}) reached. Disabling tools to prevent infinite loops.`
      );
      // Remove tools when limit is hit and continue, preserving _internal settings
      await this.complete(
        model,
        messages,
        {
          ...options,
          tools: undefined,
          // Defensive parity with the OpenAI/Anthropic backends: reset tool_choice on
          // recursion. Bedrock doesn't send request-side tool_choice, so this is a no-op
          // today, but it keeps the recursion invariant uniform across backends.
          tool_choice: 'auto',
          _internal: options._internal,
        },
        callback,
        toolsUsed
      );
      return;
    }

    // Best-effort response_format support: Bedrock doesn't have a
    // native structured-output API, so we inject the schema as a system-level
    // instruction and surface `responseFormatMode: 'best-effort'` so callers
    // know to post-validate.
    const messagesWithFormat = injectJsonSchemaInstruction(messages, options.responseFormat);
    const bestEffortFormat = isBestEffortJsonSchema(options.responseFormat);

    let formattedMessages = this.formatMessages(messagesWithFormat);
    let input = this.getPayload(model, formattedMessages, options);

    // Pre-flight context window check - avoids a Bedrock round-trip for payloads
    // that will certainly overflow. Uses 4 chars/token (standard rule of thumb;
    // JSON framing inflates char count slightly, making this a conservative over-estimate).
    // Note: 4 chars/token is accurate for English/Latin text. CJK, emoji, and math
    // symbols tokenize at ~1 token/char, so non-Latin payloads can under-estimate -
    // the reactive ValidationException catches below remain the safety net for those cases.
    const contextWindow = this.getModelContextWindow(model);
    if (contextWindow > 0) {
      const baseOutputTokens = typeof options.maxTokens === 'number' ? options.maxTokens : 4096;
      // Extended thinking reserves additional tokens on top of max_tokens in the actual payload.
      const thinkingBudget = options.thinking?.budget_tokens ?? 0;
      const reservedOutputTokens = baseOutputTokens + thinkingBudget;
      const maxInputTokens = contextWindow - reservedOutputTokens;
      let estimatedInputTokens = Math.ceil(input.body.length / 4);

      if (estimatedInputTokens > maxInputTokens) {
        // Graceful degradation: rather than failing the completion outright,
        // drop the oldest non-system messages and retry. This is the last-resort
        // safety net that protects EVERY Bedrock caller - including paths that bypass
        // the ChatCompletionProcess token budgeting (voice proxy, agent/sub-agent
        // calls, summarization, utility "base model" calls). The user keeps a working
        // (if context-trimmed) conversation instead of an unrecoverable error.
        Logger.globalInstance.warn(
          `[ContextOverflow] Pre-flight check failed for ${model}: ~${estimatedInputTokens} estimated input tokens > ${maxInputTokens} available (${contextWindow} context − ${reservedOutputTokens} reserved output). Pruning oldest messages.`
        );

        let prunedMessages = messagesWithFormat;
        const MAX_PRUNE_ITERATIONS = 100;
        let iterations = 0;

        while (estimatedInputTokens > maxInputTokens && iterations < MAX_PRUNE_ITERATIONS) {
          iterations++;
          // Drop a chunk sized to the byte overage so we converge quickly on long
          // conversations instead of trimming one message at a time (O(n²) payloads).
          const conversationCount = prunedMessages.filter(m => m.role !== 'system').length;
          const dropCount = Math.max(2, Math.ceil(conversationCount * (1 - maxInputTokens / estimatedInputTokens)));

          const next = this.pruneOldestConversationMessages(prunedMessages, dropCount);
          if (next.length === prunedMessages.length) {
            // Only system messages + the final user turn remain - can't prune further.
            break;
          }
          prunedMessages = next;
          formattedMessages = this.formatMessages(prunedMessages);
          input = this.getPayload(model, formattedMessages, options);
          estimatedInputTokens = Math.ceil(input.body.length / 4);
        }

        if (estimatedInputTokens > maxInputTokens) {
          Logger.globalInstance.error(
            `[ContextOverflow] Unable to prune ${model} payload below the context window after ${iterations} iteration(s): ~${estimatedInputTokens} estimated input tokens still > ${maxInputTokens} available.`
          );
          throw new Error(
            `Context overflow: the conversation is too long for the current model ${model}: ~${estimatedInputTokens} estimated input tokens + ${reservedOutputTokens} reserved output tokens > ${contextWindow} context window. Please start a new quest or shorten the conversation.`
          );
        }

        Logger.globalInstance.warn(
          `[ContextOverflow] Pruned ${model} conversation to fit after ${iterations} iteration(s): ~${estimatedInputTokens} estimated input tokens ≤ ${maxInputTokens} available.`
        );
      }
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;

    const buildCompletionInfo = (): CompletionInfo => {
      // Emit accum + this turn's running tokens. wrappedOnChunk's assign-not-add
      // means the last cb's tokens win; emitting accum+thisTurn at every site
      // keeps the running cross-turn total correct across recursive turns.
      const info: CompletionInfo = {
        inputTokens: accumInputTokens + inputTokens,
        outputTokens: accumOutputTokens + outputTokens,
        toolsUsed,
        // Cache counts here come from Anthropic-native fields (input_tokens EXCLUDES
        // cache), so forwarding them is billing-safe. A Bedrock model reporting cache
        // with cache-INCLUSIVE input must not forward without subtracting (see the
        // warnings in openaiBackend/geminiBackend). This is one of the two adapters
        // covered by the disjoint-fields assumption in ChatCompletionProcess.ts.
        ...(cacheReadTokens > 0 ? { cacheReadInputTokens: cacheReadTokens } : {}),
        ...(cacheWriteTokens > 0 ? { cacheCreationInputTokens: cacheWriteTokens } : {}),
        ...(bestEffortFormat ? { responseFormatMode: 'best-effort' as const } : {}),
      };

      if (options.cacheStrategy?.enableCaching && (cacheReadTokens > 0 || cacheWriteTokens > 0)) {
        const adapter = getCachingAdapter(ModelBackend.Bedrock);
        const cacheStats = adapter.extractCacheStats(
          {
            usage: {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              cache_read_input_tokens: cacheReadTokens,
              cache_creation_input_tokens: cacheWriteTokens,
            },
          },
          model
        );
        if (cacheStats) {
          info.cacheStats = cacheStats;
        }
      }

      return info;
    };

    // Pre-API diagnostic logging - count tool blocks before sending
    const toolUseCount = formattedMessages.reduce((count, msg) => {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        return count + msg.content.filter((b: { type?: string }) => b.type === 'tool_use').length;
      }
      return count;
    }, 0);
    const toolResultCount = formattedMessages.reduce((count, msg) => {
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        return count + msg.content.filter((b: { type?: string }) => b.type === 'tool_result').length;
      }
      return count;
    }, 0);

    if (toolUseCount > 0 || toolResultCount > 0) {
      Logger.globalInstance.log(
        `[BaseBedrockBackend Pre-API #6181] Sending ${formattedMessages.length} messages with ${toolUseCount} tool_use and ${toolResultCount} tool_result blocks`
      );
      if (toolUseCount !== toolResultCount) {
        Logger.globalInstance.warn(
          `[BaseBedrockBackend Pre-API #6181] Tool block mismatch! tool_use: ${toolUseCount}, tool_result: ${toolResultCount}. This may cause API errors.`
        );
      }
    }

    try {
      Logger.globalInstance.log(
        `[BaseBedrockBackend] Invoking model: ${model} with stream=${options.stream} in region: ${this._options.region}`
      );

      if (options.stream) {
        const command = new InvokeModelWithResponseStreamCommand(input);
        let response;
        try {
          response = await this._bedrockRuntime.send(command, {
            abortSignal: options.abortSignal,
          });
        } catch (err: unknown) {
          this.handleBedrockError(err);
        }
        if (!response.body) throw new Error('No response body');

        const func: { name?: string; id?: string; parameters?: string }[] = [];
        // Did this stream actually produce anything? A "global." cross-region inference profile invoked
        // from a region that does not serve it comes back as an EMPTY stream - no chunks, no error - and
        // the old code returned silently, so the chat had nothing to render and hung until the client
        // timed out (~2 min). Track real output so we can fail LOUD instead. See the guard after the loop.
        let emittedTextChars = 0;

        for await (const streamEvent of response.body) {
          if (streamEvent.chunk?.bytes) {
            const json = new TextDecoder().decode(streamEvent.chunk.bytes);
            const { chunk } = this.translateStreamChunk(model, JSON.parse(json));

            chunk?.choices?.forEach(choice => {
              func[choice.index] ||= {};
              func[choice.index].name ||= choice.tool?.name;
              func[choice.index].id ||= choice.tool?.id;
              if (func[choice.index].name && choice.statusEndReason !== ChoiceEndReason.TOOL_USE) {
                func[choice.index].parameters ??= choice.chunkText || '';
                func[choice.index].parameters += choice.chunkText || '';
              }
              inputTokens = Math.max(inputTokens, choice.usage?.input_tokens || 0);
              outputTokens = Math.max(outputTokens, choice.usage?.output_tokens || 0);
              cacheReadTokens = Math.max(cacheReadTokens, choice.usage?.cache_read_input_tokens || 0);
              cacheWriteTokens = Math.max(cacheWriteTokens, choice.usage?.cache_creation_input_tokens || 0);
            });

            // Skip callback when there is a tool being streamed
            if (func.some(f => f.name)) {
              continue;
            }

            const streamedText: string[] = [];
            chunk?.choices.forEach(choice => {
              streamedText[choice.index] = choice.chunkText || '';
            });
            emittedTextChars += streamedText.reduce((n, t) => n + (t?.length ?? 0), 0);

            // Send streamed text from chunk text data
            await callback(streamedText, buildCompletionInfo());
          }
        }

        // FAIL LOUD on an empty completion. No text AND no tool call means the model produced nothing a
        // user or the pipeline can use - almost always a misrouted inference profile (a "global." model
        // served from a region that does not host it) or an unavailable model. Returning silently makes
        // the chat hang with no output and no error; throwing surfaces a clear, actionable message. Token
        // count is deliberately NOT part of the condition: an empty response can still report phantom
        // usage, and a real assistant turn ALWAYS has text or a tool call, so this cannot false-positive.
        if (emittedTextChars === 0 && !func.some(f => f.name)) {
          throw new Error(
            `[BaseBedrockBackend] model "${model}" returned an EMPTY response in region ${this._options.region} ` +
              `(no text, no tool call, no output tokens). A "global." cross-region inference profile served ` +
              `from a region that does not host it does exactly this - try the "us." variant, or confirm the ` +
              `model/profile is granted in ${this._options.region}.`
          );
        }

        // If there is a tool being used, then
        // callback the complete function with the tool messages included
        if (func.some(f => f.name)) {
          // Track all tool usage first (including ID for history reconstruction, allow empty parameters)
          for await (const tool of func) {
            const { id, name, parameters } = tool;
            if (name) {
              toolsUsed.push({ name, arguments: parameters || '{}', id });
            }
          }

          // Check if we should execute tools or just report them
          if (options.executeTools !== false) {
            // Resolve all executable tools from the func array
            type ResolvedTool = {
              id: string;
              name: string;
              parameters: string;
              parsedParams: Record<string, unknown>;
              toolFn: (params: Record<string, unknown>) => Promise<{ toString(): string }>;
            };
            const resolvedTools: ResolvedTool[] = [];
            for (const tool of func) {
              const { id, name } = tool;
              if (!id || !name) continue;
              const parameters = tool.parameters || '{}';
              const toolFn = options.tools?.find(t => t.toolSchema.name === name)?.toolFn;
              if (!toolFn) continue;
              try {
                resolvedTools.push({ id, name, parameters, parsedParams: JSON.parse(parameters), toolFn });
              } catch {
                Logger.globalInstance.warn('[BaseBedrockBackend] Tool parameter parse error, skipping tool:', name);
              }
            }

            // Execute tools - parallel by default, sequential when opted out
            const parallelEnabled = options.parallelToolExecution !== false;

            type ToolPayload = { id: string; name: string; parameters: string; result: { toString(): string } };

            Logger.globalInstance.debug('[BaseBedrockBackend] Executing tools:', {
              mode: parallelEnabled && resolvedTools.length > 1 ? 'parallel' : 'sequential',
              tools: resolvedTools.map(t => t.name),
            });

            const batchOutcomes = await executeToolsBatch<ToolPayload>(
              resolvedTools.map(({ id, name, parameters, parsedParams, toolFn }) => async () => {
                const result = await toolFn(parsedParams);
                return { id, name, parameters, result };
              }),
              { parallel: parallelEnabled, maxConcurrency: options.maxParallelTools }
            );

            type ToolOutcome =
              | { ok: true; id: string; name: string; parameters: string; result: { toString(): string } }
              | { ok: false; id: string; name: string; parameters: string; error: unknown };

            const outcomes: ToolOutcome[] = batchOutcomes.map((outcome, i) =>
              outcome.ok
                ? { ok: true as const, ...outcome.result }
                : {
                    ok: false as const,
                    id: resolvedTools[i].id,
                    name: resolvedTools[i].name,
                    parameters: resolvedTools[i].parameters,
                    error: outcome.error,
                  }
            );

            // Inject results in original order
            for (const outcome of outcomes) {
              if (outcome.ok) {
                // For tools that return artifacts (like recharts), stream the result directly
                await handleToolResultStreaming(outcome.name, outcome.result, async results => {
                  await callback(results, buildCompletionInfo());
                });

                this.pushToolMessages(
                  messages,
                  { id: outcome.id, name: outcome.name, parameters: outcome.parameters },
                  outcome.result.toString()
                );
              } else {
                if (outcome.error instanceof PermissionDeniedError) throw outcome.error;
                if (isAbortError(outcome.error)) throw outcome.error;
                Logger.globalInstance.error(
                  `[BaseBedrockBackend] Tool ${outcome.name} failed:`,
                  outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
                );
                // Push error result so the model can continue
                this.pushToolMessages(
                  messages,
                  { id: outcome.id, name: outcome.name, parameters: outcome.parameters },
                  `Error processing ${outcome.name} tool: ${outcome.error instanceof Error ? outcome.error.message : 'Unknown error'}`
                );
              }
            }

            // Add newline separator before recursive call to ensure proper markdown rendering
            await callback(['\n\n'], buildCompletionInfo());

            // Carry this turn's tokens forward so the terminal recursive call
            // emits the full multi-turn billable total to cb.
            await this.complete(
              model,
              messages,
              {
                ...options,
                thinking: { enabled: false, budget_tokens: 0 },
                // Defensive parity with OpenAI/Anthropic; Bedrock doesn't send request-side
                // tool_choice, so this is a no-op today but keeps the recursion uniform.
                tool_choice: 'auto',
                _internal: {
                  ...options._internal,
                  toolCallCount: toolCallCount + 1,
                  accumInputTokens: accumInputTokens + inputTokens,
                  accumOutputTokens: accumOutputTokens + outputTokens,
                },
              },
              callback,
              toolsUsed
            );
          } else {
            // New behavior: just pass tool calls through callback, don't execute
            Logger.globalInstance.log('[BaseBedrockBackend] executeTools=false, passing tool calls to callback');
            await callback([null], buildCompletionInfo());
          }
          return; // Exit after handling tools
        }
      } else {
        const command = new InvokeModelCommand(input);
        let response;
        try {
          response = await this._bedrockRuntime.send(command, {
            abortSignal: options.abortSignal,
          });
        } catch (err: unknown) {
          this.handleBedrockError(err);
        }
        if (!response.body) throw new Error('No response body');
        const json = new TextDecoder().decode(response.body);
        const { chunk } = this.translateChunk(model, JSON.parse(json));
        const streamedText: string[] = [];
        chunk?.choices.forEach(choice => {
          streamedText[choice.index] = choice.chunkText || '';
        });

        inputTokens = chunk?.choices[0].usage?.input_tokens || 0;
        outputTokens = chunk?.choices[0].usage?.output_tokens || 0;
        cacheReadTokens = chunk?.choices[0].usage?.cache_read_input_tokens || 0;
        cacheWriteTokens = chunk?.choices[0].usage?.cache_creation_input_tokens || 0;

        // Check if there's a tool use in the response
        const toolChoice = chunk?.choices.find(choice => choice.statusEndReason === ChoiceEndReason.TOOL_USE) as
          IChoiceEndToolUse | undefined;

        if (toolChoice?.tool) {
          const { id, name, parameters } = toolChoice.tool;

          // Track tool usage (including ID for history reconstruction, allow empty parameters)
          if (name) {
            toolsUsed.push({ name, arguments: parameters || '{}', id });
          }

          // Check if we should execute tools or just report them
          if (options.executeTools !== false) {
            // Default behavior: execute tools and recurse
            const toolFn = options.tools?.find(tool => tool.toolSchema.name === name)?.toolFn;
            // Allow empty parameters (some tools don't require input)
            const safeParameters = parameters || '{}';

            if (id && name && toolFn) {
              let result: { toString(): string };
              try {
                result = await toolFn(JSON.parse(safeParameters));
              } catch (err) {
                if (err instanceof PermissionDeniedError) throw err;
                if (isAbortError(err)) throw err;
                Logger.globalInstance.error(
                  `[BaseBedrockBackend] Tool ${name} failed:`,
                  err instanceof Error ? err.message : String(err)
                );
                result = `Error processing ${name} tool: ${err instanceof Error ? err.message : 'Unknown error'}`;
              }

              // For tools that return artifacts (like recharts), stream the result directly
              await handleToolResultStreaming(name, result, async results => {
                await callback(results, buildCompletionInfo());
              });

              this.pushToolMessages(messages, { id, name, parameters }, result.toString());

              // Add newline separator before recursive call to ensure proper markdown rendering
              await callback(['\n\n'], buildCompletionInfo());

              // Recursively call complete to continue the conversation.
              // Carry this turn's tokens forward so the terminal recursive call
              // emits the full multi-turn billable total to cb.
              await this.complete(
                model,
                messages,
                {
                  ...options,
                  thinking: { enabled: false, budget_tokens: 0 },
                  // Defensive parity with OpenAI/Anthropic; Bedrock doesn't send request-side
                  // tool_choice, so this is a no-op today but keeps the recursion uniform.
                  tool_choice: 'auto',
                  _internal: {
                    ...options._internal,
                    toolCallCount: toolCallCount + 1,
                    accumInputTokens: accumInputTokens + inputTokens,
                    accumOutputTokens: accumOutputTokens + outputTokens,
                  },
                },
                callback,
                toolsUsed
              );
              return; // Exit after recursive call
            }
          } else {
            // New behavior: just pass tool calls through callback, don't execute
            Logger.globalInstance.log('[BaseBedrockBackend] executeTools=false, passing tool calls to callback');
            await callback([null], buildCompletionInfo());
            return; // Exit after passing tools
          }
        }

        await callback(streamedText, buildCompletionInfo());
      }
    } catch (error) {
      // Log detailed error information
      if (error instanceof Error) {
        if (error.message.includes('aborted')) {
          Logger.globalInstance.log('[BaseBedrockBackend] Request aborted, skipping error logging');
          throw error;
        }
        Logger.globalInstance.error(`[BaseBedrockBackend] Error invoking model ${model}:`, error);
        Logger.globalInstance.error(`[BaseBedrockBackend] Error details:`, {
          name: error.name,
          message: error.message,
          stack: error.stack,
          // Add more properties that might be available on the specific error type
          ...(error as any),
        });

        // Log the request payload for debugging
        Logger.globalInstance.error(`[BaseBedrockBackend] Request payload:`, {
          modelId: input.modelId,
          contentType: input.contentType,
          bodyPreview: input.body.substring(0, 500) + (input.body.length > 500 ? '...' : ''),
        });
      }

      throw error;
    }
  }

  /**
   * Format the messages to be sent to the Bedrock runtime.
   * Since different LLM handles has there own structure of messages.
   *
   * @param messages The messages to format
   */
  abstract formatMessages(message: IMessage[]): IMessage[];

  /**
   * Get the payload to send to the Bedrock runtime.
   *
   * @param model AI Model being used
   * @params messages The messages to send to the model
   */
  abstract getPayload(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>
  ): {
    modelId: string;
    contentType: string;
    accept: string;
    body: string;
  };

  /**
   * Translate a stream chunk from the Bedrock runtime to a completion response chunk.
   * which will be used as a callback from the completion function.
   *
   * @param model AI Model being used.
   * @param chunk The stream chunk
   */
  abstract translateStreamChunk(model: string, chunk: unknown): { done: boolean; chunk?: ICompletionResponseChunk };

  /**
   * [NON-STREAM]
   * Translate a chunk from the Bedrock runtime to a completion response chunk.
   * which will be used as a callback from the completion function.
   * This is used when the stream option is set to false.
   *
   * @param model The model ID.
   * @param chunk The response
   */
  abstract translateChunk(model: string, chunk: unknown): { done: boolean; chunk?: ICompletionResponseChunk };

  /**
   * Push the tool messages to the messages array.
   * This is used to push the tool messages to the messages array.
   */
  abstract pushToolMessages(
    messages: IMessage[],
    tool: IChoiceEndToolUse['tool'],
    result: string,
    thinkingBlocks?: unknown[]
  ): unknown;

  /**
   * Get the models supported by this backend
   */
  abstract getModelInfo(): Promise<ModelInfo[]>;

  /**
   * Translates a Bedrock send error into a user-friendly context overflow error,
   * or re-throws the original. Always throws - return type is `never`.
   */
  private handleBedrockError(err: unknown): never {
    const errName = (err as { name?: string })?.name;
    const errMsg = (err as { message?: string })?.message ?? '';
    if (errName === 'ValidationException' && errMsg.includes('Input is too long')) {
      Logger.globalInstance.warn(
        '[ContextOverflow] Bedrock ValidationException: input too long — surfacing user-friendly error'
      );
      throw new Error(
        `Context overflow: the conversation is too long for the current model. Please start a new quest or shorten the conversation.`,
        { cause: err }
      );
    }
    // Log unmatched ValidationExceptions so any future Bedrock message rewording is
    // immediately visible in CloudWatch rather than silently falling through.
    if (errName === 'ValidationException') {
      Logger.globalInstance.warn(
        `[BedrockValidationException] Unrecognized ValidationException — update match string if this is a context overflow: ${errMsg}`
      );
    }
    throw err;
  }

  /**
   * Returns the context window size (in tokens) for the given model.
   * Returns 0 if unknown - pre-flight check is skipped in that case.
   * Subclasses override to enable proactive context overflow detection.
   */
  protected getModelContextWindow(_model: string): number {
    return 0;
  }

  /**
   * Prune the oldest non-system conversation messages to shrink an over-budget
   * payload. System messages (prompt/instructions) and the final message
   * (the current user turn, or the trailing tool_result during recursive tool
   * calls) are always preserved. After dropping the oldest `dropCount` conversation
   * messages, leading orphans are cascade-dropped so the kept window starts with a
   * clean `user` turn - Anthropic/Bedrock rejects a window that starts with an
   * assistant message or with an unmatched `tool_result`.
   */
  protected pruneOldestConversationMessages(messages: IMessage[], dropCount: number): IMessage[] {
    // Preserve all leading system messages - the prompt/instructions live at the top.
    let systemEnd = 0;
    while (systemEnd < messages.length && messages[systemEnd].role === 'system') {
      systemEnd++;
    }
    const systemMessages = messages.slice(0, systemEnd);
    const conversation = messages.slice(systemEnd);

    // Never drop the final message - the model must respond to it.
    const maxDroppable = conversation.length - 1;
    if (maxDroppable <= 0) {
      return messages;
    }

    let kept = conversation.slice(Math.min(dropCount, maxDroppable));

    // Cascade-drop leading orphans: an assistant message or an unmatched tool_result
    // at the head of the window is invalid. Dropping an assistant tool_use exposes
    // its following tool_result (now also a leading orphan), dropped on the next
    // pass - leaving a clean user turn. The length guard protects the final message.
    while (kept.length > 1 && (kept[0].role === 'assistant' || this.isToolResultMessage(kept[0]))) {
      kept = kept.slice(1);
    }

    return [...systemMessages, ...kept];
  }

  /** True when a user message carries a tool_result block (needs a preceding tool_use). */
  private isToolResultMessage(message: IMessage): boolean {
    return (
      message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some((block: { type?: string }) => block.type === 'tool_result')
    );
  }
}
