import {
  ChatModels,
  IMessage,
  ModelBackend,
  PermissionDeniedError,
  type CacheUsageStats,
  type ModelInfo,
} from '@bike4mind/common';
import OpenAI from 'openai';
import { ChatCompletionChunk, ChatCompletionCreateParams } from 'openai/resources';
import { Stream } from 'openai/streaming';
import { Logger } from '@bike4mind/observability';
import { executeToolsBatch } from './executeToolsBatch';
import {
  CompletionInfo,
  DEFAULT_MAX_TOOL_CALLS,
  IChoiceEndToolUse,
  ICompletionBackend,
  ICompletionOptionTools,
  ICompletionOptions,
} from './backend';
import { getCachingAdapter, logCacheStats } from './caching/adapters';
import { kimiReasoningParams, kimiSamplingParams, kimiToolChoice } from './kimiParams';
import { convertMessagesToOpenAIFormat } from './messageFormatConverter';
import { normalizeOpenAIFinishReason } from './stopReason';

/**
 * Moonshot AI's Kimi models, served from their OpenAI-compatible endpoint.
 *
 * Structurally this is xaiBackend's twin - same OpenAI SDK against a different
 * baseURL, same recursive tool loop, same multi-turn token accumulators - and the
 * two must stay in sync on that machinery. Three things genuinely differ:
 *
 * 1. `max_tokens` is deprecated upstream in favor of `max_completion_tokens`.
 * 2. Structured output is NATIVE (json_schema), not the best-effort prompt
 *    injection xAI needs, so callers get responseFormatMode: 'native'.
 * 3. Reasoning controls are per-model and mutually exclusive; see kimiParams.
 *
 * @see https://platform.kimi.ai/docs/api/chat
 */
export class KimiBackend implements ICompletionBackend {
  private _baseUrl = 'https://api.moonshot.ai/v1';
  private _api: OpenAI;
  private logger: Logger;
  public currentModel: string = '';

  constructor(apiKey: string, logger?: Logger) {
    if (!apiKey) {
      throw new Error('Moonshot API key is required');
    }
    this._api = new OpenAI({ apiKey, baseURL: this._baseUrl });
    this.logger = logger ?? new Logger();
  }

  /**
   * Seed listing. Post-registry this is the fallback tier, not the source of
   * truth: the catalog overlays context window, limits, lifecycle and price on
   * top of these rows, and discovery keeps them current without a deploy. What
   * cannot come from a feed - and so has to live here - is the reasoning and
   * dispatch shape each id needs.
   */
  async getModelInfo(): Promise<ModelInfo[]> {
    return [
      {
        id: ChatModels.KIMI_K3,
        type: 'text' as const,
        name: 'Kimi K3',
        backend: ModelBackend.Kimi,
        contextWindow: 1048576,
        max_tokens: 131072,
        can_stream: true,
        pricing: {
          // $3 / 1M in, $15 / 1M out, $0.30 / 1M cache read.
          // @see https://platform.kimi.ai/docs/pricing/chat-k3
          1048576: { input: 3 / 1000000, output: 15 / 1000000, cache_read: 0.3 / 1000000 },
        },
        can_think: true,
        supportsVision: true,
        supportsTools: true,
        supportsImageVariation: false,
        releaseDate: '2026-07-16',
        description:
          "Moonshot's Kimi K3 flagship. 1M context with native vision, tool use, and selectable reasoning effort (low/high/max). Always reasons - effort sets depth, not whether.",
      },
      {
        id: ChatModels.KIMI_K2_7_CODE,
        type: 'text' as const,
        name: 'Kimi K2.7 Code',
        backend: ModelBackend.Kimi,
        contextWindow: 262144,
        max_tokens: 262144,
        can_stream: true,
        pricing: {
          // $0.95 / 1M in, $4 / 1M out, $0.19 / 1M cache read.
          262144: { input: 0.95 / 1000000, output: 4 / 1000000, cache_read: 0.19 / 1000000 },
        },
        can_think: true,
        supportsVision: true,
        supportsTools: true,
        supportsImageVariation: false,
        releaseDate: '2026-06-12',
        trainingCutoff: '2025-01-01',
        description:
          "Moonshot's coding-focused Kimi, tuned for long-horizon repository work with less overthinking. Thinking cannot be disabled.",
      },
      {
        id: ChatModels.KIMI_K2_7_CODE_HIGHSPEED,
        type: 'text' as const,
        name: 'Kimi K2.7 Code (High Speed)',
        backend: ModelBackend.Kimi,
        contextWindow: 262144,
        max_tokens: 262144,
        can_stream: true,
        pricing: {
          // Same model on faster infrastructure at 2x the rate: $1.90 / $8.00.
          262144: { input: 1.9 / 1000000, output: 8 / 1000000, cache_read: 0.38 / 1000000 },
        },
        can_think: true,
        supportsVision: true,
        supportsTools: true,
        supportsImageVariation: false,
        releaseDate: '2026-06-12',
        trainingCutoff: '2025-01-01',
        description:
          'Kimi K2.7 Code served at 180-260 tokens/s for latency-sensitive work. Identical capabilities to K2.7 Code at twice the price.',
      },
      {
        id: ChatModels.KIMI_K2_6,
        type: 'text' as const,
        name: 'Kimi K2.6',
        backend: ModelBackend.Kimi,
        contextWindow: 262144,
        max_tokens: 262144,
        can_stream: true,
        pricing: {
          // $0.95 / 1M in, $4 / 1M out, $0.16 / 1M cache read.
          262144: { input: 0.95 / 1000000, output: 4 / 1000000, cache_read: 0.16 / 1000000 },
        },
        can_think: true,
        supportsVision: true,
        supportsTools: true,
        supportsImageVariation: false,
        releaseDate: '2026-04-21',
        trainingCutoff: '2025-01-01',
        description:
          "Moonshot's multimodal workhorse for agent loops, coding, and visual context. Thinking can be turned off on this one, unlike the K2.7 code models.",
      },
      {
        id: ChatModels.KIMI_K2_5,
        type: 'text' as const,
        name: 'Kimi K2.5',
        backend: ModelBackend.Kimi,
        contextWindow: 262144,
        max_tokens: 262144,
        can_stream: true,
        pricing: {
          // $0.60 / 1M in, $3 / 1M out, $0.10 / 1M cache read.
          262144: { input: 0.6 / 1000000, output: 3 / 1000000, cache_read: 0.1 / 1000000 },
        },
        can_think: true,
        supportsVision: true,
        supportsTools: true,
        supportsImageVariation: false,
        releaseDate: '2026-01-01',
        trainingCutoff: '2025-01-01',
        description:
          'The previous-generation Kimi, still the cheapest of the family. Superseded by K2.6 on quality at a modest price increase.',
      },
    ];
  }

  async complete(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>,
    callback: (text: (string | null | undefined)[], completionInfo: CompletionInfo) => Promise<void>,
    toolsUsed: Array<{ name: string; arguments?: string; id?: string }> = []
  ): Promise<void> {
    this.currentModel = model;

    const toolCallCount = options._internal?.toolCallCount ?? 0;

    // Multi-turn token accumulators. Each Moonshot call (every recursive tool
    // round-trip) is billed independently, so we add each turn's usage and emit
    // the running total - consumers assign rather than add, so the terminal turn
    // has to carry the whole session.
    const accumInputTokens = options._internal?.accumInputTokens ?? 0;
    const accumOutputTokens = options._internal?.accumOutputTokens ?? 0;
    const accumCacheReadTokens = options._internal?.accumCacheReadTokens ?? 0;

    const maxToolCalls = options._internal?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    if (toolCallCount >= maxToolCalls && options.tools?.length) {
      this.logger.warn(`⚠️ Max tool calls limit (${maxToolCalls}) reached. Disabling tools to prevent infinite loops.`);
      await this.complete(
        model,
        messages,
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

    const useStreaming = options.stream && (!options.n || options.n === 1);

    const parameters: ChatCompletionCreateParams = {
      model,
      messages: this.formatMessages(messages),
    };

    Object.assign(parameters, {
      // Every pinned sampling parameter goes through this one gate - sending any
      // of them to a model that fixes them is a 400, so none may be set here.
      ...kimiSamplingParams(model, {
        temperature: options.temperature,
        topP: options.topP,
        presencePenalty: options.presencePenalty,
        frequencyPenalty: options.frequencyPenalty,
        n: options.n,
      }),
      ...kimiReasoningParams(model, { thinking: options.thinking, reasoningEffort: options.reasoningEffort }),
      stop: options.stop,
      stream: useStreaming,
      // `max_tokens` is deprecated upstream; Moonshot documents
      // max_completion_tokens as the supported spelling.
      max_completion_tokens: options.maxTokens,
      ...(useStreaming && { stream_options: { include_usage: true } }),
    });

    if (options.tools?.length) {
      parameters.tools = this.formatTools(options.tools);
      const choice = kimiToolChoice(model, options.tool_choice);
      if (choice !== undefined) {
        parameters.tool_choice = choice as ChatCompletionCreateParams['tool_choice'];
      }
    }

    // Native structured output - Moonshot implements OpenAI's json_schema form,
    // so unlike xAI there is no prompt-injection fallback and no post-validation
    // burden on the caller.
    if (options.responseFormat?.type === 'json_schema') {
      const rf = options.responseFormat;
      // Cast: OpenAI's typed response_format is on a newer params shape than the
      // one TS resolves here, same as openaiBackend.
      (parameters as any).response_format = {
        type: 'json_schema',
        json_schema: {
          name: rf.json_schema.name,
          ...(rf.json_schema.description ? { description: rf.json_schema.description } : {}),
          schema: rf.json_schema.schema,
          ...(rf.json_schema.strict !== undefined ? { strict: rf.json_schema.strict } : { strict: true }),
        },
      };
    } else if (options.responseFormat?.type === 'text') {
      (parameters as any).response_format = { type: 'text' };
    }
    const nativeFormat = options.responseFormat?.type === 'json_schema';

    // NO GATE on reasoning capture, deliberately. Deriving this from "did we send a
    // reasoning parameter" drops reasoning on the common path: K3 always reasons and
    // kimiReasoningParams sends nothing when no explicit effort was set (the default,
    // since reasoningEffort is only populated on an explicit user override), and
    // k2.6/k2.5 default thinking ON when the parameter is omitted. Any
    // reasoning_content Moonshot returns was billed as output tokens, so discarding
    // it would charge the user for text they never see.

    // Moonshot's context caching is automatic with no parameter or header to set;
    // the adapter exists to read `usage.cached_tokens` back out.
    const cacheStrategy = options.cacheStrategy;

    const response = await this._api.chat.completions.create(parameters, { signal: options.abortSignal });
    let inputTokens = 0;
    let outputTokens = 0;

    if (!(response instanceof Stream)) {
      const streamedText: string[] = [];

      if (!response.choices || response.choices.length === 0) {
        throw new Error('No choices returned from the Moonshot API');
      }

      const turnCacheReadTokens = this.cachedTokensOf(response.usage as Record<string, unknown> | undefined);

      for (const c of response.choices) {
        if (!c.message) continue;

        // Kimi returns thinking on `reasoning_content`, same field xAI uses. It is
        // read here but NOT returned early: a reasoning model that also calls a
        // tool populates both, and handling reasoning first would hand back the
        // monologue as the whole answer and never run the tool. That is not
        // hypothetical for Kimi - the k2.7-code ids cannot turn thinking off, and
        // they are the agentic models most likely to call something.
        const reasoningContent = (c.message as any).reasoning_content as string | undefined;

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
              }
            }

            const parallelEnabled = options.parallelToolExecution !== false;

            type ToolPayload = { id: string; name: string; parameters: string; result: { toString(): string } };

            this.logger.debug('[Tool Execution] Executing tools (Kimi non-streaming)', {
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

            for (const outcome of outcomes) {
              if (outcome.ok) {
                this.pushToolMessages(
                  messages,
                  { id: outcome.id, name: outcome.name, parameters: outcome.parameters },
                  outcome.result.toString()
                );
              } else {
                if (outcome.error instanceof PermissionDeniedError) throw outcome.error;
                this.pushToolMessages(
                  messages,
                  { id: outcome.id, name: outcome.name, parameters: outcome.parameters },
                  `Error processing ${outcome.name} tool: ${outcome.error instanceof Error ? outcome.error.message : 'Unknown error'}`
                );
              }
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
              ...this.splitCachedInput(
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
      // empty answer, and the most likely cause on Kimi is a reasoning model that
      // spent its whole max_completion_tokens budget thinking. Without this the
      // user gets a silent blank reply. The Bedrock path has the same guard in
      // bedrockBackend/base.ts; the direct path needs its own.
      if (streamedText.every(text => !text) && toolsUsed.length === 0) {
        const finish = response.choices[0]?.finish_reason;
        throw new Error(
          finish === 'length'
            ? `Moonshot returned no content for ${model}: the output budget was exhausted before any answer was produced (finish_reason: length). Raise maxTokens or lower the reasoning effort.`
            : `Moonshot returned no content for ${model} (finish_reason: ${finish ?? 'unknown'}).`
        );
      }

      let cacheStats: CacheUsageStats | undefined;
      if (cacheStrategy?.enableCaching && response.usage) {
        const adapter = getCachingAdapter(ModelBackend.Kimi);
        cacheStats = adapter.extractCacheStats(response as unknown as Record<string, unknown>, model);
        if (cacheStats) logCacheStats(this.logger, cacheStats, { streaming: false });
      }

      const finishReason = normalizeOpenAIFinishReason(response.choices[0]?.finish_reason);
      const totalCacheReadTokens = accumCacheReadTokens + turnCacheReadTokens;
      await callback(streamedText, {
        ...this.splitCachedInput(accumInputTokens + (response.usage?.prompt_tokens || 0), totalCacheReadTokens),
        outputTokens: accumOutputTokens + (response.usage?.completion_tokens || 0),
        toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
        cacheStats,
        ...(nativeFormat ? { responseFormatMode: 'native' as const } : {}),
        ...(finishReason ? { stopReason: finishReason } : {}),
      });
      return;
    }

    const func: { name?: string; id?: string; parameters?: string }[] = [];
    let isInThinkingBlock = false;
    let cachedTokensFromStream = 0;
    let streamFinishReason: string | undefined;
    let sawAnyText = false;

    for await (const chunk of response) {
      const streamedText: string[] = [];
      if (chunk.usage) {
        inputTokens = Math.max(inputTokens, chunk.usage?.prompt_tokens || 0);
        outputTokens += chunk.usage?.completion_tokens || 0;
        const chunkCached = this.cachedTokensOf(chunk.usage as unknown as Record<string, unknown>);
        if (chunkCached > 0) cachedTokensFromStream = chunkCached;
      }

      chunk?.choices.forEach((c: ChatCompletionChunk.Choice) => {
        if (c.finish_reason) {
          streamFinishReason = c.finish_reason;
        }

        // Ungated, for the same reason as the non-streaming path: reasoning arrives
        // by default on every current Kimi and is billed either way.
        if ((c.delta as any).reasoning_content) {
          if (!isInThinkingBlock) {
            isInThinkingBlock = true;
            streamedText[c.index] = '<think>' + (c.delta as any).reasoning_content;
          } else {
            streamedText[c.index] = (c.delta as any).reasoning_content;
          }
          return;
        }

        if (isInThinkingBlock && c.delta.content && !(c.delta as any).reasoning_content) {
          isInThinkingBlock = false;
          streamedText[c.index] = '</think>' + (c.delta.content || '');
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
        ...this.splitCachedInput(accumInputTokens + inputTokens, accumCacheReadTokens + cachedTokensFromStream),
        outputTokens: accumOutputTokens + outputTokens,
        toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
        ...(normalizedFinishReason ? { stopReason: normalizedFinishReason } : {}),
      });
    }

    // Close a <think> block left open because the stream ended on reasoning with no
    // following prose -- a reasoning-to-tool turn (the k2.7-code agentic ids cannot
    // disable thinking, so they routinely reason then call a tool) or a stream
    // truncated mid-reasoning. Without this the tag stays open and the monologue
    // bleeds into the answer after the tool recursion.
    if (isInThinkingBlock) {
      await callback(['</think>'], {
        ...this.splitCachedInput(accumInputTokens + inputTokens, accumCacheReadTokens + cachedTokensFromStream),
        outputTokens: accumOutputTokens + outputTokens,
        toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
      });
      isInThinkingBlock = false;
    }

    // Empty-stream guard, mirroring the non-streaming path: a turn that emitted no
    // text and has no tool call to make produced nothing usable. The most likely
    // cause is a reasoning model that spent its whole budget thinking; without this
    // the stream returns silently with zero callbacks and the chat hangs.
    if (!sawAnyText && func.length === 0 && toolsUsed.length === 0) {
      throw new Error(
        streamFinishReason === 'length'
          ? `Moonshot returned no content for ${model}: the output budget was exhausted before any answer was produced (finish_reason: length). Raise maxTokens or lower the reasoning effort.`
          : `Moonshot returned no content for ${model} (finish_reason: ${streamFinishReason ?? 'unknown'}).`
      );
    }

    let cacheStats: CacheUsageStats | undefined;
    if (cacheStrategy?.enableCaching && inputTokens > 0) {
      const adapter = getCachingAdapter(ModelBackend.Kimi);
      cacheStats = adapter.extractCacheStats(
        {
          usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, cached_tokens: cachedTokensFromStream },
        },
        model
      );
      if (cacheStats) logCacheStats(this.logger, cacheStats, { streaming: true });
    }

    if (nativeFormat && func.length === 0) {
      await callback([], {
        ...this.splitCachedInput(accumInputTokens + inputTokens, accumCacheReadTokens + cachedTokensFromStream),
        outputTokens: accumOutputTokens + outputTokens,
        toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
        responseFormatMode: 'native',
        cacheStats,
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
          }
        }

        const parallelEnabled = options.parallelToolExecution !== false;

        type ToolPayloadStream = { id: string; name: string; parameters: string; result: { toString(): string } };

        this.logger.debug('[Tool Execution] Executing tools (Kimi streaming)', {
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

        for (const outcome of outcomes) {
          if (outcome.ok) {
            this.pushToolMessages(
              messages,
              { id: outcome.id, name: outcome.name, parameters: outcome.parameters },
              outcome.result.toString()
            );
          } else {
            if (outcome.error instanceof PermissionDeniedError) throw outcome.error;
            this.pushToolMessages(
              messages,
              { id: outcome.id, name: outcome.name, parameters: outcome.parameters },
              `Error processing ${outcome.name} tool: ${outcome.error instanceof Error ? outcome.error.message : 'Unknown error'}`
            );
          }
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
          ...this.splitCachedInput(accumInputTokens + inputTokens, accumCacheReadTokens + cachedTokensFromStream),
          outputTokens: accumOutputTokens + outputTokens,
          toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
        });
      }
    }
  }

  /**
   * Convert Moonshot's CACHE-INCLUSIVE `prompt_tokens` into the cache-EXCLUSIVE
   * convention getTextModelCost expects, which is Anthropic's: `inputTokens`
   * counts only uncached tokens and cache reads are billed separately at their
   * own (much cheaper) rate.
   *
   * Verified live 2026-07-28: a repeated 1220-token prompt returned
   * `prompt_tokens: 1220` WITH `cached_tokens: 1220` - the same tokens, reported
   * twice, not 1220 fresh plus 1220 cached. So passing prompt_tokens through as
   * inputTokens while also forwarding cacheReadInputTokens would bill the cached
   * portion twice; passing it through and forwarding NOTHING (the previous
   * behavior) charges the full input rate on tokens Moonshot billed at roughly a
   * sixth of it - on k2.6, $0.95/MTok against $0.16. Subtracting is the only
   * split that bills what the provider actually charged.
   *
   * Clamped at zero: if a feed ever reports more cached than prompt tokens, a
   * negative input count would silently credit the user.
   */
  private splitCachedInput(
    totalPromptTokens: number,
    cacheReadTokens: number
  ): { inputTokens: number; cacheReadInputTokens?: number } {
    if (cacheReadTokens <= 0) return { inputTokens: totalPromptTokens };
    const cached = Math.min(cacheReadTokens, totalPromptTokens);
    return { inputTokens: Math.max(0, totalPromptTokens - cached), cacheReadInputTokens: cached };
  }

  /**
   * Cached prompt tokens from a usage object. Moonshot publishes BOTH a flat
   * `usage.cached_tokens` and the nested OpenAI `prompt_tokens_details.cached_tokens`
   * - confirmed live, both present with the same value - so either spelling is
   * accepted and reading neither would bill every hit at the full input rate.
   */
  private cachedTokensOf(usage: Record<string, unknown> | undefined): number {
    if (!usage) return 0;
    const flat = usage.cached_tokens;
    if (typeof flat === 'number' && Number.isFinite(flat) && flat >= 0) return flat;
    const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
    const nested = details?.cached_tokens;
    return typeof nested === 'number' && Number.isFinite(nested) && nested >= 0 ? nested : 0;
  }

  private formatMessages(messages: IMessage[]): OpenAI.ChatCompletionMessageParam[] {
    return convertMessagesToOpenAIFormat(messages) as OpenAI.ChatCompletionMessageParam[];
  }

  formatTools(tools: ICompletionOptionTools[] = []) {
    return tools.map(tool => ({
      type: 'function' as const,
      function: tool.toolSchema,
    }));
  }

  pushToolMessages(messages: IMessage[], tool: IChoiceEndToolUse['tool'], result: string, _thinkingBlocks?: unknown[]) {
    messages.push({
      content: null,
      role: 'assistant',
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
      // Moonshot's tool-call guide shows `name` on the result message alongside
      // tool_call_id, unlike OpenAI where the id alone suffices.
      name: tool.name,
    } as unknown as IMessage);
  }
}
