import {
  ChatModels,
  ImageModels,
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
import { convertMessagesToOpenAIFormat } from './messageFormatConverter';
import { injectJsonSchemaInstruction, isBestEffortJsonSchema } from './responseFormatHelpers';
import { normalizeOpenAIFinishReason } from './stopReason';

export class XAIBackend implements ICompletionBackend {
  private _baseUrl = 'https://api.x.ai/v1';
  private _api: OpenAI;
  private logger: Logger;
  public currentModel: string = '';

  constructor(apiKey: string, logger?: Logger) {
    if (!apiKey) {
      throw new Error('XAI API key is required');
    }
    this._api = new OpenAI({ apiKey, baseURL: this._baseUrl });
    this.logger = logger ?? new Logger();
  }

  async getModelInfo(): Promise<ModelInfo[]> {
    return [
      {
        id: ChatModels.GROK_4_5,
        type: 'text' as const,
        name: 'Grok 4.5',
        backend: ModelBackend.XAI,
        contextWindow: 500000,
        max_tokens: 128000,
        can_stream: true,
        pricing: {
          // Tiered on prompt size. <= 200K: $2 / 1M in, $6 / 1M out, $0.50 / 1M cache read.
          // > 200K: $4 / 1M in, $12 / 1M out, $1 / 1M cache read.
          // The docs page publishes only the base rates; the 200K threshold and the
          // long-context and cache-read rates come from GET /v1/language-models
          // (long_context_threshold, *_long_context, cached_prompt_text_token_price).
          // @see https://docs.x.ai/developers/models
          200000: { input: 2 / 1000000, output: 6 / 1000000, cache_read: 0.5 / 1000000 },
          500000: { input: 4 / 1000000, output: 12 / 1000000, cache_read: 1 / 1000000 },
        },
        can_think: true,
        supportsVision: true,
        supportsTools: true,
        supportsImageVariation: false,
        releaseDate: '2026-07-08',
        description:
          "xAI's Grok 4.5 reasoning model. 500K context window with vision, tool use, and extended reasoning.",
      },
      {
        id: ChatModels.GROK_4,
        type: 'text' as const,
        name: 'Grok 4',
        backend: ModelBackend.XAI,
        contextWindow: 256000,
        max_tokens: 16384,
        can_stream: true,
        pricing: {
          // $3.00 / 1M Input tokens, $15.00 / 1M Output tokens. @see https://docs.x.ai/developers/models
          256000: { input: 3 / 1000000, output: 15 / 1000000 },
        } as Record<number, { input: number; output: number }>,
        can_think: true,
        supportsVision: true,
        supportsTools: true,
        supportsImageVariation: false,
        description:
          "xAI's most capable reasoning model. Excels at complex problem-solving, coding, math, and multimodal understanding with 256K context window.",
      },
      {
        id: ChatModels.GROK_3,
        type: 'text' as const,
        name: 'Grok 3',
        backend: ModelBackend.XAI,
        contextWindow: 131072,
        max_tokens: 16384,
        can_stream: true,
        pricing: {
          // $3 / 1M Input tokens, $15 / 1M Output tokens. @see https://docs.x.ai/docs/models#models-and-pricing
          131072: { input: 3 / 1000000, output: 15 / 1000000 },
        } as Record<number, { input: number; output: number }>,
        can_think: false,
        supportsVision: false,
        supportsTools: true,
        supportsImageVariation: false,
        description:
          "xAI's flagship Grok 3 model that excels at enterprise use cases like data extraction, coding, and text summarization. Possesses deep domain knowledge in finance, healthcare, law, and science.",
      },
      {
        id: ChatModels.GROK_3_FAST,
        type: 'text' as const,
        name: 'Grok 3 Fast',
        backend: ModelBackend.XAI,
        contextWindow: 131072,
        max_tokens: 16384,
        can_stream: true,
        pricing: {
          // $5 / 1M Input tokens, $25 / 1M Output tokens. @see https://docs.x.ai/docs/models#models-and-pricing
          131072: { input: 5 / 1000000, output: 25 / 1000000 },
        } as Record<number, { input: number; output: number }>,
        can_think: false,
        supportsVision: false,
        supportsTools: true,
        supportsImageVariation: false,
        description:
          "xAI's Grok 3 model optimized for speed. Same underlying capabilities as Grok 3 but served on faster infrastructure for significantly reduced response times.",
        deprecationDate: '2025-09-15',
      },
      {
        id: ChatModels.GROK_3_MINI,
        type: 'text' as const,
        name: 'Grok 3 Mini',
        backend: ModelBackend.XAI,
        contextWindow: 131072,
        max_tokens: 16384,
        can_stream: true,
        pricing: {
          // $0.30 / 1M Input tokens, $0.50 / 1M Output tokens. @see https://docs.x.ai/docs/models#models-and-pricing
          131072: { input: 0.3 / 1000000, output: 0.5 / 1000000 },
        } as Record<number, { input: number; output: number }>,
        can_think: true,
        supportsVision: false,
        supportsTools: true,
        supportsImageVariation: false,
        description:
          "xAI's lightweight reasoning model with thinking capabilities. Fast, smart, and cost-effective for logic-based tasks. Raw thinking traces are accessible.",
      },
      {
        id: ChatModels.GROK_3_MINI_FAST,
        type: 'text' as const,
        name: 'Grok 3 Mini Fast',
        backend: ModelBackend.XAI,
        contextWindow: 131072,
        max_tokens: 16384,
        can_stream: true,
        pricing: {
          // $0.60 / 1M Input tokens, $4 / 1M Output tokens. @see https://docs.x.ai/docs/models#models-and-pricing
          131072: { input: 0.6 / 1000000, output: 4 / 1000000 },
        } as Record<number, { input: number; output: number }>,
        can_think: true,
        supportsVision: false,
        supportsTools: true,
        supportsImageVariation: false,
        description:
          "xAI's speed-optimized Grok 3 Mini with thinking capabilities. Same model as Grok 3 Mini but with significantly faster response times.",
        deprecationDate: '2025-09-15',
      },
      {
        id: ChatModels.GROK_2_VISION,
        type: 'text' as const,
        name: 'Grok 2 Vision',
        backend: ModelBackend.XAI,
        contextWindow: 32768,
        max_tokens: 16384,
        can_stream: true,
        pricing: {
          // $2.00 / 1M Input tokens, $10.00 / 1M Output tokens. @see https://docs.x.ai/docs/models#models-and-pricing
          8192: { input: 2.0 / 1000000, output: 10.0 / 1000000 },
        } as Record<number, { input: number; output: number }>,
        can_think: false,
        supportsVision: true,
        supportsTools: true,
        supportsImageVariation: false,
        description:
          "xAI's multimodal Grok 2 model with vision capabilities. Processes both images and text for tasks requiring visual understanding.",
        deprecationDate: '2025-09-15',
      },
      {
        id: ChatModels.GROK_2,
        type: 'text' as const,
        name: 'Grok 2',
        backend: ModelBackend.XAI,
        contextWindow: 131072,
        max_tokens: 16384,
        can_stream: true,
        pricing: {
          // $2.00 / 1M Input tokens, $10.00 / 1M Output tokens. @see https://docs.x.ai/docs/models#models-and-pricing
          131072: { input: 2.0 / 1000000, output: 10.0 / 1000000 },
        } as Record<number, { input: number; output: number }>,
        can_think: false,
        supportsVision: false,
        supportsTools: true,
        supportsImageVariation: false,
        description:
          "xAI's legacy Grok 2 model with 131K context window. Consider using Grok 3 for better performance.",
        deprecationDate: '2025-09-15',
      },
      {
        id: ChatModels.GROK_BETA,
        type: 'text' as const,
        name: 'Grok Beta',
        backend: ModelBackend.XAI,
        contextWindow: 32768,
        max_tokens: 16384,
        can_stream: true,
        pricing: {
          // $5.00 / 1M Input tokens, $15.00 / 1M Output tokens. @see https://docs.x.ai/docs/models#models-and-pricing
          131072: { input: 5 / 1000000, output: 15 / 1000000 },
        } as Record<number, { input: number; output: number }>,
        can_think: false,
        supportsVision: false,
        supportsTools: true,
        supportsImageVariation: false,
        deprecationDate: '2025-09-15', // Deprecated - same as Grok 3 Fast and Grok 2 Vision
        description: "xAI's legacy beta text model. No longer recommended - use Grok 3 instead.",
      },
      {
        id: ChatModels.GROK_VISION_BETA,
        type: 'text' as const,
        name: 'Grok Vision Beta',
        backend: ModelBackend.XAI,
        contextWindow: 32768,
        max_tokens: 16384,
        can_stream: true,
        pricing: {
          // $5.00 / 1M Input tokens, $15.00 / 1M Output tokens. @see https://docs.x.ai/docs/models#models-and-pricing
          8192: { input: 5 / 1000000, output: 15 / 1000000 },
        } as Record<number, { input: number; output: number }>,
        can_think: false,
        supportsVision: true,
        supportsTools: true,
        supportsImageVariation: false,
        deprecationDate: '2025-09-15', // Deprecated - same as Grok 3 Fast and Grok 2 Vision
        description:
          "xAI's legacy beta multimodal model with vision capabilities. Use Grok 2 Vision for better performance.",
      },
      // XAI Image Models
      {
        id: ImageModels.GROK_IMAGINE_IMAGE_QUALITY,
        type: 'image',
        name: 'Grok Imagine (Quality)',
        backend: ModelBackend.XAI,
        contextWindow: 10000,
        max_tokens: 10000,
        supportsImageVariation: false,
        pricing: {
          // xAI Grok Imagine Quality pricing: $0.055 per image (https://docs.x.ai/docs/models)
          1: { input: 0.055, output: 0 },
        },
        description: 'xAI Grok Imagine (Quality) - Text-to-image generation via the xAI Imagine API.',
        rank: 10,
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
    options = {
      temperature: 0.9,
      ...options,
    };

    // Tool chaining safeguard: Track and limit recursive tool calls
    const toolCallCount = options._internal?.toolCallCount ?? 0;

    // Multi-turn token accumulators. Each xAI API call (every recursive tool
    // round-trip) is billed independently, so we add each turn's usage and
    // emit the running total. cliCompletions' assign-not-add wrappedOnChunk
    // means the last cb's tokens win - emitting accum+thisTurn keeps the
    // running total across recursive turns.
    const accumInputTokens = options._internal?.accumInputTokens ?? 0;
    const accumOutputTokens = options._internal?.accumOutputTokens ?? 0;

    // Check if we've exceeded the tool call limit (only when there are tools to execute).
    // Honor a per-request override (a surface-set maxToolCalls); else the default.
    const maxToolCalls = options._internal?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    if (toolCallCount >= maxToolCalls && options.tools?.length) {
      this.logger.warn(`⚠️ Max tool calls limit (${maxToolCalls}) reached. Disabling tools to prevent infinite loops.`);
      // Remove tools when limit is hit and continue, preserving _internal settings
      await this.complete(
        model,
        messages,
        {
          ...options,
          tools: undefined,
          _internal: options._internal, // Preserve any internal settings
        },
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

    // Best-effort response_format support: xAI's structured-output
    // is OpenAI-compatible-ish but inconsistent across grok variants, so we
    // degrade by injecting a system-level JSON Schema instruction and report
    // responseFormatMode: 'best-effort' so callers know to post-validate.
    const messagesWithFormat = injectJsonSchemaInstruction(messages, options.responseFormat);
    const bestEffortFormat = isBestEffortJsonSchema(options.responseFormat);

    // Base parameters that work for all models
    const parameters: ChatCompletionCreateParams = {
      model,
      messages: this.formatMessages(messagesWithFormat),
      temperature: options.temperature ?? 0.9,
    };

    // Add parameters conditionally based on model type
    // Determine if we can use streaming based on n parameter
    // OpenAI API doesn't support streaming with n > 1
    const useStreaming = options.stream && (!options.n || options.n === 1);

    // Non-O1 models support these parameters
    Object.assign(parameters, {
      top_p: options.topP,
      // n is only used for non-streaming completions. 1 is the default.
      // We can work on a workaround later by using multiple streams.
      // Use requested n value, but ensure it's at least 1
      n: options.n || 1,
      stop: options.stop,
      presence_penalty: options.presencePenalty,
      frequency_penalty: options.frequencyPenalty,
      stream: useStreaming,
      max_tokens: options.maxTokens,
      ...(useStreaming && { stream_options: { include_usage: true } }),
    });

    if (options.tools?.length) {
      parameters.tools = this.formatTools(options.tools);
    }

    // Check thinking support once at the beginning
    const supportsThinking = await this.modelSupportsThinking(model);

    // Check if thinking is enabled in options
    const thinkingEnabled = supportsThinking && (options as any).thinking?.enabled === true;

    // Add xAI-specific headers for caching (optional conversation ID for cache affinity)
    const cacheStrategy = options.cacheStrategy;
    let headers: Record<string, string> = {};
    if (cacheStrategy?.enableCaching) {
      const adapter = getCachingAdapter(ModelBackend.XAI);
      headers = adapter.getHeaders?.(cacheStrategy) || {};

      if (headers['x-grok-conv-id']) {
        this.logger.debug('[xAI] Using conversation ID for cache affinity', {
          conversationId: headers['x-grok-conv-id'],
        });
      }
    }

    const response = await this._api.chat.completions.create(parameters, {
      signal: options.abortSignal,
      headers,
    });
    let inputTokens = 0;
    let outputTokens = 0;

    if (!(response instanceof Stream)) {
      const streamedText: string[] = [];

      // Ensure response.choices exists and has elements
      if (!response.choices || response.choices.length === 0) {
        throw new Error('No choices returned from OpenAI API');
      }

      for (const c of response.choices) {
        if (!c.message) continue; // Skip if message is undefined

        // Handle reasoning content for thinking models (only if thinking is enabled)
        if (thinkingEnabled && (c.message as any).reasoning_content) {
          const reasoningContent = (c.message as any).reasoning_content;
          streamedText[c.index] = `<think>${reasoningContent}</think>${c.message.content || ''}`;
          continue;
        }

        if (c.message.tool_calls && c.message.tool_calls.length > 0) {
          // Track all tools first
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

          // Check if we should execute tools or just report them
          if (options.executeTools !== false) {
            // Resolve all executable function tool calls
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

            // Execute tools - parallel by default, sequential when opted out
            const parallelEnabled = options.parallelToolExecution !== false;

            type ToolPayload = { id: string; name: string; parameters: string; result: { toString(): string } };

            this.logger.debug('[Tool Execution] Executing tools (xAI non-streaming)', {
              mode: parallelEnabled && resolvedTools.length > 1 ? 'parallel' : 'sequential',
              toolNames: resolvedTools.map(t => t.name),
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

            // One recursive call after all tools - keep tools for chaining.
            // Carry this turn's tokens forward so the terminal recursive call
            // emits the full multi-turn billable total to cb.
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
                },
              },
              callback,
              toolsUsed
            );
            return; // Exit after handling all tools
          } else {
            // New behavior: just pass tool calls through callback, don't execute.
            // Terminal leaf - emit accumulated total plus this turn's tokens.
            this.logger.debug(`[Tool Execution] executeTools=false, passing tool calls to callback`);
            await callback([null], {
              inputTokens: accumInputTokens + (response.usage?.prompt_tokens || 0),
              outputTokens: accumOutputTokens + (response.usage?.completion_tokens || 0),
              toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
            });
            return; // Exit after passing tools
          }
        } else {
          streamedText[c.index] = c.message.content || '';
        }
      }

      // Extract cache stats if caching is enabled (xAI caching is automatic)
      let cacheStats: CacheUsageStats | undefined;
      if (cacheStrategy?.enableCaching && response.usage) {
        const adapter = getCachingAdapter(ModelBackend.XAI);
        cacheStats = adapter.extractCacheStats(response as unknown as Record<string, unknown>, model);

        if (cacheStats) {
          logCacheStats(this.logger, cacheStats, { streaming: false });
        }
      }

      // Terminal turn - no choice had tool_calls (we'd have returned above).
      // Emit accum + this turn's tokens.
      const finishReason = normalizeOpenAIFinishReason(response.choices[0]?.finish_reason);
      const completionInfo = {
        inputTokens: accumInputTokens + (response.usage?.prompt_tokens || 0),
        outputTokens: accumOutputTokens + (response.usage?.completion_tokens || 0),
        toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
        cacheStats,
        ...(bestEffortFormat ? { responseFormatMode: 'best-effort' as const } : {}),
        ...(finishReason ? { stopReason: finishReason } : {}),
      };
      await callback(streamedText, completionInfo);
      return;
    }

    const func: { name?: string; id?: string; parameters?: string }[] = [];
    let isInThinkingBlock = false;
    let cachedTokensFromStream = 0; // Track cached tokens from streaming chunks
    // Keep the last non-null finish_reason (mirrors anthropicBackend's stopReason
    // capture) - the terminal chunk of a round carries it, earlier chunks don't.
    let streamFinishReason: string | undefined;

    for await (const chunk of response) {
      const streamedText: string[] = [];
      if (chunk.usage) {
        inputTokens = Math.max(inputTokens, chunk.usage?.prompt_tokens || 0);
        outputTokens += chunk.usage?.completion_tokens || 0;
        // Capture cached tokens if available in streaming response (xAI-specific field)
        const chunkUsage = chunk.usage as Record<string, unknown>;
        if (chunkUsage.cached_prompt_tokens !== undefined) {
          cachedTokensFromStream = chunkUsage.cached_prompt_tokens as number;
        }
      }

      chunk?.choices.forEach((c: ChatCompletionChunk.Choice) => {
        if (c.finish_reason) {
          streamFinishReason = c.finish_reason;
        }

        // Handle reasoning content for thinking models (only if thinking is enabled)
        if (thinkingEnabled && (c.delta as any).reasoning_content) {
          if (!isInThinkingBlock) {
            isInThinkingBlock = true;
            streamedText[c.index] = '<think>' + (c.delta as any).reasoning_content;
          } else {
            streamedText[c.index] = (c.delta as any).reasoning_content;
          }
          return;
        }

        // Handle end of reasoning content
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

      // Emit accum + this turn's running tokens so wrappedOnChunk
      // (assign-not-add) ends each turn at the cumulative cross-turn total.
      const normalizedFinishReason = normalizeOpenAIFinishReason(streamFinishReason);
      await callback(streamedText, {
        inputTokens: accumInputTokens + inputTokens,
        outputTokens: accumOutputTokens + outputTokens,
        toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
        ...(normalizedFinishReason ? { stopReason: normalizedFinishReason } : {}),
      });
    }

    // Extract cache stats after streaming completes (xAI caching is automatic)
    let cacheStats: CacheUsageStats | undefined;
    if (cacheStrategy?.enableCaching && inputTokens > 0) {
      const adapter = getCachingAdapter(ModelBackend.XAI);
      // Create a response object with usage info for cache stats extraction
      const mockResponse = {
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          // Use the cached tokens captured from streaming chunks
          cached_prompt_tokens: cachedTokensFromStream,
        },
      };
      cacheStats = adapter.extractCacheStats(mockResponse, model);

      if (cacheStats) {
        logCacheStats(this.logger, cacheStats, { streaming: true });
      }
    }

    // Best-effort response_format on streaming path with no tool calls:
    // emit a final empty cb so the SSE consumer sees responseFormatMode on the
    // last frame. The per-chunk cb above already delivered the JSON content.
    if (bestEffortFormat && func.length === 0) {
      await callback([], {
        inputTokens: accumInputTokens + inputTokens,
        outputTokens: accumOutputTokens + outputTokens,
        toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
        responseFormatMode: 'best-effort',
      });
    }

    if (func.length > 0) {
      // Track all tool usage first (allow empty parameters)
      for await (const tool of func) {
        const { name, parameters, id } = tool;
        if (name) {
          toolsUsed.push({
            name,
            arguments: parameters || '{}',
            id,
          });
        }
      }

      // Check if we should execute tools or just report them
      if (options.executeTools !== false) {
        // Resolve all executable function tool calls
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
            const parsedParams = JSON.parse(parameters);
            resolvedTools.push({ id, name, parameters, parsedParams, toolFn });
          } catch {
            this.logger.warn(`JSON parse error for ${name} arguments (streaming)`);
            const entry = toolsUsed.find(t => t.name === name && t.id === id);
            if (entry) entry.arguments = '{}';
          }
        }

        // Execute tools - parallel by default, sequential when opted out
        const parallelEnabled = options.parallelToolExecution !== false;

        type ToolPayloadStream = { id: string; name: string; parameters: string; result: { toString(): string } };

        this.logger.debug('[Tool Execution] Executing tools (xAI streaming)', {
          mode: parallelEnabled && resolvedTools.length > 1 ? 'parallel' : 'sequential',
          toolNames: resolvedTools.map(t => t.name),
        });

        const batchOutcomesStream = await executeToolsBatch<ToolPayloadStream>(
          resolvedTools.map(({ id, name, parameters, parsedParams, toolFn }) => async () => {
            const result = await toolFn(parsedParams);
            return { id, name, parameters, result };
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

        // Inject results in original order
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

        // Keep tools available for all tool types to enable chaining
        // The MAX_TOOL_CALLS limit prevents infinite loops.
        // Carry this turn's tokens forward so the terminal recursive call
        // emits the full multi-turn billable total to cb.
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
            },
          },
          callback,
          toolsUsed
        );
      } else {
        // New behavior: just pass tool calls through callback, don't execute.
        // Terminal leaf - emit accumulated total plus this turn's tokens.
        this.logger.debug(`[Tool Execution] executeTools=false, passing tool calls to callback`);
        await callback([null], {
          inputTokens: accumInputTokens + inputTokens,
          outputTokens: accumOutputTokens + outputTokens,
          toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
        });
      }
    }
  }

  private formatMessages(messages: IMessage[]): OpenAI.ChatCompletionMessageParam[] {
    // Convert B4M standard format (tool_use/tool_result) to OpenAI format (tool_calls/role:tool)
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
    } as unknown as IMessage);

    this.logger.log('PUSHED TOOL MESSAGES:', messages);
  }

  /**
   * Check if the current model supports thinking/reasoning
   * Uses the model's can_think property from model info
   */
  async modelSupportsThinking(model: string): Promise<boolean> {
    const modelInfo = await this.getModelInfo();
    const currentModelInfo = modelInfo.find(m => m.id === model);
    return currentModelInfo?.can_think === true;
  }
}
