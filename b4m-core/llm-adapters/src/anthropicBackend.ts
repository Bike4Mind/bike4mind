import { Anthropic, RateLimitError } from '@anthropic-ai/sdk';
import type {
  MessageCreateParamsBase,
  ContentBlock,
  RawMessageStreamEvent,
  Tool,
  MessageParam,
} from '@anthropic-ai/sdk/resources/messages';
import { CloudWatchClient, PutMetricDataCommand, StandardUnit } from '@aws-sdk/client-cloudwatch';
import {
  ChatModels,
  IMessage,
  MessageContentText,
  ModelBackend,
  NO_TEMPERATURE_MODELS,
  PermissionDeniedError,
  REFUSAL_FALLBACK_MODELS,
  type ModelInfo,
} from '@bike4mind/common';
import { executeToolsBatch } from './executeToolsBatch';
import {
  CompletionInfo,
  DEFAULT_MAX_TOOL_CALLS,
  IChoiceEndToolUse,
  ICompletionBackend,
  ICompletionOptionTools,
  ICompletionOptions,
  replaceLastToolResultObservationCanonical,
  getLatestToolCallIdCanonical,
} from './backend';
import { Logger } from '@bike4mind/observability';
import { handleToolResultStreaming } from './toolStreamingHelper';
import { ensureToolPairingIntegrity, stripAllToolBlocks } from './toolPairingUtils';
import { getCachingAdapter, logCacheStats } from './caching/adapters';
import { withRetry, isUserInitiatedAbort, isRetryableError } from '@bike4mind/common';
import { buildThinkingParams, type ThinkingConfig } from './thinkingParams';
import { acquireSlot, releaseSlot } from './_anthropicSemaphore';

type ExtendedMessageCreateParams = MessageCreateParamsBase &
  Partial<ThinkingConfig> & {
    output_config?: { effort: 'high' | 'medium' | 'low' };
  };

interface ToolUseEvent {
  type: 'tool_use';
  name: string;
  input: Record<string, unknown>;
  id: string;
}

const TEMPERATURE_ONLY_MODELS = [
  ChatModels.CLAUDE_4_5_SONNET,
  ChatModels.CLAUDE_4_1_OPUS,
  ChatModels.CLAUDE_4_5_HAIKU,
  ChatModels.CLAUDE_4_5_OPUS,
  ChatModels.CLAUDE_4_6_SONNET,
  ChatModels.CLAUDE_4_6_OPUS,
];

// Timeout constants for detecting streaming hangs (known anthropic-sdk streaming-hang bug)
const INITIAL_TIMEOUT_MS = 30000; // 30s to first event
const DEFAULT_IDLE_TIMEOUT_MS = 90000; // 90s between events for standard models
const THINKING_IDLE_TIMEOUT_MS = 180000; // 180s for thinking models (can pause during extended thinking)
const REQUEST_TIMEOUT_MS = 60000; // 60s timeout for the initial API request before any streaming starts
const SLOW_MODEL_REQUEST_TIMEOUT_MS = 120000; // 120s for slow/opus-class models that need longer to begin streaming

/**
 * Accumulated multi-turn cache token total. Undefined when zero so turns
 * without cache activity keep the pre-cache callback shape.
 */
const totalCacheTokens = (accum: number, turn: number | undefined): number | undefined => {
  const total = accum + (turn || 0);
  return total > 0 ? total : undefined;
};

export class AnthropicBackend implements ICompletionBackend {
  private _api: Anthropic;
  private logger: Logger;
  public currentModel: string = '';
  private lastAssistantContent: ContentBlock[] = []; // Store the complete assistant message content for tool use
  private isThinkingEnabled: boolean = false; // Track if thinking is enabled for current request
  // Opaque, non-PII end-user identifier forwarded as `metadata.user_id` so
  // Anthropic can attribute abuse to an individual user and scope enforcement
  // to them rather than the whole shared platform key. See `toProviderEndUserId`.
  private readonly _endUserId?: string;

  constructor(apiKey: string, logger?: Logger, endUserId?: string) {
    // Increase maxRetries from default (2) to 5 for better rate limit handling.
    // The SDK has built-in exponential backoff (500ms initial, 8s max, 25% jitter)
    // and respects Retry-After headers from 429 responses.
    // Custom fetch wrapper retries on transport-level TLS errors (TypeError: terminated)
    // which bypass the SDK's built-in HTTP retry logic.
    const retryFetch: typeof fetch = async (input, init) => {
      const MAX_TRANSPORT_RETRIES = 2;
      for (let attempt = 0; attempt <= MAX_TRANSPORT_RETRIES; attempt++) {
        try {
          return await fetch(input, init);
        } catch (err) {
          const msg = err instanceof Error ? err.message : '';
          const isTransportError = err instanceof TypeError && (msg === 'terminated' || msg === 'fetch failed');
          if (!isTransportError || attempt === MAX_TRANSPORT_RETRIES) throw err;
          this.logger.warn(
            `[AnthropicBackend] Transport error "${msg}", retry ${attempt + 1}/${MAX_TRANSPORT_RETRIES}`
          );
          await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempt)));
        }
      }
      throw new TypeError('terminated');
    };
    this._api = new Anthropic({ apiKey, maxRetries: 5, fetch: retryFetch });
    this.logger = logger ?? new Logger();
    this._endUserId = endUserId;
  }

  /**
   * Emit a CloudWatch metric when a rate limit error occurs.
   * @param model - The model that triggered the rate limit
   * @param featureArea - The feature area (mcp-tools, chat, built-in-tools, etc.) for filtering
   */
  private async emitRateLimitMetric(model: string, featureArea: string = 'unknown'): Promise<void> {
    try {
      const client = new CloudWatchClient({
        region: process.env.AWS_REGION || 'us-east-2',
      });

      const command = new PutMetricDataCommand({
        Namespace: 'Lumina5/AnthropicAPI',
        MetricData: [
          {
            MetricName: 'RateLimitError',
            Value: 1,
            Unit: StandardUnit.Count,
            Timestamp: new Date(),
            Dimensions: [
              { Name: 'Model', Value: model },
              // SEED_STAGE_NAME is set via DEFAULT_LAMBDA_ENVIRONMENT in infra/constants.ts
              // and maps to $app.stage. The alarm in infra/alarms.ts filters by Stage dimension.
              // Fallback to 'local' for non-Lambda contexts (local dev, tests).
              { Name: 'Stage', Value: process.env.SEED_STAGE_NAME || 'local' },
              // Feature area helps identify which feature is causing rate limits
              { Name: 'FeatureArea', Value: featureArea },
            ],
          },
        ],
      });

      await client.send(command);
      this.logger.info('[AnthropicBackend] Emitted RateLimitError metric to CloudWatch', { model, featureArea });
    } catch (metricsError) {
      // Log but don't throw - metrics failures shouldn't break the application
      this.logger.warn('[AnthropicBackend] Failed to emit CloudWatch metric', {
        error: metricsError instanceof Error ? metricsError.message : String(metricsError),
      });
    }
  }

  /**
   * Emit a CloudWatch metric when a stream idle timeout occurs.
   */
  private async emitIdleTimeoutMetric(model: string, toolCount: number, eventCount: number): Promise<void> {
    try {
      const client = new CloudWatchClient({
        region: process.env.AWS_REGION || 'us-east-2',
      });

      const command = new PutMetricDataCommand({
        Namespace: 'Lumina5/LLMStreaming',
        MetricData: [
          {
            MetricName: 'StreamIdleTimeoutTriggered',
            Value: 1,
            Unit: StandardUnit.Count,
            Timestamp: new Date(),
            Dimensions: [
              { Name: 'Model', Value: model },
              { Name: 'Stage', Value: process.env.SEED_STAGE_NAME || 'local' },
            ],
          },
        ],
      });

      await client.send(command);
      this.logger.info('[AnthropicBackend] Emitted StreamIdleTimeoutTriggered metric to CloudWatch', {
        model,
        toolCount,
        eventCount,
      });
    } catch (metricsError) {
      // Log but don't throw - metrics failures shouldn't break the application
      this.logger.warn('[AnthropicBackend] Failed to emit idle timeout CloudWatch metric', {
        error: metricsError instanceof Error ? metricsError.message : String(metricsError),
      });
    }
  }

  /**
   * Get thinking blocks from the last assistant content.
   * Filters to only include thinking/redacted_thinking blocks.
   * Returns undefined if thinking is disabled or no blocks are present.
   */
  private getThinkingBlocks(): unknown[] | undefined {
    if (!this.isThinkingEnabled) return undefined;
    const blocks = this.lastAssistantContent.filter(
      block => block.type === 'thinking' || block.type === 'redacted_thinking'
    );
    return blocks.length > 0 ? blocks : undefined;
  }

  async getModelInfo(): Promise<ModelInfo[]> {
    return [
      {
        id: ChatModels.CLAUDE_3_OPUS,
        type: 'text',
        name: 'Claude 3 Opus',
        backend: ModelBackend.Anthropic,
        contextWindow: 200000,
        supportsImageVariation: false,
        max_tokens: 4096,
        can_stream: true,
        pricing: {
          200000: { input: 15 / 1000000, output: 75 / 1000000 }, // $15 / 1M Input tokens, $75 / 1M Output tokens
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 4,
        trainingCutoff: '2023-08-01',
        deprecationDate: '2025-06-30',
        description:
          "Anthropic's top-tier Claude 3 model with exceptional reasoning and analysis capabilities. Best for research and complex intellectual tasks.",
        isSlowModel: true,
      },
      {
        id: ChatModels.CLAUDE_3_5_HAIKU_ANTHROPIC,
        type: 'text',
        name: 'Claude 3.5 Haiku',
        backend: ModelBackend.Anthropic,
        contextWindow: 200000,
        supportsImageVariation: false,
        max_tokens: 8192,
        can_stream: true,
        pricing: {
          200000: { input: 0.8 / 1000000, output: 4.0 / 1000000 }, // $0.80 / 1M Input tokens, $4.00 / 1M Output tokens
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 5,
        supportsTools: true,
        trainingCutoff: '2024-07-01',
        deprecationDate: '2026-02-19',
        description:
          "Anthropic's fast and efficient Claude 3.5 Haiku model with improved reasoning capabilities. Cost-effective for high-volume tasks.",
      },
      {
        id: ChatModels.CLAUDE_3_5_SONNET_ANTHROPIC,
        type: 'text',
        name: 'Claude 3.5 Sonnet',
        backend: ModelBackend.Anthropic,
        supportsImageVariation: false,
        contextWindow: 200000,
        max_tokens: 8192,
        can_stream: true,
        pricing: {
          200000: { input: 3 / 1000000, output: 15 / 1000000 }, // $3.00 / 1M Input tokens, $15.00 / 1M Output tokens
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 2,
        supportsTools: true,
        trainingCutoff: '2024-04-01',
        deprecationDate: '2025-10-22',
        description:
          "Anthropic's balanced Claude 3.5 Sonnet model with enhanced capabilities and improved reasoning. Great all-around performance.",
      },
      {
        id: ChatModels.CLAUDE_3_7_SONNET_ANTHROPIC,
        type: 'text',
        name: 'Claude 3.7 Sonnet',
        backend: ModelBackend.Anthropic,
        contextWindow: 200000,
        supportsImageVariation: false,
        max_tokens: 8192,
        can_stream: true,
        can_think: true,
        pricing: {
          200000: { input: 3 / 1000000, output: 15 / 1000000 }, // $3.00 / 1M Input tokens, $15.00 / 1M Output tokens
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 1,
        supportsTools: true,
        trainingCutoff: '2024-11-01',
        deprecationDate: '2025-10-28',
        description:
          "Anthropic's highly capable Claude 3.7 model with excellent reasoning and tool use. Great for complex tasks requiring nuanced understanding.",
      },
      {
        id: ChatModels.CLAUDE_4_OPUS,
        type: 'text',
        name: 'Claude 4 Opus',
        backend: ModelBackend.Anthropic,
        contextWindow: 200000,
        max_tokens: 32000,
        can_stream: true,
        can_think: true,
        pricing: {
          200000: {
            input: 15 / 1000000, // $15 per 1M input tokens
            output: 75 / 1000000, // $75 per 1M output tokens
          },
        },
        supportsVision: true,
        supportsTools: true,
        supportsImageVariation: false,
        logoFile: 'Anthropic_logo.png',
        rank: 1, // premium tier - ranked below the Sonnet 4.6 default (opt-in via picker)
        trainingCutoff: '2024-10-01',
        releaseDate: '2025-05-23',
        description:
          "Anthropic's most advanced Claude 4 model with hybrid reasoning and frontier intelligence. Excellent for coding, agentic search, and creative writing.",
        isSlowModel: true,
      },
      {
        id: ChatModels.CLAUDE_4_1_OPUS,
        type: 'text',
        name: 'Claude 4.1 Opus',
        backend: ModelBackend.Anthropic,
        supportsImageVariation: false,
        contextWindow: 200000,
        max_tokens: 32000,
        can_stream: true,
        can_think: true,
        pricing: {
          200000: { input: 15 / 1000000, output: 75 / 1000000 }, // $15 / 1M Input tokens, $75 / 1M Output tokens
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 1, // premium tier - ranked below the Sonnet 4.6 default (opt-in via picker)
        supportsTools: true,
        trainingCutoff: '2025-08-01',
        releaseDate: '2025-08-06',
        description: 'Claude 4.1 Opus with Anthropic. Iteration with improved performance and reliability.',
        isSlowModel: true,
      },
      {
        id: ChatModels.CLAUDE_4_SONNET,
        type: 'text',
        name: 'Claude 4 Sonnet',
        backend: ModelBackend.Anthropic,
        contextWindow: 200000,
        max_tokens: 16384,
        can_stream: true,
        can_think: true,
        pricing: {
          200000: {
            input: 3 / 1000000, // $3 per 1M input tokens
            output: 15 / 1000000, // $15 per 1M output tokens
          },
        },
        supportsVision: true,
        supportsTools: true,
        supportsImageVariation: false,
        logoFile: 'Anthropic_logo.png',
        rank: 1,
        trainingCutoff: '2024-10-01',
        releaseDate: '2025-05-23',
        // Retired upstream by Anthropic - the dated snapshot claude-sonnet-4-20250514 no longer
        // accepts completions and returns a legacy-model error. A past deprecationDate hides it
        // from the picker; resolveDeprecatedModelId upgrades any session/agent still pinned to it.
        deprecationDate: '2026-06-01',
        description:
          "Anthropic's high-performance Claude 4 model optimized for balanced speed and capability. Excellent for coding and production workloads.",
      },
      {
        id: ChatModels.CLAUDE_4_5_SONNET,
        type: 'text',
        name: 'Claude 4.5 Sonnet',
        backend: ModelBackend.Anthropic,
        contextWindow: 200000,
        max_tokens: 16384,
        can_stream: true,
        can_think: true,
        pricing: {
          200000: {
            input: 3 / 1000000, // $3 per 1M input tokens
            output: 15 / 1000000, // $15 per 1M output tokens
          },
        },
        supportsVision: true,
        supportsTools: true,
        supportsImageVariation: false,
        logoFile: 'Anthropic_logo.png',
        rank: 1,
        trainingCutoff: '2025-07-01',
        releaseDate: '2025-09-30',
        description:
          "Anthropic's most intelligent model in the Claude 4 family. Delivers exceptional performance across coding, analysis, and complex reasoning tasks with improved speed and efficiency. Ideal for production workloads requiring both power and reliability.",
      },
      {
        id: ChatModels.CLAUDE_4_5_HAIKU,
        type: 'text',
        name: 'Claude 4.5 Haiku',
        backend: ModelBackend.Anthropic,
        contextWindow: 200000,
        max_tokens: 64000,
        can_stream: true,
        can_think: true,
        pricing: {
          200000: { input: 1 / 1_000_000, output: 5 / 1_000_000 }, // $1 / 1M Input tokens, $5 / 1M Output tokens
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 1,
        supportsTools: true,
        trainingCutoff: '2025-07-01',
        releaseDate: '2025-10-16',
        description: 'Claude 4.5 Haiku with Anthropic. Latest iteration with the fastest performance and reliability.',
        supportsImageVariation: false,
      },
      {
        id: ChatModels.CLAUDE_4_5_OPUS,
        type: 'text',
        name: 'Claude 4.5 Opus',
        backend: ModelBackend.Anthropic,
        supportsImageVariation: false,
        contextWindow: 200000,
        max_tokens: 64000,
        can_stream: true,
        can_think: true,
        pricing: {
          200000: { input: 5 / 1000000, output: 25 / 1000000 }, // $5 / 1M Input tokens, $25 / 1M Output tokens
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 1,
        supportsTools: true,
        trainingCutoff: '2025-07-01',
        releaseDate: '2025-11-25',
        description:
          'Claude 4.5 Opus with Anthropic. Top-tier extended thinking model with excellent performance for complex reasoning, coding, and creative tasks.',
        isSlowModel: true,
      },
      {
        id: ChatModels.CLAUDE_4_6_SONNET,
        type: 'text',
        name: 'Claude 4.6 Sonnet',
        backend: ModelBackend.Anthropic,
        contextWindow: 200000,
        max_tokens: 16384,
        can_stream: true,
        can_think: true,
        pricing: {
          200000: {
            input: 3 / 1000000, // $3 per 1M input tokens
            output: 15 / 1000000, // $15 per 1M output tokens
          },
        },
        supportsVision: true,
        supportsTools: true,
        supportsImageVariation: false,
        logoFile: 'Anthropic_logo.png',
        rank: 1, // demoted below Sonnet 5 (the new default) - opt-in via picker
        trainingCutoff: '2025-10-01',
        releaseDate: '2026-02-19',
        description:
          "Anthropic's Claude 4.6 Sonnet model. Delivers enhanced performance across coding, analysis, and complex reasoning tasks with improved speed and efficiency.",
      },
      {
        id: ChatModels.CLAUDE_5_SONNET,
        type: 'text',
        name: 'Claude 5 Sonnet',
        backend: ModelBackend.Anthropic,
        contextWindow: 1_000_000,
        max_tokens: 128_000,
        can_stream: true,
        can_think: true,
        thinkingStyle: 'adaptive',
        pricing: {
          1_000_000: {
            input: 3 / 1_000_000, // $3 per 1M input tokens
            output: 15 / 1_000_000, // $15 per 1M output tokens
          },
        },
        supportsVision: true,
        supportsTools: true,
        supportsImageVariation: false,
        logoFile: 'Anthropic_logo.png',
        rank: 0, // new default workhorse tier
        trainingCutoff: '2026-01-01',
        releaseDate: '2026-07-01',
        description:
          "Anthropic's newest Claude 5 Sonnet model. Near-Opus quality on coding and agentic work at Sonnet cost, with adaptive extended thinking and a 1M-token context window.",
      },
      {
        id: ChatModels.CLAUDE_4_6_OPUS,
        type: 'text',
        name: 'Claude 4.6 Opus',
        backend: ModelBackend.Anthropic,
        supportsImageVariation: false,
        contextWindow: 1_000_000,
        max_tokens: 128_000,
        can_stream: true,
        can_think: true,
        pricing: {
          1_000_000: { input: 5 / 1000000, output: 25 / 1000000 }, // $5 / 1M Input tokens, $25 / 1M Output tokens
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 1, // premium tier - ranked below the Sonnet 4.6 default (opt-in via picker)
        supportsTools: true,
        trainingCutoff: '2025-08-01',
        releaseDate: '2026-02-06',
        description:
          "Anthropic's earlier flagship model. Claude 4.6 Opus delivers frontier intelligence with extended thinking, coding, and agentic capabilities.",
        isSlowModel: true,
      },
      {
        id: ChatModels.CLAUDE_4_7_OPUS,
        type: 'text',
        name: 'Claude 4.7 Opus',
        backend: ModelBackend.Anthropic,
        supportsImageVariation: false,
        contextWindow: 1_000_000,
        max_tokens: 128_000,
        can_stream: true,
        can_think: true,
        thinkingStyle: 'adaptive',
        pricing: {
          1_000_000: { input: 5 / 1_000_000, output: 25 / 1_000_000 }, // $5 / 1M Input tokens, $25 / 1M Output tokens
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 1, // premium tier - ranked below the Sonnet 4.6 default (opt-in via picker)
        supportsTools: true,
        trainingCutoff: '2026-01-31',
        releaseDate: '2026-04-17',
        description:
          "Anthropic's previous flagship model. Claude 4.7 Opus delivers frontier intelligence with extended thinking, coding, and agentic capabilities.",
        isSlowModel: true,
      },
      {
        id: ChatModels.CLAUDE_4_8_OPUS,
        type: 'text',
        name: 'Claude 4.8 Opus',
        backend: ModelBackend.Anthropic,
        supportsImageVariation: false,
        contextWindow: 1_000_000,
        max_tokens: 128_000,
        can_stream: true,
        can_think: true,
        thinkingStyle: 'adaptive',
        pricing: {
          1_000_000: { input: 5 / 1_000_000, output: 25 / 1_000_000 }, // $5 / 1M Input tokens, $25 / 1M Output tokens
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 1, // premium tier - ranked below the Sonnet 4.6 default (opt-in via picker)
        supportsTools: true,
        trainingCutoff: '2026-01-01',
        releaseDate: '2026-05-28',
        description:
          "Anthropic's latest flagship model. Claude 4.8 Opus delivers enhanced frontier intelligence with improved extended thinking, coding, and agentic capabilities over 4.7.",
        isSlowModel: true,
      },
      {
        id: ChatModels.CLAUDE_FABLE_5,
        type: 'text',
        name: 'Claude Fable 5',
        backend: ModelBackend.Anthropic,
        supportsImageVariation: false,
        contextWindow: 1_000_000,
        max_tokens: 128_000,
        can_stream: true,
        can_think: true,
        thinkingStyle: 'adaptive',
        pricing: {
          1_000_000: { input: 10 / 1_000_000, output: 50 / 1_000_000 }, // $10 / 1M Input tokens, $50 / 1M Output tokens
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 1, // premium tier - opt-in via the picker, not the default workhorse tier
        supportsTools: true,
        trainingCutoff: '2026-01-01',
        releaseDate: '2026-07-01',
        description:
          "Anthropic's most capable model, built for complex, long-running asynchronous tasks. Sustains days-long agentic work and delivers notably stronger vision than prior Claude models.",
        isSlowModel: true,
        // GA as of 2026-07-01 ("Claude Fable 5 is once again available"). Previously gated
        // behind Fable/Mythos access this deployment's key lacked; access has since
        // been granted, so the model is now selectable. Its safety classifiers can return
        // stop_reason: 'refusal' on benign requests - those are routed to Opus 4.8 via the
        // existing fallback machinery (see REFUSAL_FALLBACK_MODELS + the refusal throw below).
      },
    ];
  }

  // Request a chat-based completion from the LLM.  The response is delivered
  // by calling the caller-provided `cb()`.  It may be called once if the reply
  // is delivered as a single response, or may come in chunks, if streaming, with
  // each chunk being the additional new text generated by the model.
  // Caller should await this function to ensure the completion is complete. Any
  // errors will be thrown.
  public async complete(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>,
    cb: (text: (string | null | undefined)[], completionInfo: CompletionInfo) => Promise<void>,
    toolsUsed: Array<{ name: string; arguments?: string; id?: string }> = []
  ): Promise<void> {
    this.currentModel = model;
    options = {
      temperature: 0.9,
      ...options,
    };

    // Tool chaining safeguard: Track and limit recursive tool calls
    const toolCallCount = options._internal?.toolCallCount ?? 0;

    // Multi-turn token accumulators. Each Anthropic API call (every recursive
    // tool round-trip) is billed independently, so we add each turn's usage
    // and emit the running total on the terminal callback. Non-terminal cb
    // calls intentionally omit usage to avoid clobbering the total via the
    // assign-not-add pattern in cliCompletions' wrappedOnChunk.
    const accumInputTokens = options._internal?.accumInputTokens ?? 0;
    const accumOutputTokens = options._internal?.accumOutputTokens ?? 0;
    const accumCacheReadTokens = options._internal?.accumCacheReadTokens ?? 0;
    const accumCacheWriteTokens = options._internal?.accumCacheWriteTokens ?? 0;

    // Check if we've exceeded the tool call limit (only when there are tools to execute).
    // Honor a per-request override (a surface-set, admin-tunable maxToolCalls); else the default.
    const maxToolCalls = options._internal?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    if (toolCallCount >= maxToolCalls && options.tools?.length) {
      // Log with full context for ops visibility
      const mcpTools = options.tools?.filter((t: ICompletionOptionTools) => t._isMcpTool) || [];
      const builtInTools = options.tools?.filter((t: ICompletionOptionTools) => !t._isMcpTool) || [];
      this.logger.warn(
        `⚠️ Max tool calls limit (${maxToolCalls}) reached. Disabling tools to prevent infinite loops.`,
        {
          model,
          toolCallCount,
          toolsUsedSoFar: toolsUsed.map(t => t.name),
          availableToolCount: options.tools?.length || 0,
          mcpToolCount: mcpTools.length,
          mcpToolNames: mcpTools.map((t: ICompletionOptionTools) => t.toolSchema.name).slice(0, 10),
          builtInToolCount: builtInTools.length,
          builtInToolNames: builtInTools.map((t: ICompletionOptionTools) => t.toolSchema.name).slice(0, 10),
          messageCount: messages.length,
        }
      );
      // Remove tools when limit is hit and continue, but preserve timeout settings
      // Don't increment toolCallCount so subsequent no-tool calls skip this check
      await this.complete(
        model,
        messages,
        {
          ...options,
          tools: undefined,
          // Reset a caller-forced tool_choice to 'auto' on recursion so it can't
          // persist past the first turn. (Tools are dropped here and tool_choice is
          // only applied when tools are present, so this is just an explicit invariant.)
          tool_choice: 'auto',
          _internal: {
            ...options._internal, // Preserve enableIdleTimeout, idleTimeoutMs
            // Keep toolCallCount at the limit - no need to increment when tools are removed
          },
        },
        cb,
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

    // Per-message cache flag: pre-process the original messages so the
    // cache_control attaches BEFORE filterRelevantMessages / sanitization runs.
    // This is the only place the original IMessage[] is still intact - once we
    // hand off to filterRelevantMessages, sanitizeMessageContent may clone the
    // message (`{ ...message, content: sanitizedContent }`), which would defeat
    // a reference-based mapping back to the original cache flag.
    const anyUserOrAssistantCacheControlled = messages.some(
      m => m.cache === true && (m.role === 'user' || m.role === 'assistant')
    );
    const anySystemCacheControlled = messages.some(m => m.cache === true && m.role === 'system');
    const anyMessageCacheControlled = anyUserOrAssistantCacheControlled || anySystemCacheControlled;

    const cacheStampedMessages: IMessage[] = anyUserOrAssistantCacheControlled
      ? messages.map(m => {
          if (m.cache !== true || m.role === 'system') return m;
          const content = m.content;
          if (typeof content === 'string') {
            return {
              ...m,
              content: [
                { type: 'text', text: content, cache_control: { type: 'ephemeral' } },
              ] as unknown as IMessage['content'],
            };
          }
          if (Array.isArray(content) && content.length > 0) {
            const cloned = content.map((b, i) =>
              i === content.length - 1
                ? ({
                    ...(b as unknown as Record<string, unknown>),
                    cache_control: { type: 'ephemeral' },
                  } as unknown as typeof b)
                : b
            );
            return { ...m, content: cloned as IMessage['content'] };
          }
          return m;
        })
      : messages;

    // Build the system parameter. When any system message has `cache: true`,
    // emit Anthropic's array-of-blocks form so we can attach cache_control to
    // the cached block (Anthropic's API accepts either string or array). We
    // append the model-identity reminder as a separate uncached block to keep
    // the cached prefix stable across requests (otherwise the suffix would
    // bust the cache key on every model identifier change).
    const identityReminder = `IMPORTANT! Only when someone asks, remember that you are specifically the ${model} model.`;
    let system: string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
    if (anySystemCacheControlled) {
      const systemMessages = messages.filter(m => m.role === 'system');
      const blocks: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> = [];
      for (const sm of systemMessages) {
        const text = typeof sm.content === 'string' ? sm.content : JSON.stringify(sm.content);
        if (sm.cache === true) {
          blocks.push({ type: 'text', text, cache_control: { type: 'ephemeral' } });
        } else {
          blocks.push({ type: 'text', text });
        }
      }
      blocks.push({ type: 'text', text: identityReminder });
      system = blocks.length > 0 ? blocks : identityReminder;
    } else {
      const joined = this.consolidateSystemMessages(messages);
      system = joined ? `${joined}\n${identityReminder}` : identityReminder;
    }

    // Ensure tool_use/tool_result pairing integrity after filterRelevantMessages.
    // filterRelevantMessages can break pairs by merging consecutive same-role messages
    // or removing messages via sanitizeMessageContent. This is a defense-in-depth
    // measure alongside the integrity check in buildAndSortMessages.
    let filteredMessages = ensureToolPairingIntegrity(this.filterRelevantMessages(cacheStampedMessages), this.logger);

    // Pre-API diagnostic: count tool blocks before sending
    const countToolBlocks = (msgs: IMessage[]) => {
      let useCount = 0;
      let resultCount = 0;
      for (const msg of msgs) {
        if (!Array.isArray(msg.content)) continue;
        for (const b of msg.content as Array<{ type?: string }>) {
          if (b.type === 'tool_use') useCount++;
          if (b.type === 'tool_result') resultCount++;
        }
      }
      return { useCount, resultCount };
    };

    let { useCount: toolUseCount, resultCount: toolResultCount } = countToolBlocks(filteredMessages);

    if (toolUseCount > 0 || toolResultCount > 0) {
      this.logger.debug(
        `[Pre-API #6181] Sending ${filteredMessages.length} messages with ${toolUseCount} tool_use and ${toolResultCount} tool_result blocks`
      );
      if (toolUseCount !== toolResultCount) {
        this.logger.warn(
          `[Pre-API #6181] Tool block mismatch! tool_use: ${toolUseCount}, tool_result: ${toolResultCount}. Attempting auto-repair...`
        );

        // Re-run integrity check (catches adjacency issues missed on first pass)
        filteredMessages = ensureToolPairingIntegrity(filteredMessages, this.logger);
        ({ useCount: toolUseCount, resultCount: toolResultCount } = countToolBlocks(filteredMessages));

        if (toolUseCount !== toolResultCount) {
          // Last resort: strip all tool blocks to prevent API error
          this.logger.warn(
            `[Pre-API #6181] Auto-repair insufficient (tool_use: ${toolUseCount}, tool_result: ${toolResultCount}). Stripping all tool blocks.`
          );
          filteredMessages = stripAllToolBlocks(filteredMessages, this.logger);
        }
      }
    }

    const apiParams: ExtendedMessageCreateParams = {
      model,
      max_tokens: options.maxTokens ?? 4096,
      messages: filteredMessages.map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        // Preserve the content structure - it can be string or MessageContentObject[].
        // Per-message cache stamping happened in `cacheStampedMessages` above; the
        // cache_control survives sanitization because it's part of the content blocks.
        // Internal message content (string | MessageContentObject[]) is structurally
        // the SDK's accepted content shape; widen to it at this API boundary.
        content: m.content as unknown as MessageParam['content'],
      })),
      // Claude 4.7 Opus does not accept temperature at all
      ...(NO_TEMPERATURE_MODELS.has(model) ? {} : { temperature: options.temperature }),
      // top_p and temperature together is not supported for claude-4-5-sonnet and claude-opus-4-1, use temp only
      ...(TEMPERATURE_ONLY_MODELS.includes(model as ChatModels) || NO_TEMPERATURE_MODELS.has(model)
        ? {}
        : { top_p: options.topP }),
      stop_sequences: options.stop_sequences,
      stream: options.stream,
      // Cast: SDK's `system` accepts both string and array-of-blocks; TS narrows
      // to one or the other depending on input type, so widen here.
      system: system as ExtendedMessageCreateParams['system'],
      // claude-3-7 and the no-sampling-param models (Opus 4.7+, Fable 5) reject top_k - return 400
      ...(model.includes('claude-3-7') || NO_TEMPERATURE_MODELS.has(model) ? {} : { top_k: options.topK }),
      ...(options.tools?.length ? { tools: this.formatTools(options.tools) } : {}),
      // Attribute the request to the end user (opaque, non-PII) so Anthropic can
      // scope abuse enforcement to them instead of the shared platform key.
      // Applies to both the streaming and non-streaming messages.create() calls
      // below, which share this apiParams object.
      ...(this._endUserId ? { metadata: { user_id: this._endUserId } } : {}),
    };

    // Structured output via tool_use synthesis.
    // When response_format=json_schema is set, synthesize a single tool from
    // the schema and force tool_choice to that tool. The model then returns the
    // JSON object as the tool's `input` - guaranteed to match the schema.
    // Skip if the caller is already using their own tools (let those take
    // precedence; mixing forced-tool with executable tools can deadlock).
    const responseFormat = options.responseFormat;
    const usingResponseFormatToolUse = responseFormat?.type === 'json_schema' && !options.tools?.length;
    if (responseFormat) {
      this.logger.info(
        `[AnthropicBackend] response_format received: type=${responseFormat.type}, synthesizingToolUse=${usingResponseFormatToolUse}, callerTools=${options.tools?.length ?? 0}`
      );
    }
    if (usingResponseFormatToolUse && responseFormat.type === 'json_schema') {
      const schemaTool: Tool = {
        name: responseFormat.json_schema.name,
        ...(responseFormat.json_schema.description ? { description: responseFormat.json_schema.description } : {}),
        input_schema: responseFormat.json_schema.schema as Tool.InputSchema,
      };
      apiParams.tools = [schemaTool];
      apiParams.tool_choice = { type: 'tool', name: responseFormat.json_schema.name };
    }

    if (options.tools?.length) {
      apiParams.tools = this.formatTools(options.tools);

      // Add tool_choice if specified (convert from OpenAI format to Anthropic format)
      if (options.tool_choice) {
        if (options.tool_choice === 'auto') {
          apiParams.tool_choice = { type: 'auto' };
        } else if (options.tool_choice === 'required') {
          apiParams.tool_choice = { type: 'any' };
        } else if (typeof options.tool_choice === 'object' && options.tool_choice.function?.name) {
          apiParams.tool_choice = { type: 'tool', name: options.tool_choice.function.name };
        }
      }
    }

    // Per-request headers for the Anthropic SDK. Passed as the second
    // arg to messages.create() - body params (`apiParams`) cannot carry
    // headers. Prompt caching is GA so the beta header is no longer required
    // by current models, but we still send it; it's harmless on the wire
    // if Anthropic ignores unknown betas.
    const requestExtraHeaders: Record<string, string> | undefined = anyMessageCacheControlled
      ? { 'anthropic-beta': 'prompt-caching-2024-07-31' }
      : undefined;

    // Add thinking parameters for models that support it
    const modelInfo = await this.getModelInfo();
    const currentModelInfo = modelInfo.find(m => m.id === model);

    if (currentModelInfo?.can_think) {
      // questMaster / thinking are Anthropic-specific extras layered onto the generic
      // completion options; view them through a typed lens rather than `any`.
      const thinkingOptions = options as Partial<ICompletionOptions> & {
        questMaster?: boolean;
        thinking?: { enabled?: boolean; budget_tokens?: number };
      };
      const isQuestMaster = thinkingOptions.questMaster === true;
      const userThinkingEnabled = thinkingOptions.thinking?.enabled === true;

      if (userThinkingEnabled || isQuestMaster) {
        // Determine budget and effort based on context
        const budgetTokens = isQuestMaster
          ? Math.min(Math.floor((options.maxTokens ?? 8192) * 0.25), 4096)
          : (thinkingOptions.thinking?.budget_tokens ?? 16000);
        const effort = isQuestMaster ? ('medium' as const) : ('high' as const);

        const result = buildThinkingParams(model, currentModelInfo, budgetTokens, apiParams.max_tokens ?? 4096, effort);

        // Apply thinking config
        apiParams.thinking = result.thinkingConfig.thinking;
        if ('output_config' in result.thinkingConfig && result.thinkingConfig.output_config) {
          apiParams.output_config = result.thinkingConfig.output_config;
        }
        apiParams.max_tokens = result.maxTokens;

        // Apply temperature/top_p constraints
        if (result.temperature === 'delete') {
          delete apiParams.temperature;
        } else {
          apiParams.temperature = result.temperature;
        }
        delete apiParams.top_p;

        this.isThinkingEnabled = true;

        this.logger.debug(
          `[AnthropicBackend] ${isQuestMaster ? 'QuestMaster' : 'User'} thinking enabled (${currentModelInfo.thinkingStyle ?? 'legacy'}): max_tokens=${apiParams.max_tokens}, effort=${effort}`
        );
      } else {
        this.isThinkingEnabled = false;
      }
    } else {
      this.isThinkingEnabled = false;
    }

    // Apply prompt caching if enabled
    const cacheStrategy = options.cacheStrategy;
    if (cacheStrategy?.enableCaching) {
      const adapter = getCachingAdapter(ModelBackend.Anthropic);
      const cachedParams = adapter.applyCaching(apiParams as unknown as Record<string, unknown>, cacheStrategy);
      Object.assign(apiParams, cachedParams);

      this.logger.debug('[Anthropic] Applying cache control', {
        cacheSystemPrompt: cacheStrategy.cacheSystemPrompt,
        cacheTools: cacheStrategy.cacheTools,
        cacheHistory: cacheStrategy.cacheConversationHistory,
        cacheTTL: cacheStrategy.cacheTTL,
      });
    }

    // Setup the actual API call with API-specific options
    try {
      const func: { name?: string; id?: string; parameters?: string }[] = [];
      // Capture per-turn token usage so the post-stream tool-recursion site
      // can carry it forward as accumulated multi-turn billable usage.
      // Populated from the message_delta event inside the streaming Promise.
      let streamingTurnUsage:
        | {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          }
        | undefined;
      if (options.stream) {
        // Promise wrapper around the stream API
        await new Promise<void>((resolve, reject) => {
          // Request-level timeout: Abort if the API call itself hangs before streaming starts
          // This catches hangs that occur before any SSE events are received
          // Feature flag controlled via options._internal.enableRequestTimeout
          const enableRequestTimeout = options._internal?.enableRequestTimeout ?? false;
          const requestAbortController = new AbortController();
          let requestTimeout: ReturnType<typeof setTimeout> | undefined;
          const requestTimeoutMs = currentModelInfo?.isSlowModel ? SLOW_MODEL_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;

          if (enableRequestTimeout) {
            requestTimeout = setTimeout(() => {
              // WARN, not error: this is an expected, recoverable timeout (the user
              // gets a friendly "try again" reply) - logging at error severity trips
              // the CloudWatch ERROR->LiveOps/Slack alerting and pages on benign aborts.
              // The emitIdleTimeoutMetric below still tracks the trend.
              this.logger.warn('[AnthropicBackend] Request timeout - API call did not start streaming', {
                model,
                toolCount: options.tools?.length || 0,
                mcpToolCount: options.tools?.filter(t => (t as { _isMcpTool?: boolean })._isMcpTool).length || 0,
                timeoutMs: requestTimeoutMs,
              });
              // Fire and forget metric emission
              this.emitIdleTimeoutMetric(model, options.tools?.length || 0, 0).catch(() => {});
              requestAbortController.abort();
            }, requestTimeoutMs);
          }

          // Combine abort signals: user-provided signal + request timeout signal (if enabled)
          const combinedSignal = enableRequestTimeout
            ? options.abortSignal
              ? AbortSignal.any([options.abortSignal, requestAbortController.signal])
              : requestAbortController.signal
            : options.abortSignal;

          // Track idle timeout state at a scope accessible to catch block
          let isIdleTimeout = false;
          let idleTimeoutMsForError = 0; // Store for error message

          (async () => {
            // Acquire semaphore slot before the API call. Released in the finally
            // block below after the stream is fully consumed (or on any error),
            // so the slot accurately reflects the real Anthropic connection lifetime.
            await acquireSlot();
            try {
              // Diagnostic logging: Capture payload size to help debug hanging issues
              const payloadForSize = { ...apiParams, stream: true };
              const payloadSizeBytes = Buffer.byteLength(JSON.stringify(payloadForSize), 'utf8');
              const toolsSizeBytes = apiParams.tools ? Buffer.byteLength(JSON.stringify(apiParams.tools), 'utf8') : 0;
              const messagesSizeBytes = apiParams.messages
                ? Buffer.byteLength(JSON.stringify(apiParams.messages), 'utf8')
                : 0;

              this.logger.info('[AnthropicBackend] API request payload diagnostics', {
                model,
                totalPayloadSizeKB: Math.round(payloadSizeBytes / 1024),
                toolsSizeKB: Math.round(toolsSizeBytes / 1024),
                messagesSizeKB: Math.round(messagesSizeBytes / 1024),
                toolCount: apiParams.tools?.length || 0,
                messageCount: apiParams.messages?.length || 0,
                mcpToolCount: options.tools?.filter((t: ICompletionOptionTools) => t._isMcpTool).length || 0,
                hasThinking: !!apiParams.thinking,
                thinkingType: apiParams.thinking?.type,
                thinkingBudget: apiParams.thinking?.type === 'enabled' ? apiParams.thinking.budget_tokens : undefined,
              });

              // Wrap with retry for transient network errors (TLS abort, fetch terminated)
              const stream = await withRetry(
                () =>
                  this._api.messages.create(
                    { ...apiParams, stream: true },
                    {
                      signal: combinedSignal,
                      ...(requestExtraHeaders ? { headers: requestExtraHeaders } : {}),
                    }
                  ),
                {
                  maxRetries: 3,
                  initialDelayMs: 500,
                  maxDelayMs: 10000,
                  jitterFactor: 0.25,
                  isRetryable: err => isRetryableError(err) && !isUserInitiatedAbort(err, options.abortSignal),
                  logger: this.logger,
                  abortSignal: combinedSignal,
                }
              ).then(r => r.result);

              // Clear request timeout once stream is created (connection established)
              if (requestTimeout) clearTimeout(requestTimeout);

              let isInThinkingBlock = false;
              // Collect all content blocks for preservation (thinking, text, tool_use)
              const collectedContent: Record<string, unknown>[] = [];
              // Capture usage info from message_delta event for cache stats
              let usageInfo: Record<string, unknown> | undefined;
              // Capture the API's stop_reason from message_delta. 'max_tokens' means
              // the response was truncated against the token ceiling - surfaced
              // to the caller so truncated artifacts can be flagged and recovered.
              let stopReason: string | undefined;
              // Indices of synthesized response_format tool blocks.
              // input_json_delta events on these indices stream as text content
              // rather than being collected as a tool call.
              const responseFormatToolIndices = new Set<number>();

              // Idle timeout setup for detecting streaming hangs
              // Feature flag controlled via options._internal.enableIdleTimeout
              const enableIdleTimeout = options._internal?.enableIdleTimeout ?? false;
              const configuredIdleTimeoutMs = options._internal?.idleTimeoutMs;
              const idleTimeoutMs = this.isThinkingEnabled
                ? THINKING_IDLE_TIMEOUT_MS
                : (configuredIdleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);

              let idleTimer: ReturnType<typeof setTimeout> | undefined;
              let eventCount = 0;
              let lastEventType = '';

              const resetIdleTimer = () => {
                if (!enableIdleTimeout) return;
                if (idleTimer) clearTimeout(idleTimer);
                // Use shorter timeout for first event (initial connection)
                const timeoutMs = eventCount === 0 ? INITIAL_TIMEOUT_MS : idleTimeoutMs;
                idleTimer = setTimeout(() => {
                  // Mark idle timeout for catch block (must happen before abort)
                  isIdleTimeout = true;
                  idleTimeoutMsForError = timeoutMs;

                  // WARN, not error: an idle/streaming timeout is expected and
                  // recoverable (user retries); error severity would page LiveOps
                  // on a benign abort.
                  this.logger.warn('[AnthropicBackend] Stream idle timeout - no events received', {
                    model,
                    eventCount,
                    lastEventType,
                    timeoutMs,
                    toolCount: options.tools?.length || 0,
                    mcpToolCount: options.tools?.filter(t => (t as { _isMcpTool?: boolean })._isMcpTool).length || 0,
                  });
                  // Fire and forget metric emission
                  this.emitIdleTimeoutMetric(model, options.tools?.length || 0, eventCount).catch(() => {});
                  // Abort the stream - the AbortError will be caught and handled with a user-friendly message
                  (stream as { controller?: AbortController }).controller?.abort?.();
                }, timeoutMs);
              };

              // Start initial timeout
              resetIdleTimer();

              try {
                for await (const event of stream as AsyncIterable<RawMessageStreamEvent>) {
                  // Reset idle timer on each event
                  eventCount++;
                  lastEventType = event.type;
                  resetIdleTimer();
                  const streamedText: string[] = [];
                  if (event.type === 'content_block_start') {
                    if ('content_block' in event && event.content_block.type === 'thinking') {
                      isInThinkingBlock = true;
                      // Initialize the thinking block in our collection. The start event's
                      // content_block carries type/thinking (empty at start) plus signature -
                      // spread it directly; thinking_delta events accumulate into it below.
                      collectedContent[event.index] = { ...event.content_block };
                      streamedText[event.index] = '<think>';
                      await cb(streamedText, { toolsUsed });
                    } else if ('content_block' in event && event.content_block.type === 'tool_use') {
                      // Handle tool use start
                      const toolBlock = event.content_block;
                      // response_format=json_schema: we synthesized this
                      // tool ourselves to get structured output. Don't track it as
                      // a tool call - its input JSON IS the response content.
                      if (
                        usingResponseFormatToolUse &&
                        responseFormat?.type === 'json_schema' &&
                        toolBlock.name === responseFormat.json_schema.name
                      ) {
                        // Mark this index so input_json_delta below streams as text.
                        responseFormatToolIndices.add(event.index);
                      } else {
                        func[event.index] ||= {};
                        func[event.index].name = toolBlock.name;
                        func[event.index].id = toolBlock.id;
                        func[event.index].parameters = '';
                        // Also collect the tool use block
                        collectedContent[event.index] = {
                          type: 'tool_use',
                          id: toolBlock.id,
                          name: toolBlock.name,
                          input: {},
                        };
                      }
                    }
                  } else if (event.type === 'content_block_delta') {
                    if ('delta' in event && event.delta.type === 'thinking_delta') {
                      const thinkingText = event.delta.thinking;
                      // Accumulate thinking content in the collected block
                      if (collectedContent[event.index]) {
                        collectedContent[event.index].thinking += thinkingText;
                      }
                      streamedText[event.index] = thinkingText;
                      await cb(streamedText, { toolsUsed: toolsUsed });
                    } else if ('delta' in event && event.delta.type === 'text_delta') {
                      streamedText[event.index] = event.delta.text;
                      await cb(streamedText, { toolsUsed: toolsUsed });
                    } else if ('delta' in event && event.delta.type === 'input_json_delta') {
                      // response_format=json_schema: stream the tool's
                      // input JSON deltas directly to the caller as text. This
                      // is the structured response - the caller can JSON.parse
                      // it once `[DONE]` arrives.
                      if (responseFormatToolIndices.has(event.index)) {
                        const partial = event.delta.partial_json || '';
                        if (partial) {
                          streamedText[event.index] = partial;
                          await cb(streamedText, {
                            toolsUsed,
                            responseFormatMode: 'tool_use',
                          });
                        }
                      } else {
                        // Handle tool input JSON delta
                        if (func[event.index]) {
                          func[event.index].parameters += event.delta.partial_json || '';
                        }
                        // Also accumulate in collected content
                        if (collectedContent[event.index] && collectedContent[event.index].type === 'tool_use') {
                          // We'll parse the complete JSON at the end
                        }
                      }
                    } else if ('delta' in event && event.delta.type === 'signature_delta') {
                      // Capture cryptographic signature for thinking block
                      // Signature arrives via signature_delta just before content_block_stop
                      // Required for passing thinking blocks back to the API in tool use loops
                      if (collectedContent[event.index] && collectedContent[event.index].type === 'thinking') {
                        collectedContent[event.index].signature = event.delta.signature;
                      }
                    }
                  } else if (event.type === 'content_block_stop') {
                    if (isInThinkingBlock) {
                      isInThinkingBlock = false;
                      streamedText[event.index] = '</think>';
                      await cb(streamedText, { toolsUsed: toolsUsed });
                    } else if (collectedContent[event.index] && collectedContent[event.index].type === 'tool_use') {
                      // Parse the complete tool input when the block ends
                      if (func[event.index] && func[event.index].parameters) {
                        try {
                          collectedContent[event.index].input = JSON.parse(func[event.index].parameters || '{}');
                        } catch (e) {
                          this.logger.warn(
                            '[AnthropicBackend] Malformed tool input JSON at content_block_stop — stream may have been truncated',
                            {
                              model,
                              toolName: func[event.index].name,
                              parametersPreview: (func[event.index].parameters || '').substring(0, 100),
                              error: e instanceof Error ? e.message : String(e),
                            }
                          );
                          collectedContent[event.index].input = {};
                        }
                      }
                    }
                  } else if (this.isToolUseEvent(event)) {
                    // Handle legacy tool use events (keeping for backward compatibility)
                    func[0] ||= {};
                    const toolEvent = event as ToolUseEvent;
                    func[0].name = toolEvent.name;
                    func[0].parameters = JSON.stringify(toolEvent.input);
                    func[0].id = toolEvent.id;
                  } else if (event.type === 'message_delta') {
                    // Capture usage information for cache stats and outer-scope
                    // multi-turn accounting (see streamingTurnUsage).
                    if ('usage' in event) {
                      // MessageDeltaUsage lacks an index signature, so it isn't directly
                      // assignable to the (pre-existing) Record<string, unknown> local.
                      usageInfo = event.usage as unknown as Record<string, unknown>;
                      streamingTurnUsage = usageInfo as typeof streamingTurnUsage;
                    }
                    // The terminal message_delta carries delta.stop_reason. Keep the
                    // last non-null value so a truncated turn ('max_tokens') is reported.
                    const deltaStopReason = event.delta?.stop_reason;
                    if (deltaStopReason) {
                      stopReason = deltaStopReason;
                    }
                  }
                }
              } finally {
                // CRITICAL: Always cleanup idle timer to prevent memory leaks
                if (idleTimer) clearTimeout(idleTimer);
              }

              // If idle timeout was triggered but the stream ended naturally (e.g., HTTP connection dropped
              // without abort working), reject rather than continuing with partial/corrupt tool parameters
              if (isIdleTimeout) {
                this.logger.error(
                  '[AnthropicBackend] Stream ended after idle timeout - rejecting to avoid processing partial data',
                  {
                    model,
                    toolCount: options.tools?.length || 0,
                    idleTimeoutMs: idleTimeoutMsForError,
                    funcEntries: func.filter(f => f?.name).length,
                  }
                );
                reject(
                  new Error(
                    `Anthropic API stream timeout - no response received within ${idleTimeoutMsForError / 1000} seconds. The model may be overloaded. Try simplifying your request or using fewer tools.`
                  )
                );
                return;
              }

              // Safety-classifier refusal (Claude Fable 5 GA). The API returns HTTP 200 with
              // stop_reason: 'refusal' and empty/partial content when its cyber/bio classifiers
              // decline a request - which can false-positive on benign adjacent work. Rather than
              // surfacing a hard refusal, throw a recognized error so the completion loop's
              // existing fallback machinery (shouldTriggerFallback -> getLlmWithFallback) continues
              // on Opus 4.8. Scoped to REFUSAL_FALLBACK_MODELS so a *genuine* refusal from any
              // other model still surfaces unchanged; any partial output here is discarded by the
              // retry (the loop resets streaming state before re-running).
              if (stopReason === 'refusal' && REFUSAL_FALLBACK_MODELS.has(model)) {
                this.logger.warn(
                  '[AnthropicBackend] Safety classifier refusal — falling back to an alternative model',
                  {
                    model,
                  }
                );
                reject(
                  new Error(`Anthropic safety classifier refusal for ${model} — falling back to an alternative model`)
                );
                return;
              }

              // Store the collected content if we have tools. The accumulator holds
              // content-block-shaped objects built from the stream; bridge to the typed
              // ContentBlock[] at this boundary.
              if (this.isThinkingEnabled && collectedContent.length > 0) {
                this.lastAssistantContent = collectedContent.filter(c => c != null) as unknown as ContentBlock[];
              }

              // Extract cache stats if caching was enabled and usage info is available
              let cacheStats;
              if (cacheStrategy?.enableCaching && usageInfo) {
                const adapter = getCachingAdapter(ModelBackend.Anthropic);
                cacheStats = adapter.extractCacheStats({ usage: usageInfo }, model);

                if (cacheStats) {
                  logCacheStats(this.logger, cacheStats);
                }
              }

              // Check if we have tools to execute before signaling completion
              const hasToolsToExecute = func.some(f => f && f.name);
              if (!hasToolsToExecute) {
                // Log when model returns without using tools despite tools being available
                // This helps diagnose "blank chat" issues with MCP tools
                if (options.tools && options.tools.length > 0) {
                  const mcpToolCount = options.tools.filter(t => (t as { _isMcpTool?: boolean })._isMcpTool).length;
                  const hasContent = collectedContent.some(c => {
                    const block = c as { type?: string; text?: string };
                    return block.type === 'text' && !!block.text?.trim();
                  });
                  if (!hasContent && mcpToolCount > 0) {
                    this.logger.warn(
                      `⚠️ [AnthropicBackend] Model returned empty content with ${mcpToolCount} MCP tools available. ` +
                        `Total tools: ${options.tools.length}. This may indicate tool overload or model confusion.`
                    );
                  }
                }
                // Forward token usage captured from the message_delta event so
                // downstream consumers (cliCompletions credit tracking, SSE
                // `credits.used`) see real costs instead of a 0/1-credit floor.
                // OpenAI's backend does this on every per-chunk emit; Anthropic
                // was silently dropping it on the non-tool path.
                // Add this turn's tokens to any accumulated total from prior
                // recursive turns (multi-turn tool sessions) so the terminal
                // cb carries the full Anthropic-billable usage.
                const usage = usageInfo as { input_tokens?: number; output_tokens?: number } | undefined;
                // Early-warning canary: this is the original under-billing bug.
                // If Anthropic ever changes the message_delta event shape and
                // stops emitting usage, we'd silently revert to 0-token billing.
                // accumInputTokens > 0 means this is a continuation turn that
                // already has prior usage, so missing usage here is expected
                // for short final turns; only warn on standalone terminal turns.
                if (!usage && accumInputTokens === 0 && accumOutputTokens === 0) {
                  this.logger.warn(
                    '[AnthropicBackend] Terminal streaming turn ended without usage info from message_delta. ' +
                      'Billing will report 0 tokens for this call. This may indicate an Anthropic API regression.',
                    { model }
                  );
                }
                // Forward Anthropic cache token deltas. These are
                // billed at 0.1x input rate (read) / 1.25x input rate (write)
                // and are tracked separately so credit accounting can apply
                // the correct multipliers.
                const usageWithCache = usage as
                  | {
                      input_tokens?: number;
                      output_tokens?: number;
                      cache_read_input_tokens?: number;
                      cache_creation_input_tokens?: number;
                    }
                  | undefined;
                await cb([], {
                  toolsUsed,
                  cacheStats,
                  inputTokens: accumInputTokens + (usage?.input_tokens || 0),
                  outputTokens: accumOutputTokens + (usage?.output_tokens || 0),
                  // Accumulated across tool turns: the provider bills cache per API call.
                  cacheReadInputTokens: totalCacheTokens(accumCacheReadTokens, usageWithCache?.cache_read_input_tokens),
                  cacheCreationInputTokens: totalCacheTokens(
                    accumCacheWriteTokens,
                    usageWithCache?.cache_creation_input_tokens
                  ),
                  ...(usingResponseFormatToolUse ? { responseFormatMode: 'tool_use' as const } : {}),
                  ...(stopReason ? { stopReason } : {}),
                });
              }
              resolve();
            } catch (error) {
              // Always clear request timeout on error (if it was set)
              if (requestTimeout) clearTimeout(requestTimeout);

              // Check if this is an abort error
              const isAbortError =
                error instanceof Error &&
                (error.message.includes('aborted') ||
                  error.message.includes('AbortError') ||
                  error.name === 'AbortError');

              // Check if this was our request timeout (vs user-initiated abort)
              const isRequestTimeout = requestAbortController.signal.aborted;

              if (isAbortError) {
                if (isRequestTimeout) {
                  // Request timeout - reject with specific error so caller can handle.
                  // WARN, not error: benign/recoverable abort - keeps it out of the
                  // CloudWatch ERROR->LiveOps/Slack alert path.
                  this.logger.warn('[AnthropicBackend] Request aborted due to timeout', {
                    model,
                    toolCount: options.tools?.length || 0,
                  });
                  reject(
                    new Error(
                      `Anthropic API request timeout after ${requestTimeoutMs}ms - no streaming response received`
                    )
                  );
                } else if (isIdleTimeout) {
                  // Idle timeout - the stream was aborted due to no events being received
                  // The abort causes AbortError to be thrown, which we catch here.
                  // WARN, not error: benign/recoverable abort - keeps it out of the
                  // CloudWatch ERROR->LiveOps/Slack alert path.
                  this.logger.warn('[AnthropicBackend] Stream aborted due to idle timeout', {
                    model,
                    toolCount: options.tools?.length || 0,
                    idleTimeoutMs: idleTimeoutMsForError,
                  });
                  reject(
                    new Error(
                      `Anthropic API stream timeout - no response received within ${idleTimeoutMsForError / 1000} seconds. The model may be overloaded. Try simplifying your request or using fewer tools.`
                    )
                  );
                } else {
                  // User-initiated abort - resolve gracefully
                  this.logger.debug('Anthropic request was aborted (likely client disconnect)');
                  resolve();
                }
              } else {
                reject(error);
              }
            } finally {
              releaseSlot();
            }
          })();
        });

        // If there are tool calls, execute them and continue the conversation
        if (func.some(f => f && f.name)) {
          // Track tool usage first (including ID for history reconstruction)
          const toolCallNames = func.filter(t => t?.name).map(t => t.name);
          this.logger.info('[Tool Execution] Model requested tool calls', {
            model,
            toolCallCount,
            toolsRequested: toolCallNames,
            toolCount: toolCallNames.length,
            messageCountBefore: messages.length,
          });

          for (const tool of func) {
            // Allow empty parameters (some tools don't require input)
            if (!tool || !tool.name) continue;
            toolsUsed.push({
              name: tool.name,
              arguments: tool.parameters || '{}',
              id: tool.id,
            });
          }

          // Check if we should execute tools or just report them
          if (options.executeTools !== false) {
            // Resolve which tools are executable (filter out missing toolFns early)
            type ResolvedTool = {
              id: string;
              name: string;
              parameters: string;
              parsedParams: Record<string, unknown>;
              toolFn: (params: Record<string, unknown>) => Promise<{ toString(): string }>;
              isMcpTool: boolean;
            };
            const resolvedTools: ResolvedTool[] = [];
            for (const tool of func) {
              if (!tool || !tool.name) continue;
              const { id, name } = tool;
              const parameters = tool.parameters || '{}';
              const toolDef = options.tools?.find(t => t.toolSchema.name === name);
              const toolFn = toolDef?.toolFn;
              const isMcpTool = toolDef?._isMcpTool ?? false;

              if (!toolFn) {
                this.logger.warn('[Tool Execution] Tool function not found', {
                  model,
                  toolName: name,
                  availableTools: options.tools?.map(t => t.toolSchema.name) || [],
                });
                continue;
              }

              const parsedParams = this.tryParseToolParams(
                parameters,
                { id, name, model, isMcpTool, streaming: true },
                messages
              );
              if (!parsedParams) {
                // Normalize the toolsUsed entry so callers can safely JSON.parse arguments
                const entry = toolsUsed.find(t => t.name === name && t.id === id);
                if (entry) entry.arguments = '{}';
                continue;
              }

              resolvedTools.push({ id: id ?? '', name, parameters, parsedParams, toolFn, isMcpTool });
            }

            // Execute tools - parallel by default, sequential when opted out
            const parallelEnabled = options.parallelToolExecution !== false;

            type ToolPayload = {
              id: string;
              name: string;
              parameters: string;
              isMcpTool: boolean;
              result: { toString(): string };
              durationMs: number;
            };

            this.logger.info('[Tool Execution] Executing tools', {
              model,
              mode: parallelEnabled && resolvedTools.length > 1 ? 'parallel' : 'sequential',
              toolCallIteration: toolCallCount + 1,
              toolNames: resolvedTools.map(t => t.name),
            });

            const batchOutcomes = await executeToolsBatch<ToolPayload>(
              resolvedTools.map(({ id, name, parameters, parsedParams, toolFn, isMcpTool }) => async () => {
                this.logger.info('[Tool Execution] Executing tool', {
                  model,
                  toolName: name,
                  isMcpTool,
                  toolCallIteration: toolCallCount + 1,
                  parameterKeys: Object.keys(parsedParams),
                });
                const toolStartTime = Date.now();
                const result = await toolFn(parsedParams);
                return { id, name, parameters, isMcpTool, result, durationMs: Date.now() - toolStartTime };
              }),
              { parallel: parallelEnabled, maxConcurrency: options.maxParallelTools }
            );

            // Map batch outcomes back to tool metadata for injection
            type ToolOutcome =
              | {
                  ok: true;
                  id: string;
                  name: string;
                  parameters: string;
                  isMcpTool: boolean;
                  result: { toString(): string };
                  durationMs: number;
                }
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

            // Inject results in original order (required by Anthropic API)
            for (const outcome of outcomes) {
              // Anthropic API requires a tool_use_id; generate a fallback if the model omitted one.
              // Other backends (OpenAI, xAI, etc.) always receive IDs from their APIs.
              const toolId = outcome.id || crypto.randomUUID();
              if (outcome.ok) {
                const resultStr = outcome.result.toString();

                this.logger.info('[Tool Execution] Tool completed successfully', {
                  model,
                  toolName: outcome.name,
                  isMcpTool: outcome.isMcpTool,
                  durationMs: outcome.durationMs,
                  resultLength: resultStr.length,
                  resultPreview: resultStr.substring(0, 100) + (resultStr.length > 100 ? '...' : ''),
                });

                // For tools that return artifacts (like recharts), stream the result directly
                await handleToolResultStreaming(outcome.name, outcome.result, async results => {
                  await cb(results, { inputTokens: 0, outputTokens: 0, toolsUsed });
                });

                this.pushToolMessages(
                  messages,
                  { id: toolId, name: outcome.name, parameters: outcome.parameters },
                  resultStr
                );
              } else {
                // Re-throw permission denials; inject error result for all others
                if (outcome.error instanceof PermissionDeniedError) throw outcome.error;

                this.logger.error('[Tool Execution] Tool failed', {
                  model,
                  toolName: outcome.name,
                  error: outcome.error instanceof Error ? outcome.error.message : 'Unknown error',
                });

                this.pushToolMessages(
                  messages,
                  { id: toolId, name: outcome.name, parameters: outcome.parameters },
                  `Error processing ${outcome.name} tool: ${outcome.error instanceof Error ? outcome.error.message : 'Unknown error'}`
                );
              }
            }

            // Add newline separator before recursive call to ensure proper markdown rendering
            await cb(['\n\n'], { toolsUsed });

            // Log before recursive call with full context
            this.logger.info('[Tool Execution] Making recursive call after tool execution', {
              model,
              toolCallIteration: toolCallCount + 1,
              messageCountAfter: messages.length,
              toolsExecuted: func.filter(t => t?.name).map(t => t.name),
              totalToolsUsed: toolsUsed.length,
            });

            // Keep tools available for all tool types to enable chaining
            // (e.g., web_search -> web_search, web_search -> web_fetch)
            // The MAX_TOOL_CALLS limit prevents infinite loops
            // Carry this turn's tokens forward so the terminal recursive call
            // emits the full multi-turn billable total to cb.
            await this.complete(
              model,
              messages,
              {
                ...options,
                // First-turn-only tool_choice: after tools run, let the model synthesize.
                tool_choice: 'auto',
                _internal: {
                  ...options._internal,
                  toolCallCount: toolCallCount + 1,
                  accumInputTokens: accumInputTokens + (streamingTurnUsage?.input_tokens || 0),
                  accumOutputTokens: accumOutputTokens + (streamingTurnUsage?.output_tokens || 0),
                  // Cache tokens are billed per API call - accumulate like input/output.
                  accumCacheReadTokens: accumCacheReadTokens + (streamingTurnUsage?.cache_read_input_tokens || 0),
                  accumCacheWriteTokens: accumCacheWriteTokens + (streamingTurnUsage?.cache_creation_input_tokens || 0),
                },
              },
              cb,
              toolsUsed
            );
          } else {
            // New behavior: just pass tool calls through callback, don't execute
            // Include thinking blocks for Anthropic extended thinking
            const thinkingBlocks = this.getThinkingBlocks();
            this.logger.debug(
              `[Tool Execution] executeTools=false, passing tool calls to callback with ${thinkingBlocks?.length || 0} thinking blocks`
            );
            // Terminal leaf - emit accumulated total plus this turn's tokens.
            await cb([null], {
              toolsUsed,
              thinking: thinkingBlocks,
              inputTokens: accumInputTokens + (streamingTurnUsage?.input_tokens || 0),
              outputTokens: accumOutputTokens + (streamingTurnUsage?.output_tokens || 0),
              cacheReadInputTokens: totalCacheTokens(accumCacheReadTokens, streamingTurnUsage?.cache_read_input_tokens),
              cacheCreationInputTokens: totalCacheTokens(
                accumCacheWriteTokens,
                streamingTurnUsage?.cache_creation_input_tokens
              ),
            });
          }
          return; // Exit after handling tools
        }
      } else {
        // Non-streaming path
        // Acquire semaphore slot for the API call. For non-streaming, the full
        // response body is received when the call resolves, so we release
        // immediately after.
        await acquireSlot();
        let response;
        try {
          // Wrap with retry for transient network errors (TLS abort, fetch terminated)
          response = await withRetry(
            () =>
              this._api.messages.create(apiParams, {
                signal: options.abortSignal,
                ...(requestExtraHeaders ? { headers: requestExtraHeaders } : {}),
              }),
            {
              maxRetries: 3,
              initialDelayMs: 500,
              maxDelayMs: 10000,
              jitterFactor: 0.25,
              isRetryable: err => isRetryableError(err) && !isUserInitiatedAbort(err, options.abortSignal),
              logger: this.logger,
              abortSignal: options.abortSignal,
            }
          ).then(r => r.result);
        } finally {
          releaseSlot();
        }
        const streamedText: string[] = [];

        if ('content' in response && Array.isArray(response.content)) {
          // Store the complete assistant content if thinking is enabled
          if (this.isThinkingEnabled) {
            this.lastAssistantContent = response.content as ContentBlock[];
          }

          for (let i = 0; i < response.content.length; i++) {
            const content = response.content[i] as ContentBlock;
            if ('text' in content) {
              streamedText.push(content.text);
              // Log each text block for debugging
              this.logger.debug('[AnthropicBackend] Text block extracted', {
                blockIndex: i,
                textLength: content.text.length,
              });
            } else if ('type' in content) {
              if (content.type === 'tool_use') {
                // response_format=json_schema: the synthesized tool's
                // input IS the structured response - emit it as text instead of
                // tracking it as a tool call.
                if (
                  usingResponseFormatToolUse &&
                  responseFormat?.type === 'json_schema' &&
                  content.name === responseFormat.json_schema.name
                ) {
                  streamedText.push(JSON.stringify(content.input ?? {}));
                } else {
                  // Handle tool use in non-streaming response
                  func[i] ||= {};
                  func[i].name = content.name;
                  func[i].id = content.id;
                  func[i].parameters = JSON.stringify(content.input || {});
                }
              } else if (content.type === 'thinking') {
                // Log if thinking blocks are present (shouldn't be if thinking is disabled)
                this.logger.warn('[AnthropicBackend] Unexpected thinking block in response', {
                  blockIndex: i,
                  thinkingLength: content.thinking?.length || 0,
                });
              }
            }
          }
        }

        // Safety-classifier refusal on the non-streaming path (mirrors the streaming branch
        // above). A stream=false request for a REFUSAL_FALLBACK_MODELS model - reachable when a
        // caller sets stream:false even for Fable 5 - returns HTTP 200 with stop_reason:'refusal'
        // and empty content; without this the caller would see a silently-empty completion and no
        // fallback. Throw the same recognized error so the completion loop continues on Opus 4.8.
        const nonStreamStopReason =
          'stop_reason' in response ? (response as { stop_reason?: string }).stop_reason : undefined;
        if (nonStreamStopReason === 'refusal' && REFUSAL_FALLBACK_MODELS.has(model)) {
          this.logger.warn('[AnthropicBackend] Safety classifier refusal (non-streaming) — falling back', { model });
          throw new Error(`Anthropic safety classifier refusal for ${model} — falling back to an alternative model`);
        }

        // Populate toolsUsed from func before callback (non-streaming path)
        // Include ID for history reconstruction
        for (const tool of func) {
          // Allow empty parameters (some tools don't require input)
          if (tool?.name) {
            toolsUsed.push({
              name: tool.name,
              arguments: tool.parameters || '{}',
              id: tool.id,
            });
          }
        }

        const usage = 'usage' in response ? response.usage : undefined;
        const usageWithCacheNS = usage as
          | {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            }
          | undefined;
        // Only emit tokens on the terminal turn (no further tool execution will
        // happen). Intermediate turns omit usage so cliCompletions' assign-not-add
        // wrappedOnChunk doesn't clobber the accumulated total. The terminal turn
        // emits accumulated total plus this turn - same shape as the streaming path.
        const isTerminalTurn = !func.some(f => f && f.name);
        await cb(streamedText, {
          inputTokens: isTerminalTurn ? accumInputTokens + (usage?.input_tokens || 0) : 0,
          outputTokens: isTerminalTurn ? accumOutputTokens + (usage?.output_tokens || 0) : 0,
          toolsUsed: toolsUsed,
          ...(isTerminalTurn
            ? {
                // Accumulated across tool turns: the provider bills cache per API call.
                cacheReadInputTokens: totalCacheTokens(accumCacheReadTokens, usageWithCacheNS?.cache_read_input_tokens),
                cacheCreationInputTokens: totalCacheTokens(
                  accumCacheWriteTokens,
                  usageWithCacheNS?.cache_creation_input_tokens
                ),
              }
            : {}),
          ...(isTerminalTurn && usingResponseFormatToolUse ? { responseFormatMode: 'tool_use' as const } : {}),
        });

        // If there are tool calls, execute them and continue the conversation
        if (func.some(f => f && f.name)) {
          // Log tool calls requested by model (non-streaming path)
          const toolCallNames = func.filter(t => t?.name).map(t => t.name);
          this.logger.info('[Tool Execution] Model requested tool calls (non-streaming)', {
            model,
            toolCallCount,
            toolsRequested: toolCallNames,
            toolCount: toolCallNames.length,
            messageCountBefore: messages.length,
          });

          // Check if we should execute tools or just report them
          if (options.executeTools !== false) {
            // Resolve which tools are executable
            type ResolvedTool = {
              id: string;
              name: string;
              parameters: string;
              parsedParams: Record<string, unknown>;
              toolFn: (params: Record<string, unknown>) => Promise<{ toString(): string }>;
              isMcpTool: boolean;
            };
            const resolvedTools: ResolvedTool[] = [];
            for (const tool of func) {
              if (!tool || !tool.name) continue;
              const { id, name } = tool;
              const parameters = tool.parameters || '{}';
              const toolDef = options.tools?.find(t => t.toolSchema.name === name);
              const toolFn = toolDef?.toolFn;
              const isMcpTool = toolDef?._isMcpTool ?? false;

              if (!toolFn) {
                this.logger.warn('[Tool Execution] Tool function not found (non-streaming)', {
                  model,
                  toolName: name,
                  availableTools: options.tools?.map(t => t.toolSchema.name) || [],
                });
                continue;
              }

              const parsedParams = this.tryParseToolParams(
                parameters,
                { id, name, model, isMcpTool, streaming: false },
                messages
              );
              if (!parsedParams) continue;

              resolvedTools.push({ id: id ?? '', name, parameters, parsedParams, toolFn, isMcpTool });
            }

            // Execute tools - parallel by default, sequential when opted out
            const parallelEnabled = options.parallelToolExecution !== false;

            type ToolPayloadNS = {
              id: string;
              name: string;
              parameters: string;
              isMcpTool: boolean;
              result: { toString(): string };
              durationMs: number;
            };

            this.logger.info('[Tool Execution] Executing tools (non-streaming)', {
              model,
              mode: parallelEnabled && resolvedTools.length > 1 ? 'parallel' : 'sequential',
              toolCallIteration: toolCallCount + 1,
              toolNames: resolvedTools.map(t => t.name),
            });

            const batchOutcomesNS = await executeToolsBatch<ToolPayloadNS>(
              resolvedTools.map(({ id, name, parameters, parsedParams, toolFn, isMcpTool }) => async () => {
                this.logger.info('[Tool Execution] Executing tool (non-streaming)', {
                  model,
                  toolName: name,
                  isMcpTool,
                  toolCallIteration: toolCallCount + 1,
                  parameterKeys: Object.keys(parsedParams),
                });
                const toolStartTime = Date.now();
                const result = await toolFn(parsedParams);
                return { id, name, parameters, isMcpTool, result, durationMs: Date.now() - toolStartTime };
              }),
              { parallel: parallelEnabled, maxConcurrency: options.maxParallelTools }
            );

            // Map batch outcomes back to tool metadata for injection
            type ToolOutcomeNS =
              | {
                  ok: true;
                  id: string;
                  name: string;
                  parameters: string;
                  isMcpTool: boolean;
                  result: { toString(): string };
                  durationMs: number;
                }
              | { ok: false; id: string; name: string; parameters: string; error: unknown };

            const outcomesNS: ToolOutcomeNS[] = batchOutcomesNS.map((outcome, i) =>
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

            // Inject results in original order (required by Anthropic API)
            for (const outcome of outcomesNS) {
              // Anthropic API requires a tool_use_id; generate a fallback if the model omitted one.
              // Other backends (OpenAI, xAI, etc.) always receive IDs from their APIs.
              const toolId = outcome.id || crypto.randomUUID();
              if (outcome.ok) {
                const resultStr = outcome.result.toString();

                this.logger.info('[Tool Execution] Tool completed successfully (non-streaming)', {
                  model,
                  toolName: outcome.name,
                  isMcpTool: outcome.isMcpTool,
                  durationMs: outcome.durationMs,
                  resultLength: resultStr.length,
                  resultPreview: resultStr.substring(0, 100) + (resultStr.length > 100 ? '...' : ''),
                });

                // For tools that return artifacts (like recharts), stream the result directly
                await handleToolResultStreaming(outcome.name, outcome.result, async results => {
                  await cb(results, { toolsUsed });
                });

                this.pushToolMessages(
                  messages,
                  { id: toolId, name: outcome.name, parameters: outcome.parameters },
                  resultStr
                );
              } else {
                if (outcome.error instanceof PermissionDeniedError) throw outcome.error;

                this.logger.error('[Tool Execution] Tool failed (non-streaming)', {
                  model,
                  toolName: outcome.name,
                  error: outcome.error instanceof Error ? outcome.error.message : 'Unknown error',
                });

                this.pushToolMessages(
                  messages,
                  { id: toolId, name: outcome.name, parameters: outcome.parameters },
                  `Error processing ${outcome.name} tool: ${outcome.error instanceof Error ? outcome.error.message : 'Unknown error'}`
                );
              }
            }

            // Log before recursive call
            this.logger.info('[Tool Execution] Making recursive call after tool execution (non-streaming)', {
              model,
              toolCallIteration: toolCallCount + 1,
              messageCountAfter: messages.length,
              toolsExecuted: func.filter(t => t?.name).map(t => t.name),
              totalToolsUsed: toolsUsed.length,
            });

            // Add newline separator before recursive call to ensure proper markdown rendering
            await cb(['\n\n'], { toolsUsed });

            // Keep tools available for all tool types to enable chaining
            // The MAX_TOOL_CALLS limit prevents infinite loops
            // Carry this turn's tokens forward so the terminal recursive call
            // emits the full multi-turn billable total to cb.
            await this.complete(
              model,
              messages,
              {
                ...options,
                // First-turn-only tool_choice: after tools run, let the model synthesize.
                tool_choice: 'auto',
                _internal: {
                  ...options._internal, // Preserve enableIdleTimeout, idleTimeoutMs
                  toolCallCount: toolCallCount + 1,
                  accumInputTokens: accumInputTokens + (usage?.input_tokens || 0),
                  accumOutputTokens: accumOutputTokens + (usage?.output_tokens || 0),
                  // Cache tokens are billed per API call - accumulate like input/output.
                  accumCacheReadTokens: accumCacheReadTokens + (usageWithCacheNS?.cache_read_input_tokens || 0),
                  accumCacheWriteTokens: accumCacheWriteTokens + (usageWithCacheNS?.cache_creation_input_tokens || 0),
                },
              },
              cb,
              toolsUsed
            );
          } else {
            // New behavior: just pass tool calls through callback, don't execute
            // Include thinking blocks for Anthropic extended thinking
            const thinkingBlocks = this.getThinkingBlocks();
            this.logger.debug(
              `[Tool Execution] executeTools=false, passing tool calls to callback with ${thinkingBlocks?.length || 0} thinking blocks`
            );
            // Terminal leaf - emit accumulated total plus this turn's tokens.
            // The cb above (gated on isTerminalTurn) already emitted this
            // turn's tokens to streamedText for the executeTools=true branch and
            // emitted 0 for the executeTools=false branch (func has names), so
            // it is safe to emit the accumulated total here without double-counting.
            await cb([null], {
              inputTokens: accumInputTokens + (usage?.input_tokens || 0),
              outputTokens: accumOutputTokens + (usage?.output_tokens || 0),
              toolsUsed,
              thinking: thinkingBlocks,
            });
          }
          return; // Exit after handling tools
        }
      }
    } catch (error) {
      // Emit CloudWatch metric for rate limit errors (after SDK exhausts retries)
      if (error instanceof RateLimitError) {
        // Determine feature area and request type for ops visibility
        const mcpTools = options.tools?.filter((t: ICompletionOptionTools) => t._isMcpTool) || [];
        const builtInTools = options.tools?.filter((t: ICompletionOptionTools) => !t._isMcpTool) || [];
        const hasMcpTools = mcpTools.length > 0;
        const hasBuiltInTools = builtInTools.length > 0;

        // Determine feature area
        let featureArea = 'chat'; // default
        if (hasMcpTools && !hasBuiltInTools) {
          featureArea = 'mcp-tools';
        } else if (hasMcpTools && hasBuiltInTools) {
          featureArea = 'mcp-tools+built-in';
        } else if (hasBuiltInTools) {
          featureArea = 'built-in-tools';
        }

        // Determine request type based on tool call iteration
        let requestType = 'initial-chat';
        if (toolCallCount > 0) {
          requestType = `tool-continuation-${toolCallCount}`;
        } else if (options.tools?.length) {
          requestType = 'initial-with-tools';
        }

        this.logger.error('[AnthropicBackend] Rate limit error after all retries exhausted', {
          model,
          status: error.status,
          message: error.message,
          // Context for ops
          featureArea,
          requestType,
          toolCallIteration: toolCallCount,
          toolsUsedSoFar: toolsUsed.map(t => t.name),
          availableToolCount: options.tools?.length || 0,
          mcpToolCount: mcpTools.length,
          mcpToolNames: mcpTools.map((t: ICompletionOptionTools) => t.toolSchema.name).slice(0, 10),
          builtInToolCount: builtInTools.length,
          builtInToolNames: builtInTools.map((t: ICompletionOptionTools) => t.toolSchema.name).slice(0, 10),
          messageCount: messages.length,
        });
        // Fire and forget - don't block on metrics
        this.emitRateLimitMetric(model, featureArea).catch(() => {});
      } else {
        this.logger.debug('Error in complete:', error);
      }
      throw error;
    }
  }

  formatTools(tools: ICompletionOptionTools[] = []) {
    return tools.map(tool => {
      const { parameters, ...rest } = tool.toolSchema;
      // `strict` is an OpenAI-only tool field. Anthropic rejects it with
      // "tools.N.custom.strict: Extra inputs are not permitted", so strip it from the
      // spread copy (e.g. a tool schema that sets strict: true for OpenAI structured tools).
      delete rest.strict;
      return {
        ...rest,
        input_schema: parameters,
      };
    });
  }

  /**
   * Attempt to parse tool parameters JSON. On failure, logs the error and pushes
   * a descriptive error as the tool result so the model can retry.
   * Returns parsed params on success, or null to signal the caller should skip execution.
   */
  private tryParseToolParams(
    parameters: string,
    context: { id: string | undefined; name: string; model: string; isMcpTool: boolean; streaming: boolean },
    messages: IMessage[]
  ): Record<string, unknown> | null {
    try {
      return JSON.parse(parameters);
    } catch (parseError) {
      const label = context.streaming ? 'streaming' : 'non-streaming';
      this.logger.error(`[Tool Execution] Invalid tool parameters - skipping execution (${label})`, {
        model: context.model,
        toolName: context.name,
        isMcpTool: context.isMcpTool,
        parametersPreview: parameters.substring(0, 100),
        error: parseError instanceof Error ? parseError.message : String(parseError),
      });
      // Defensive fallback ID - Anthropic's ToolUseBlock always provides `id`,
      // but we guard against edge cases like partial stream data.
      const toolId = context.id || `tool_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
      this.pushToolMessages(
        messages,
        { id: toolId, name: context.name, parameters: '{}' },
        `Error: Tool parameters were corrupted due to a stream interruption. Please retry.`
      );
      return null;
    }
  }

  pushToolMessages(messages: IMessage[], tool: IChoiceEndToolUse['tool'], result: string, thinkingBlocks?: unknown[]) {
    // If thinking is enabled and we have the original assistant content, use it
    if (this.isThinkingEnabled && this.lastAssistantContent.length > 0) {
      // Include ALL content blocks: thinking (with signature) + tool_use
      // When thinking is enabled, Anthropic API REQUIRES assistant messages with tool_use
      // to start with a thinking block. The signature field is cryptographic but must be
      // passed back unmodified for validation.
      // See: https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
      messages.push({
        role: 'assistant',
        // SDK ContentBlock[] -> internal MessageContent at this boundary (the two
        // thinking-block shapes differ structurally but are wire-compatible).
        content: this.lastAssistantContent as unknown as IMessage['content'],
      });

      this.logger.debug(
        `[AnthropicBackend] Including ${this.lastAssistantContent.length} content blocks (thinking + tool_use) in assistant message`
      );
    } else if (thinkingBlocks && thinkingBlocks.length > 0) {
      // Thinking blocks passed explicitly (e.g., from ReActAgent which uses executeTools: false)
      let parsedInput: Record<string, unknown>;
      try {
        parsedInput = JSON.parse(tool.parameters || '{}');
      } catch (parseError) {
        this.logger.warn('[AnthropicBackend] Failed to parse tool parameters in pushToolMessages, using empty object', {
          toolName: tool.name,
          parametersPreview: (tool.parameters || '').substring(0, 100),
          error: parseError instanceof Error ? parseError.message : String(parseError),
        });
        parsedInput = {};
      }
      messages.push({
        role: 'assistant',
        content: [
          ...(thinkingBlocks as Array<{ type: 'thinking'; thinking: string; signature: string }>),
          {
            type: 'tool_use' as const,
            id: tool.id,
            name: tool.name,
            input: parsedInput,
          },
        ],
      });

      this.logger.debug(
        `[AnthropicBackend] Including ${thinkingBlocks.length} explicit thinking blocks in assistant message`
      );
    } else {
      // Fallback for non-thinking models or when content wasn't preserved
      let parsedInput: Record<string, unknown>;
      try {
        parsedInput = JSON.parse(tool.parameters || '{}');
      } catch (parseError) {
        this.logger.warn('[AnthropicBackend] Failed to parse tool parameters in pushToolMessages, using empty object', {
          toolName: tool.name,
          parametersPreview: (tool.parameters || '').substring(0, 100),
          error: parseError instanceof Error ? parseError.message : String(parseError),
        });
        parsedInput = {};
      }
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: tool.id,
            name: tool.name,
            input: parsedInput,
          },
        ],
      });
    }

    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: tool.id,
          content: result,
        },
      ],
    });
  }

  replaceLastToolResultObservation(messages: IMessage[], toolCallId: string, newObservation: string): void {
    replaceLastToolResultObservationCanonical(messages, toolCallId, newObservation);
  }

  getLatestToolCallId(messages: IMessage[], toolName: string): string | undefined {
    return getLatestToolCallIdCanonical(messages, toolName);
  }

  /**
   * Sanitize message content to remove empty/whitespace-only text blocks.
   * Anthropic API rejects "text content blocks must contain non-whitespace text"
   */
  private sanitizeMessageContent(message: IMessage): IMessage | null {
    // Handle string content - check for empty/whitespace-only
    if (typeof message.content === 'string') {
      const trimmed = message.content.trim();
      if (!trimmed) {
        return null; // Mark for removal
      }
      return message;
    }

    // Handle array content - filter out empty text blocks
    if (Array.isArray(message.content)) {
      const sanitizedContent = message.content
        .map(block => {
          // For text blocks, check if text is empty/whitespace-only
          if (block.type === 'text') {
            const text = block.text || '';
            if (!text.trim()) {
              return null; // Mark for removal
            }
          }
          return block;
        })
        .filter(block => block !== null);

      // If array is now empty, mark message for removal
      if (sanitizedContent.length === 0) {
        return null;
      }

      return { ...message, content: sanitizedContent };
    }

    return message;
  }

  /**
   * Filter out irrelevant messages for Anthropic API.
   * Remove all messages with `system` role.
   * Remove messages that have no reply from the assistant, except for the last one.
   * Also remove the first message if it's from the assistant.
   */
  private filterRelevantMessages(messages: IMessage[]): IMessage[] {
    const formattedMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => this.sanitizeMessageContent(m))
      .filter((m): m is IMessage => m !== null)
      .reduce((cur, value, index, array) => {
        const previousMessage = cur[cur.length - 1];
        const isLastMessage = index === array.length - 1;

        // Check if the previous message has the same role as the current message
        if (previousMessage && value.role === previousMessage.role) {
          // For consecutive messages of the same role, only merge if not the last message
          // This prevents the current user question from being merged and delayed
          if (isLastMessage && value.role === 'user') {
            // Always push the last user message as a separate message
            cur.push(value);
            return cur;
          }
        }

        // Check if the previous message has the same role as the current message
        if (previousMessage && value.role === previousMessage.role) {
          // if the previous message is the same
          // then skip the current message
          if (previousMessage.content === value.content) {
            return cur;

            // if the previous messate content is a text
            // then convert the content to an array of text
          } else if (!Array.isArray(previousMessage.content)) {
            if (typeof previousMessage.content === 'string' && previousMessage.content.trim() === '') {
              return cur;
            }

            // Only merge if current value.content is also a string (not an array with images)
            if (typeof value.content !== 'string') {
              cur.push(value);
              return cur;
            }

            cur[cur.length - 1].content = [
              { type: 'text', text: previousMessage.content },
              {
                type: 'text',
                text: value.content,
              },
            ];

            // if not
            // then add the current message to the previous message content
          } else {
            // Only merge if current value.content is a string (not an array with images)
            if (typeof value.content !== 'string') {
              cur.push(value);
              return cur;
            }

            if (value.content.trim() === '') {
              return cur;
            }

            const content = cur[cur.length - 1].content as MessageContentText[];
            if (content.some(c => c.type === 'text')) {
              return cur;
            }
            cur[cur.length - 1].content = [...content, { type: 'text', text: value.content }];
          }

          return cur;
        }

        // Skip empty messages
        if (typeof value.content === 'string' && value.content.trim() === '') {
          return cur;
        }

        // Push the message if the role is different
        cur.push(value);

        return cur;
      }, [] as IMessage[]);

    return formattedMessages;
  }

  /**
   * Messages with `system` role are not supported in Anthropic API.
   * So we have to consolidate all system messages into a single message
   * and pass it as a parameter to the API.
   */
  private consolidateSystemMessages(messages: IMessage[]): string | undefined {
    const systemMessages = messages.filter(m => m.role === 'system');
    if (systemMessages.length === 0) return undefined;

    return systemMessages.map(m => m.content).join('\n');
  }

  private isToolUseEvent(event: unknown): event is ToolUseEvent {
    return (
      typeof event === 'object' &&
      event !== null &&
      'type' in event &&
      event.type === 'tool_use' &&
      'name' in event &&
      'input' in event &&
      'id' in event
    );
  }
}

export const extractThinkContent = (reply: string, isStreaming?: boolean): string[] => {
  // Extract content between a single pair of think tags
  const startTag = '<think>';
  const endTag = '</think>';
  const startIndex = reply.indexOf(startTag);

  if (startIndex === -1) return [];

  const endIndex = reply.indexOf(endTag, startIndex);
  const content =
    endIndex === -1
      ? reply.substring(startIndex + startTag.length) // Still streaming
      : reply.substring(startIndex + startTag.length, endIndex);

  // Split by lines and filter empty ones
  return content
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean);
};
