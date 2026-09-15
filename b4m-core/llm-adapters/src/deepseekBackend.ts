import {
  ChatModels,
  IMessage,
  ModelBackend,
  PermissionDeniedError,
  type CacheUsageStats,
  type ModelInfo,
} from '@bike4mind/common';
import { stripToolDependentMessages } from './toolPairingUtils';
import { cachedTokensFromUsage, splitCacheInclusiveInput } from './cacheInclusiveUsage';
import OpenAI from 'openai';
import { ChatCompletionChunk, ChatCompletionCreateParams } from 'openai/resources';
import { Stream } from 'openai/streaming';
import { Logger } from '@bike4mind/observability';
import { executeToolsBatch } from './executeToolsBatch';
import { recordToolResult, type RecordableToolUse } from './recordToolResult';
import {
  CompletionInfo,
  DEFAULT_MAX_TOOL_CALLS,
  IChoiceEndToolUse,
  ICompletionBackend,
  ICompletionOptionTools,
  ICompletionOptions,
  getLatestToolCallIdOpenAI,
  replaceLastToolResultObservationOpenAI,
} from './backend';
import { getCachingAdapter, logCacheStats } from './caching/adapters';
import { deepseekReasoningParams, deepseekSamplingParams, deepseekStopSequences } from './deepseekParams';
import { convertMessagesToOpenAIFormat } from './messageFormatConverter';
import { injectJsonSchemaInstruction, isBestEffortJsonSchema } from './responseFormatHelpers';
import { normalizeOpenAIFinishReason } from './stopReason';

/**
 * DeepSeek's models, served from their own OpenAI-compatible endpoint.
 *
 * Structurally this is kimiBackend's twin - same OpenAI SDK against a different
 * baseURL, same recursive tool loop, same multi-turn token accumulators - and the
 * three OpenAI-compatible backends must stay in sync on that machinery. What
 * genuinely differs here:
 *
 * 1. The base URL carries NO `/v1` segment; the SDK appends the path itself.
 * 2. Thinking is on by default and its sampling restrictions are SILENT no-ops
 *    rather than 400s; see deepseekParams.
 * 3. The prior turn's `reasoning_content` has to be replayed on the assistant
 *    tool-call message whenever the request carries `tools`, which is the
 *    opposite of the usual provider rule. See pushToolMessages.
 *
 * @see https://api-docs.deepseek.com/api/create-chat-completion
 */
export class DeepSeekBackend implements ICompletionBackend {
  private _baseUrl = 'https://api.deepseek.com';
  private _api: OpenAI;
  private logger: Logger;
  public currentModel: string = '';

  constructor(apiKey: string, logger?: Logger) {
    if (!apiKey) {
      throw new Error('DeepSeek API key is required');
    }
    this._api = new OpenAI({ apiKey, baseURL: this._baseUrl });
    this.logger = logger ?? new Logger();
  }

  /**
   * Seed listing. Post-registry this is the fallback tier, not the source of
   * truth: the catalog overlays context window, limits, lifecycle and price on
   * top of these rows. DeepSeek's own GET /models returns id/object/owned_by and
   * nothing else, so everything below has to live here.
   *
   * Prices are the PEAK rates. Off-peak (outside 01:00-04:00 and 06:00-10:00 UTC,
   * Mon-Fri) is exactly half, and ModelInfo.pricing is keyed by context tier with
   * no time dimension to express that in - so the rate that never under-bills is
   * the one recorded.
   */
  async getModelInfo(): Promise<ModelInfo[]> {
    return [
      {
        id: ChatModels.DEEPSEEK_FLASH,
        type: 'text' as const,
        name: 'DeepSeek Flash',
        backend: ModelBackend.DeepSeek,
        contextWindow: 1000000,
        max_tokens: 393216,
        can_stream: true,
        pricing: {
          // $0.30 / 1M in on a cache miss, $0.006 / 1M on a hit, $1.20 / 1M out.
          1000000: { input: 0.3 / 1000000, output: 1.2 / 1000000, cache_read: 0.006 / 1000000 },
        },
        can_think: true,
        supportsVision: true,
        supportsTools: true,
        supportsImageVariation: false,
        releaseDate: '2026-08-13',
        description:
          "DeepSeek's V4.1-Flash. 1M context with native vision, tool use, and selectable reasoning effort (low/high/max). Always reasons unless thinking is turned off.",
      },
    ];
  }

  async complete(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>,
    callback: (text: (string | null | undefined)[], completionInfo: CompletionInfo) => Promise<void>,
    toolsUsed: Array<RecordableToolUse> = []
  ): Promise<void> {
    this.currentModel = model;

    const toolCallCount = options._internal?.toolCallCount ?? 0;

    // Multi-turn token accumulators. Each DeepSeek call (every recursive tool
    // round-trip) is billed independently, so we add each turn's usage and emit
    // the running total - consumers assign rather than add, so the terminal turn
    // has to carry the whole session.
    const accumInputTokens = options._internal?.accumInputTokens ?? 0;
    const accumOutputTokens = options._internal?.accumOutputTokens ?? 0;
    const accumCacheReadTokens = options._internal?.accumCacheReadTokens ?? 0;

    const maxToolCalls = options._internal?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    if (toolCallCount >= maxToolCalls && options.tools?.length) {
      this.logger.warn(`Max tool calls limit (${maxToolCalls}) reached. Disabling tools to prevent infinite loops.`);
      await this.complete(
        model,
        // Tools are going away, so the prompts that order the model to use one have to go with them.
        stripToolDependentMessages(messages),
        { ...options, tools: undefined, _internal: options._internal },
        callback,
        toolsUsed
      );
      return;
    }

    const rawTools = options.tools as unknown;
    const normalizedTools = Array.isArray(rawTools)
      ? (rawTools as ICompletionOptionTools[])
      : rawTools
        ? [rawTools as ICompletionOptionTools]
        : undefined;
    options.tools = normalizedTools;

    // `n` is absent from DeepSeek's schema, so a multi-choice request cannot be
    // served at all and streaming is not what makes it impossible. Ignored loudly
    // rather than degraded: turning streaming off as well would cost the caller
    // the live response and still return the one choice.
    if ((options.n ?? 1) > 1) {
      this.logger.warn(`DeepSeek has no 'n' parameter; ignoring the request for ${options.n} choices.`);
    }
    const useStreaming = Boolean(options.stream);

    const reasoning = { thinking: options.thinking, reasoningEffort: options.reasoningEffort };

    // DeepSeek's strict `json_schema` form is beta-path-only, so a schema request
    // is served the same way xaiBackend serves it: `json_object` plus the schema
    // as a system instruction, reported as 'best-effort' so callers post-validate.
    // Sending json_object alone would never show the model the contract, and
    // leaving responseFormatMode unset invents a third state - intentClassifier
    // gates its stricter retry on 'best-effort' and would give up on the first
    // shape violation instead.
    const messagesWithFormat = injectJsonSchemaInstruction(messages, options.responseFormat);
    const bestEffortFormat = isBestEffortJsonSchema(options.responseFormat);

    const parameters: ChatCompletionCreateParams = {
      model,
      messages: this.formatMessages(messagesWithFormat),
    };

    Object.assign(parameters, {
      ...deepseekSamplingParams(
        model,
        {
          temperature: options.temperature,
          topP: options.topP,
          presencePenalty: options.presencePenalty,
          frequencyPenalty: options.frequencyPenalty,
        },
        reasoning
      ),
      ...deepseekReasoningParams(model, reasoning),
      stop: deepseekStopSequences(options.stop),
      stream: useStreaming,
      max_tokens: options.maxTokens,
      // Without include_usage a streamed turn reports NO usage at all and settles
      // at zero; with it, `usage` is null on every chunk but the last.
      ...(useStreaming && { stream_options: { include_usage: true } }),
    });

    if (options.tools?.length) {
      parameters.tools = this.formatTools(options.tools);
      if (options.tool_choice !== undefined) {
        parameters.tool_choice = options.tool_choice as ChatCompletionCreateParams['tool_choice'];
      }
    }

    if (options.responseFormat?.type === 'json_schema') {
      // Cast: OpenAI's typed response_format is on a newer params shape than the
      // one TS resolves here, same as openaiBackend.
      (parameters as unknown as Record<string, unknown>).response_format = { type: 'json_object' };
    } else if (options.responseFormat?.type === 'text') {
      (parameters as unknown as Record<string, unknown>).response_format = { type: 'text' };
    }

    // NO GATE on reasoning capture, deliberately. Deriving this from "did we send a
    // reasoning parameter" drops reasoning on the common path: Flash reasons by
    // default and deepseekReasoningParams sends nothing when no explicit effort or
    // toggle was set, which is the default. Any reasoning_content DeepSeek returns
    // was billed as output tokens, so discarding it would charge the user for text
    // they never see.

    // DeepSeek's context caching is automatic with no parameter or header to set;
    // the adapter exists to read the cache counters back out.
    const cacheStrategy = options.cacheStrategy;

    const response = await this._api.chat.completions.create(parameters, { signal: options.abortSignal });
    let inputTokens = 0;
    let outputTokens = 0;

    if (!(response instanceof Stream)) {
      const streamedText: string[] = [];

      if (!response.choices || response.choices.length === 0) {
        throw new Error('No choices returned from the DeepSeek API');
      }

      const turnCacheReadTokens = cachedTokensFromUsage(
        response.usage as unknown as Record<string, unknown> | undefined
      );

      for (const c of response.choices) {
        if (!c.message) continue;

        // Read here but NOT returned early: a reasoning turn that also calls a
        // tool populates both, and handling reasoning first would hand back the
        // monologue as the whole answer and never run the tool. Both DeepSeek ids
        // reason by default, so that is the normal agentic turn, not an edge case.
        const reasoningContent = (c.message as { reasoning_content?: string }).reasoning_content;

        if (c.message.tool_calls && c.message.tool_calls.length > 0) {
          for (const toolCall of c.message.tool_calls) {
            if (toolCall.type !== 'function') continue;
            if (toolCall.function.arguments) {
              toolsUsed.push({
                name: toolCall.function.name,
                arguments: toolCall.function.arguments,
                id: toolCall.id,
              });
            }
          }

          if (options.executeTools !== false) {
            type ResolvedTool = {
              id: string;
              name: string;
              parameters: string;
              parsedParams: Record<string, unknown>;
              toolFn: (params: Record<string, unknown>) => Promise<{ toString(): string }>;
            };
            const resolvedTools: ResolvedTool[] = [];
            for (const toolCall of c.message.tool_calls) {
              if (toolCall.type !== 'function' || !toolCall.function.arguments) continue;
              const toolFn = options.tools?.find(t => t.toolSchema.name === toolCall.function.name)?.toolFn;
              if (!toolFn) continue;
              try {
                const parsedParams = JSON.parse(toolCall.function.arguments);
                resolvedTools.push({
                  id: toolCall.id,
                  name: toolCall.function.name,
                  parameters: toolCall.function.arguments,
                  parsedParams,
                  toolFn,
                });
              } catch {
                this.logger.warn(`JSON parse error for ${toolCall.function.name} arguments`);
                const entry = toolsUsed.find(t => t.name === toolCall.function.name && t.id === toolCall.id);
                if (entry) entry.arguments = '{}';
                recordToolResult(
                  toolsUsed,
                  { id: toolCall.id, name: toolCall.function.name },
                  'Error: Tool arguments were malformed and could not be parsed.',
                  false
                );
              }
            }

            const parallelEnabled = options.parallelToolExecution !== false;

            type ToolPayload = { id: string; name: string; parameters: string; result: { toString(): string } };

            this.logger.debug('[Tool Execution] Executing tools (DeepSeek non-streaming)', {
              mode: parallelEnabled && resolvedTools.length > 1 ? 'parallel' : 'sequential',
              toolNames: resolvedTools.map(t => t.name),
            });

            const batchOutcomes = await executeToolsBatch<ToolPayload>(
              resolvedTools.map(({ id, name, parameters: toolParams, parsedParams, toolFn }) => async () => {
                const result = await toolFn(parsedParams);
                return { id, name, parameters: toolParams, result };
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

            // Only the first replayed assistant message carries the monologue:
            // repeating it once per parallel tool call would feed DeepSeek the
            // same reasoning several times over.
            let turnReasoning = reasoningContent;
            for (const outcome of outcomes) {
              if (outcome.ok) {
                const resultStr = outcome.result.toString();
                recordToolResult(toolsUsed, { id: outcome.id, name: outcome.name }, resultStr, true);
                this.pushToolMessages(
                  messages,
                  { id: outcome.id, name: outcome.name, parameters: outcome.parameters },
                  resultStr,
                  turnReasoning ? [turnReasoning] : undefined
                );
              } else {
                if (outcome.error instanceof PermissionDeniedError) throw outcome.error;
                const errorMessage = outcome.error instanceof Error ? outcome.error.message : 'Unknown error';
                const observation = `Error processing ${outcome.name} tool: ${errorMessage}`;
                recordToolResult(toolsUsed, { id: outcome.id, name: outcome.name }, observation, false);
                this.pushToolMessages(
                  messages,
                  { id: outcome.id, name: outcome.name, parameters: outcome.parameters },
                  observation,
                  turnReasoning ? [turnReasoning] : undefined
                );
              }
              turnReasoning = undefined;
            }

            await this.complete(
              model,
              messages,
              {
                ...options,
                _internal: {
                  ...options._internal,
                  toolCallCount: toolCallCount + 1,
                  accumInputTokens: accumInputTokens + (response.usage?.prompt_tokens || 0),
                  accumOutputTokens: accumOutputTokens + (response.usage?.completion_tokens || 0),
                  accumCacheReadTokens: accumCacheReadTokens + turnCacheReadTokens,
                },
              },
              callback,
              toolsUsed
            );
            return;
          } else {
            this.logger.debug(`[Tool Execution] executeTools=false, passing tool calls to callback`);
            await callback([null], {
              ...splitCacheInclusiveInput(
                accumInputTokens + (response.usage?.prompt_tokens || 0),
                accumCacheReadTokens + turnCacheReadTokens
              ),
              outputTokens: accumOutputTokens + (response.usage?.completion_tokens || 0),
              toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
            });
            return;
          }
        } else {
          const content = c.message.content || '';
          streamedText[c.index] = reasoningContent ? `<think>${reasoningContent}</think>${content}` : content;
        }
      }

      // A turn that produced neither prose nor a tool call is a failure, not an
      // empty answer, and the most likely cause is a reasoning model that spent
      // its whole max_tokens budget thinking. Without this the user gets a silent
      // blank reply.
      if (streamedText.every(text => !text) && toolsUsed.length === 0) {
        const finish = response.choices[0]?.finish_reason;
        throw new Error(
          finish === 'length'
            ? `DeepSeek returned no content for ${model}: the output budget was exhausted before any answer was produced (finish_reason: length). Raise maxTokens or lower the reasoning effort.`
            : `DeepSeek returned no content for ${model} (finish_reason: ${finish ?? 'unknown'}).`
        );
      }

      let cacheStats: CacheUsageStats | undefined;
      if (cacheStrategy?.enableCaching && response.usage) {
        const adapter = getCachingAdapter(ModelBackend.DeepSeek);
        cacheStats = adapter.extractCacheStats(response as unknown as Record<string, unknown>, model);
        if (cacheStats) logCacheStats(this.logger, cacheStats, { streaming: false });
      }

      const finishReason = normalizeOpenAIFinishReason(response.choices[0]?.finish_reason);
      const totalCacheReadTokens = accumCacheReadTokens + turnCacheReadTokens;
      await callback(streamedText, {
        ...splitCacheInclusiveInput(accumInputTokens + (response.usage?.prompt_tokens || 0), totalCacheReadTokens),
        outputTokens: accumOutputTokens + (response.usage?.completion_tokens || 0),
        toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
        cacheStats,
        ...(bestEffortFormat ? { responseFormatMode: 'best-effort' as const } : {}),
        ...(finishReason ? { stopReason: finishReason } : {}),
      });
      return;
    }

    const func: { name?: string; id?: string; parameters?: string }[] = [];
    let isInThinkingBlock = false;
    let streamedReasoning = '';
    let cachedTokensFromStream = 0;
    let streamFinishReason: string | undefined;
    let sawAnyText = false;

    for await (const chunk of response) {
      const streamedText: string[] = [];
      if (chunk.usage) {
        inputTokens = Math.max(inputTokens, chunk.usage?.prompt_tokens || 0);
        outputTokens += chunk.usage?.completion_tokens || 0;
        const chunkCached = cachedTokensFromUsage(chunk.usage as unknown as Record<string, unknown>);
        if (chunkCached > 0) cachedTokensFromStream = chunkCached;
      }

      chunk?.choices.forEach((c: ChatCompletionChunk.Choice) => {
        if (c.finish_reason) {
          streamFinishReason = c.finish_reason;
        }

        const deltaReasoning = (c.delta as { reasoning_content?: string }).reasoning_content;

        // Ungated, for the same reason as the non-streaming path: reasoning
        // arrives by default and is billed either way.
        if (deltaReasoning) {
          streamedReasoning += deltaReasoning;
          if (!isInThinkingBlock) {
            isInThinkingBlock = true;
            streamedText[c.index] = '<think>' + deltaReasoning;
          } else {
            streamedText[c.index] = deltaReasoning;
          }
          // Falls through when the SAME delta also carries prose: DeepSeek can end
          // the monologue and start the answer in one chunk, and returning here
          // dropped that first prose token. Returning is still right without
          // prose, or the tool-call branch below would overwrite the monologue.
          if (!c.delta.content) return;
        }

        if (isInThinkingBlock && c.delta.content) {
          isInThinkingBlock = false;
          streamedText[c.index] = (streamedText[c.index] ?? '') + '</think>' + c.delta.content;
          return;
        }

        c.delta.tool_calls?.map((tool: ChatCompletionChunk.Choice.Delta.ToolCall) => {
          func[tool.index] ||= {};
          func[tool.index].name ||= tool.function?.name;
          func[tool.index].id ||= tool.id;
          func[tool.index].parameters ??= '';
          func[tool.index].parameters += tool.function?.arguments || '';
        });

        if (func.length > 0) return;

        streamedText[c.index] = c.delta.content || '';
      });

      if (streamedText.some(t => t)) sawAnyText = true;

      const normalizedFinishReason = normalizeOpenAIFinishReason(streamFinishReason);
      await callback(streamedText, {
        ...splitCacheInclusiveInput(accumInputTokens + inputTokens, accumCacheReadTokens + cachedTokensFromStream),
        outputTokens: accumOutputTokens + outputTokens,
        toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
        ...(normalizedFinishReason ? { stopReason: normalizedFinishReason } : {}),
      });
    }

    // Close a <think> block left open because the stream ended on reasoning with no
    // following prose - a reasoning-to-tool turn, which is the normal shape here.
    // Without this the tag stays open and the monologue bleeds into the answer
    // after the tool recursion.
    if (isInThinkingBlock) {
      await callback(['</think>'], {
        ...splitCacheInclusiveInput(accumInputTokens + inputTokens, accumCacheReadTokens + cachedTokensFromStream),
        outputTokens: accumOutputTokens + outputTokens,
        toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
      });
      isInThinkingBlock = false;
    }

    // Empty-stream guard, mirroring the non-streaming path: a turn that emitted no
    // text and has no tool call to make produced nothing usable. Without this the
    // stream returns silently with zero callbacks and the chat hangs.
    if (!sawAnyText && func.length === 0 && toolsUsed.length === 0) {
      throw new Error(
        streamFinishReason === 'length'
          ? `DeepSeek returned no content for ${model}: the output budget was exhausted before any answer was produced (finish_reason: length). Raise maxTokens or lower the reasoning effort.`
          : `DeepSeek returned no content for ${model} (finish_reason: ${streamFinishReason ?? 'unknown'}).`
      );
    }

    let cacheStats: CacheUsageStats | undefined;
    if (cacheStrategy?.enableCaching && inputTokens > 0) {
      const adapter = getCachingAdapter(ModelBackend.DeepSeek);
      cacheStats = adapter.extractCacheStats(
        {
          usage: {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            prompt_cache_hit_tokens: cachedTokensFromStream,
          },
        },
        model
      );
      if (cacheStats) logCacheStats(this.logger, cacheStats, { streaming: true });
    }

    // Streaming is the default, so without this frame neither DeepSeek cache
    // telemetry nor responseFormatMode ever reaches the caller: every per-chunk
    // callback above fires before the terminal usage chunk is read, and the
    // non-streaming path's single callback (which does carry both) is not the one
    // users hit. Empty text because consumers append text and ASSIGN counts. A
    // turn that goes on to call a tool is not terminal - the recursion emits its
    // own totals.
    if ((cacheStats || bestEffortFormat) && func.length === 0) {
      const terminalFinishReason = normalizeOpenAIFinishReason(streamFinishReason);
      await callback([''], {
        ...splitCacheInclusiveInput(accumInputTokens + inputTokens, accumCacheReadTokens + cachedTokensFromStream),
        outputTokens: accumOutputTokens + outputTokens,
        toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
        ...(cacheStats ? { cacheStats } : {}),
        ...(bestEffortFormat ? { responseFormatMode: 'best-effort' as const } : {}),
        ...(terminalFinishReason ? { stopReason: terminalFinishReason } : {}),
      });
    }

    if (func.length > 0) {
      for await (const tool of func) {
        const { name, parameters: toolParams, id } = tool;
        if (name) {
          toolsUsed.push({ name, arguments: toolParams || '{}', id });
        }
      }

      if (options.executeTools !== false) {
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
          const toolParams = tool.parameters || '{}';
          const toolFn = options.tools?.find(t => t.toolSchema.name === name)?.toolFn;
          if (!toolFn) continue;
          try {
            const parsedParams = JSON.parse(toolParams);
            resolvedTools.push({ id, name, parameters: toolParams, parsedParams, toolFn });
          } catch {
            this.logger.warn(`JSON parse error for ${name} arguments (streaming)`);
            const entry = toolsUsed.find(t => t.name === name && t.id === id);
            if (entry) entry.arguments = '{}';
            recordToolResult(
              toolsUsed,
              { id, name },
              'Error: Tool arguments were malformed and could not be parsed.',
              false
            );
          }
        }

        const parallelEnabled = options.parallelToolExecution !== false;

        type ToolPayloadStream = { id: string; name: string; parameters: string; result: { toString(): string } };

        this.logger.debug('[Tool Execution] Executing tools (DeepSeek streaming)', {
          mode: parallelEnabled && resolvedTools.length > 1 ? 'parallel' : 'sequential',
          toolNames: resolvedTools.map(t => t.name),
        });

        const batchOutcomesStream = await executeToolsBatch<ToolPayloadStream>(
          resolvedTools.map(({ id, name, parameters: toolParams, parsedParams, toolFn }) => async () => {
            const result = await toolFn(parsedParams);
            return { id, name, parameters: toolParams, result };
          }),
          { parallel: parallelEnabled, maxConcurrency: options.maxParallelTools }
        );

        type ToolOutcome =
          | { ok: true; id: string; name: string; parameters: string; result: { toString(): string } }
          | { ok: false; id: string; name: string; parameters: string; error: unknown };

        const outcomes: ToolOutcome[] = batchOutcomesStream.map((outcome, i) =>
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

        let turnReasoning: string | undefined = streamedReasoning || undefined;
        for (const outcome of outcomes) {
          if (outcome.ok) {
            const resultStr = outcome.result.toString();
            recordToolResult(toolsUsed, { id: outcome.id, name: outcome.name }, resultStr, true);
            this.pushToolMessages(
              messages,
              { id: outcome.id, name: outcome.name, parameters: outcome.parameters },
              resultStr,
              turnReasoning ? [turnReasoning] : undefined
            );
          } else {
            if (outcome.error instanceof PermissionDeniedError) throw outcome.error;
            const errorMessage = outcome.error instanceof Error ? outcome.error.message : 'Unknown error';
            const observation = `Error processing ${outcome.name} tool: ${errorMessage}`;
            recordToolResult(toolsUsed, { id: outcome.id, name: outcome.name }, observation, false);
            this.pushToolMessages(
              messages,
              { id: outcome.id, name: outcome.name, parameters: outcome.parameters },
              observation,
              turnReasoning ? [turnReasoning] : undefined
            );
          }
          turnReasoning = undefined;
        }

        await this.complete(
          model,
          messages,
          {
            ...options,
            _internal: {
              ...options._internal,
              toolCallCount: toolCallCount + 1,
              accumInputTokens: accumInputTokens + inputTokens,
              accumOutputTokens: accumOutputTokens + outputTokens,
              accumCacheReadTokens: accumCacheReadTokens + cachedTokensFromStream,
            },
          },
          callback,
          toolsUsed
        );
      } else {
        this.logger.debug(`[Tool Execution] executeTools=false, passing tool calls to callback`);
        await callback([null], {
          ...splitCacheInclusiveInput(accumInputTokens + inputTokens, accumCacheReadTokens + cachedTokensFromStream),
          outputTokens: accumOutputTokens + outputTokens,
          toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
          ...(cacheStats ? { cacheStats } : {}),
        });
      }
    }
  }

  private formatMessages(messages: IMessage[]): OpenAI.ChatCompletionMessageParam[] {
    return convertMessagesToOpenAIFormat(messages, {
      preserveReasoningContent: true,
    }) as OpenAI.ChatCompletionMessageParam[];
  }

  formatTools(tools: ICompletionOptionTools[] = []) {
    return tools.map(tool => ({
      type: 'function' as const,
      function: tool.toolSchema,
    }));
  }

  /**
   * `thinkingBlocks` carries the turn's `reasoning_content` as a single string
   * entry. DeepSeek inverts the usual rule: when a request carries `tools`, the
   * prior turn's monologue MUST be replayed on the assistant tool-call message or
   * reasoning continuity breaks across the loop. formatMessages opts into the
   * converter's `preserveReasoningContent` for exactly this path; every other
   * target strips it, because this array is shared with the fallback hop.
   */
  pushToolMessages(messages: IMessage[], tool: IChoiceEndToolUse['tool'], result: string, thinkingBlocks?: unknown[]) {
    const reasoningContent = typeof thinkingBlocks?.[0] === 'string' ? thinkingBlocks[0] : undefined;

    messages.push({
      content: null,
      role: 'assistant',
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      tool_calls: [
        {
          id: tool.id,
          type: 'function',
          function: {
            name: tool.name,
            arguments: tool.parameters,
          },
        },
      ],
    } as unknown as IMessage);

    messages.push({
      role: 'tool',
      content: JSON.stringify({ result }),
      tool_call_id: tool.id,
    } as unknown as IMessage);
  }

  replaceLastToolResultObservation(messages: IMessage[], toolCallId: string, newObservation: string): void {
    replaceLastToolResultObservationOpenAI(messages, toolCallId, newObservation);
  }

  getLatestToolCallId(messages: IMessage[], toolName: string): string | undefined {
    return getLatestToolCallIdOpenAI(messages, toolName);
  }
}
