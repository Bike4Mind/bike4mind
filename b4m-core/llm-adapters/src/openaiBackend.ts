import {
  ChatModels,
  IMessage,
  ImageModels,
  ModelBackend,
  PermissionDeniedError,
  FIXED_TEMPERATURE_MODELS,
  REASONING_EFFORT_INCOMPATIBLE_WITH_TOOLS_MODELS,
  RESPONSES_API_TOOL_MODELS,
  REASONING_SUPPORTED_MODELS,
  SpeechToTextModels,
  VideoModels,
  type ModelInfo,
  type ReasoningEffort,
  type CacheUsageStats,
} from '@bike4mind/common';
import OpenAI from 'openai';
import { ChatCompletionChunk, ChatCompletionCreateParams } from 'openai/resources/chat/completions';
import type {
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
  ResponseOutputItem,
  Tool as ResponsesTool,
} from 'openai/resources/responses/responses';
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
  replaceLastToolResultObservationOpenAI,
  getLatestToolCallIdOpenAI,
} from './backend';
import { handleToolResultStreaming } from './toolStreamingHelper';
import { convertMessagesToOpenAIFormat } from './messageFormatConverter';
import { getCachingAdapter, logCacheStats } from './caching/adapters';
import { withRetry, isUserInitiatedAbort, isRetryableError } from './retry';

// Type for the reasoning_effort parameter that can be added to ChatCompletionCreateParams
// OpenAI API expects reasoning_effort as a top-level string, not a nested object
type ReasoningParameter = {
  reasoning_effort?: ReasoningEffort;
};

const O1_MODELS: string[] = [
  ChatModels.O1_PREVIEW,
  ChatModels.O1_MINI,
  ChatModels.O1,
  ChatModels.O3_MINI,
  ChatModels.O3,
  ChatModels.O4_MINI,
];

const GPT5_MODELS: string[] = [
  ChatModels.GPT5,
  ChatModels.GPT5_MINI,
  ChatModels.GPT5_NANO,
  ChatModels.GPT5_CHAT_LATEST,
];

const GPT5_1_MODELS: string[] = [ChatModels.GPT5_1, ChatModels.GPT5_1_CHAT_LATEST];

const GPT5_2_MODELS: string[] = [ChatModels.GPT5_2, ChatModels.GPT5_2_CHAT_LATEST];

const GPT5_4_MODELS: string[] = [ChatModels.GPT5_4, ChatModels.GPT5_4_MINI, ChatModels.GPT5_4_NANO];

const GPT5_5_MODELS: string[] = [ChatModels.GPT5_5];

// Map complexity to reasoning effort.
// Supported values: 'none', 'low', 'medium', 'high', 'xhigh'
// 'minimal' is NOT supported by the Chat Completions API
const effortMap = {
  simple: 'low',
  contextual: 'low',
  complex: 'medium',
} as const;

const effortMap_GPT5_1_2 = {
  simple: 'low',
  contextual: 'low',
  complex: 'medium',
} as const;

export class OpenAIBackend implements ICompletionBackend {
  private _api: OpenAI;
  private logger: Logger;
  public currentModel: string = '';
  // Opaque, non-PII end-user identifier forwarded as `safety_identifier` so
  // OpenAI can attribute abuse to an individual user and scope enforcement to
  // them rather than the whole shared platform key. See `toProviderEndUserId`.
  private readonly _endUserId?: string;

  constructor(apiKey: string, logger?: Logger, endUserId?: string) {
    this._api = new OpenAI({ apiKey });
    this.logger = logger ?? new Logger();
    this._endUserId = endUserId;
  }

  async getModelInfo(): Promise<ModelInfo[]> {
    // OpenAI's models.list() only returns known IDs and owners, not full model
    // info, so we hardcode the list from published stats.
    return [
      {
        id: ChatModels.GPT4_1,
        type: 'text' as const,
        name: 'GPT-4.1',
        backend: ModelBackend.OpenAI,
        contextWindow: 1_047_576,
        max_tokens: 32_768,
        can_stream: true,
        pricing: {
          1_047_576: {
            // $2 / 1M Input tokens, $8 / 1M Output tokens. @see https://platform.openai.com/docs/models/gpt-4.1
            input: 2 / 1_000_000,
            output: 8 / 1_000_000,
          },
        },
        supportsVision: true,
        supportsTools: true,
        supportsImageVariation: false,
        logoFile: 'OpenAI_Logo.svg',
        rank: 0,
        trainingCutoff: '2024-06-01',
        description:
          'Reliable for general-purpose text generation and analysis with a standard context window, suitable for a wide range of applications.',
      },
      {
        id: ChatModels.GPT4_1_MINI,
        type: 'text' as const,
        name: 'GPT-4.1 Mini',
        backend: ModelBackend.OpenAI,
        contextWindow: 1_047_576,
        max_tokens: 32_768,
        can_stream: true,
        pricing: {
          1_047_576: {
            // $0.40 / 1M Input tokens, $1.60 / 1M Output tokens. @see https://platform.openai.com/docs/models/gpt-4.1-mini
            input: 0.4 / 1_000_000,
            output: 1.6 / 1_000_000,
          },
        },
        supportsVision: true,
        supportsTools: true,
        supportsImageVariation: false,
        logoFile: 'OpenAI_Logo.svg',
        rank: 0,
        trainingCutoff: '2024-06-01',
        description:
          "OpenAI's balanced GPT-4.1 model offering optimal price-performance ratio. Ideal for tasks requiring intelligence and cost efficiency.",
      },
      {
        id: ChatModels.GPT4_1_NANO,
        type: 'text' as const,
        name: 'GPT-4.1 Nano',
        backend: ModelBackend.OpenAI,
        contextWindow: 1_047_576,
        max_tokens: 32_768,
        can_stream: true,
        pricing: {
          1_047_576: {
            // $0.10 / 1M Input tokens, $0.40 / 1M Output tokens. @see https://platform.openai.com/docs/models/gpt-4.1-nano
            input: 0.1 / 1_000_000,
            output: 0.4 / 1_000_000,
          },
        },
        supportsVision: true,
        supportsTools: true,
        supportsImageVariation: false,
        logoFile: 'OpenAI_Logo.svg',
        rank: 0,
        trainingCutoff: '2024-06-01',
        description:
          'Designed for high-volume, low-cost processing with rapid response times, ideal for budget-conscious applications.',
      },
      {
        id: ChatModels.GPT4_5_PREVIEW,
        type: 'text' as const,
        name: 'GPT-4.5 Preview',
        backend: ModelBackend.OpenAI,
        contextWindow: 128000,
        max_tokens: 16384,
        can_stream: true,
        pricing: {
          128000: { input: 75.0 / 1000000, output: 150.0 / 1000000 }, // $75 / 1M Input tokens, $150 / 1M Output tokens
        },
        supportsVision: true,
        supportsTools: true,
        supportsImageVariation: false,
        logoFile: 'OpenAI_Logo.svg',
        rank: 0, // Highest rank as it's the most capable model
        trainingCutoff: '2023-10',
        deprecationDate: '2025-08-01', // Deprecated as per https://platform.openai.com/docs/deprecations
        description:
          "OpenAI's most advanced preview model with enhanced world knowledge and superior intent understanding. Excellent for creative tasks and complex reasoning.",
      },
      {
        id: ChatModels.O1,
        type: 'text' as const,
        name: 'O1',
        backend: ModelBackend.OpenAI,
        contextWindow: 200000,
        max_tokens: 100000,
        can_stream: true,
        pricing: {
          200000: { input: 15 / 1000000, output: 60 / 1000000 }, // $15 / 1M Input tokens, $60 / 1M Output tokens
        },
        supportsVision: true,
        supportsTools: true,
        supportsImageVariation: false,
        logoFile: 'OpenAI_Logo.svg',
        rank: 0,
        deprecationDate: '2025-07-07', // Deprecated as per https://platform.openai.com/docs/deprecations
        description:
          "OpenAI's flagship reasoning model with massive 200K context window. Ideal for extensive document analysis and complex reasoning tasks.",
        isSlowModel: true,
      },
      {
        id: ChatModels.O3,
        type: 'text' as const,
        name: 'O3',
        backend: ModelBackend.OpenAI,
        contextWindow: 200_000,
        max_tokens: 100_000,
        can_stream: true,
        pricing: {
          200000: { input: 2 / 1_000_000, output: 8 / 1_000_000 }, // $2 / 1M Input tokens, $8 / 1M Output tokens
        },
        supportsVision: true,
        supportsTools: true,
        supportsImageVariation: false,
        logoFile: 'OpenAI_Logo.svg',
        rank: 0,
        trainingCutoff: '2024-06-01',
        description:
          "OpenAI's O3 reasoning model with broad capabilities and up-to-date training data. Superseded by O4 Mini for most use cases.",
        isSlowModel: true,
      },
      {
        id: ChatModels.O1_PREVIEW,
        type: 'text' as const,
        name: 'O1 Preview',
        backend: ModelBackend.OpenAI,
        contextWindow: 128000,
        max_tokens: 32768,
        supportsImageVariation: false,
        can_stream: true,
        pricing: {
          200000: { input: 15 / 1000000, output: 60 / 1000000 },
        },
        supportsVision: false,
        supportsTools: true,
        logoFile: 'OpenAI_Logo.svg',
        rank: 1,
        deprecationDate: '2025-07-28', // Deprecated as per https://platform.openai.com/docs/deprecations
        description:
          "OpenAI's reasoning model preview with advanced problem-solving capabilities. Ideal for complex analysis and logical reasoning tasks.",
        isSlowModel: true,
      },
      {
        id: ChatModels.O1_MINI,
        type: 'text' as const,
        name: 'O1 Mini',
        backend: ModelBackend.OpenAI,
        contextWindow: 128000,
        max_tokens: 65536,
        can_stream: true,
        pricing: {
          128000: { input: 1.1 / 1000000, output: 4.4 / 1000000 }, // $1.10 / 1M Input tokens, $4.40 / 1M Output tokens
        },
        supportsVision: false,
        supportsImageVariation: false,
        supportsTools: true,
        logoFile: 'OpenAI_Logo.svg',
        rank: 10,
        deprecationDate: '2025-10-27', // Deprecated as per https://platform.openai.com/docs/deprecations
        description:
          "OpenAI's cost-effective reasoning model delivering strong performance for everyday tasks and general content generation.",
        isSlowModel: true,
      },
      {
        id: ChatModels.O3_MINI,
        type: 'text',
        name: 'O3 Mini',
        backend: ModelBackend.OpenAI,
        contextWindow: 200000,
        max_tokens: 100000,
        can_stream: true,
        pricing: {
          200000: { input: 1.1 / 1000000, output: 4.4 / 1000000 }, // $1.10 / 1M Input tokens, $4.40 / 1M Output tokens
        },
        supportsVision: false,
        supportsImageVariation: false,
        supportsTools: true,
        logoFile: 'OpenAI_Logo.svg',
        rank: 3,
        deprecationDate: '2025-07-18', // Deprecated as per https://platform.openai.com/docs/deprecations
        description:
          "OpenAI's efficient O3 model with large context window. Great balance of performance and cost for extensive document processing.",
        isSlowModel: true,
      },
      {
        id: ChatModels.O4_MINI,
        type: 'text',
        name: 'O4 Mini',
        backend: ModelBackend.OpenAI,
        contextWindow: 200000,
        max_tokens: 100000,
        can_stream: true,
        can_think: true,
        pricing: {
          200000: { input: 1.1 / 1_000_000, output: 4.4 / 1_000_000 }, // $1.10 / 1M Input tokens, $4.40 / 1M Output tokens
        },
        supportsVision: true,
        supportsImageVariation: false,
        supportsTools: true,
        logoFile: 'OpenAI_Logo.svg',
        rank: 10,
        trainingCutoff: '2025-04-01',
        description:
          "OpenAI's compact reasoning model optimized for fast, cost-efficient performance with strong multimodal and agentic capabilities. Excellent for STEM tasks and coding.",
        isSlowModel: true,
      },

      // GPT 5.5
      {
        id: ChatModels.GPT5_5,
        type: 'text' as const,
        name: 'GPT-5.5',
        backend: ModelBackend.OpenAI,
        contextWindow: 1_050_000,
        max_tokens: 128_000,
        can_stream: true,
        can_think: false,
        pricing: {
          1_050_000: { input: 5.0 / 1_000_000, output: 30.0 / 1_000_000 }, // $5.00 / 1M Input tokens, $30.00 / 1M Output tokens
        },
        supportsVision: true,
        supportsImageVariation: false,
        supportsTools: true,
        logoFile: 'OpenAI_Logo.svg',
        rank: 0,
        trainingCutoff: '2025-12-01',
        releaseDate: '2026-04-27',
        description:
          "OpenAI's next-generation flagship GPT-5.5 model. A new class of intelligence for coding and professional work with a 1M+ context window, advanced reasoning, vision, and tool use.",
      },

      // GPT 5.4
      {
        id: ChatModels.GPT5_4,
        type: 'text' as const,
        name: 'GPT-5.4',
        backend: ModelBackend.OpenAI,
        contextWindow: 1_050_000,
        max_tokens: 128_000,
        can_stream: true,
        can_think: true,
        pricing: {
          400000: { input: 2.5 / 1_000_000, output: 15.0 / 1_000_000 }, // $2.50 / 1M Input tokens, $15.00 / 1M Output tokens
        },
        supportsVision: true,
        supportsImageVariation: false,
        supportsTools: true,
        logoFile: 'OpenAI_Logo.svg',
        rank: 1,
        trainingCutoff: '2025-08-31',
        releaseDate: '2026-03-05',
        description:
          'High-performing GPT-5.4 model with strong reasoning, creativity, and vision understanding. A reliable workhorse in the GPT-5 family.',
      },
      {
        id: ChatModels.GPT5_4_MINI,
        type: 'text' as const,
        name: 'GPT-5.4 Mini',
        backend: ModelBackend.OpenAI,
        contextWindow: 400_000,
        max_tokens: 128_000,
        can_stream: true,
        can_think: true,
        pricing: {
          400000: { input: 0.75 / 1_000_000, output: 4.5 / 1_000_000 }, // $0.75 / 1M Input tokens, $4.50 / 1M Output tokens
        },
        supportsVision: true,
        supportsImageVariation: false,
        supportsTools: true,
        logoFile: 'OpenAI_Logo.svg',
        rank: 1,
        trainingCutoff: '2025-08-31',
        releaseDate: '2026-03-17',
        description:
          'Compact GPT-5.4 variant balancing strong performance with lower cost. Great for everyday tasks needing solid reasoning and vision.',
      },
      {
        id: ChatModels.GPT5_4_NANO,
        type: 'text' as const,
        name: 'GPT-5.4 Nano',
        backend: ModelBackend.OpenAI,
        contextWindow: 400_000,
        max_tokens: 128_000,
        can_stream: true,
        can_think: true,
        pricing: {
          400000: { input: 0.2 / 1_000_000, output: 1.25 / 1_000_000 }, // $0.20 / 1M Input tokens, $1.25 / 1M Output tokens
        },
        supportsVision: true,
        supportsImageVariation: false,
        supportsTools: true,
        logoFile: 'OpenAI_Logo.svg',
        rank: 1,
        trainingCutoff: '2025-08-31',
        releaseDate: '2026-03-17',
        description:
          'Ultra-lightweight GPT-5.4 model optimized for speed and cost efficiency. Ideal for high-volume workloads and quick interactions.',
      },

      // GPT 5.2
      {
        id: ChatModels.GPT5_2,
        type: 'text' as const,
        name: 'GPT-5.2',
        backend: ModelBackend.OpenAI,
        contextWindow: 400_000,
        max_tokens: 128_000,
        can_stream: true,
        can_think: false,
        pricing: {
          400000: { input: 1.75 / 1_000_000, output: 14.0 / 1_000_000 }, // $1.75 / 1M Input tokens, $14.00 / 1M Output tokens
        },
        supportsVision: true,
        supportsImageVariation: false,
        supportsTools: true,
        logoFile: 'OpenAI_Logo.svg',
        rank: 1,
        trainingCutoff: '2025-08-31',
        releaseDate: '2025-12-12',
        description:
          'Previous-generation GPT-5 flagship with robust multimodal understanding and deep analytical capabilities.',
        isSlowModel: true,
      },
      {
        id: ChatModels.GPT5_2_CHAT_LATEST,
        type: 'text' as const,
        name: 'GPT-5.2 Chat Latest',
        backend: ModelBackend.OpenAI,
        contextWindow: 128_000,
        max_tokens: 16_384,
        can_stream: true,
        can_think: false,
        pricing: {
          128_000: { input: 1.75 / 1_000_000, output: 14.0 / 1_000_000 }, // $1.25 / 1M Input tokens, $10.00 / 1M Output tokens
        },
        supportsVision: true,
        supportsImageVariation: false,
        supportsTools: true,
        logoFile: 'OpenAI_Logo.svg',
        rank: 1,
        trainingCutoff: '2024-09-30',
        releaseDate: '2025-11-13',
        description: 'Latest GPT-5.2 model version. Automatically updated with improvements and optimizations.',
      },

      // GPT 5.1
      {
        id: ChatModels.GPT5_1,
        type: 'text' as const,
        name: 'GPT-5.1',
        backend: ModelBackend.OpenAI,
        contextWindow: 400_000,
        max_tokens: 128_000,
        can_stream: true,
        can_think: false,
        pricing: {
          400000: { input: 1.25 / 1_000_000, output: 10.0 / 1_000_000 }, // $1.25 / 1M Input tokens, $10.00 / 1M Output tokens
        },
        supportsVision: true,
        supportsImageVariation: false,
        supportsTools: true,
        logoFile: 'OpenAI_Logo.svg',
        rank: 1,
        trainingCutoff: '2024-10-01',
        releaseDate: '2025-11-13',
        description:
          'Early GPT-5 series model with solid reasoning and vision support. Reliable for general-purpose tasks at competitive pricing.',
        isSlowModel: true,
      },
      {
        id: ChatModels.GPT5_1_CHAT_LATEST,
        type: 'text' as const,
        name: 'GPT-5.1 Chat Latest',
        backend: ModelBackend.OpenAI,
        contextWindow: 400_000,
        max_tokens: 128_000,
        can_stream: true,
        can_think: false,
        pricing: {
          400000: { input: 1.25 / 1_000_000, output: 10.0 / 1_000_000 }, // $1.25 / 1M Input tokens, $10.00 / 1M Output tokens
        },
        supportsVision: true,
        supportsImageVariation: false,
        supportsTools: true,
        logoFile: 'OpenAI_Logo.svg',
        rank: 1,
        trainingCutoff: '2024-09-30',
        releaseDate: '2025-11-13',
        description:
          'Continuously updated GPT-5.1 chat model with advanced conversational abilities and vision support, ideal for dynamic, real-time applications.',
      },

      // GPT-5 Family
      {
        id: ChatModels.GPT5,
        type: 'text' as const,
        name: 'GPT-5',
        backend: ModelBackend.OpenAI,
        contextWindow: 400_000,
        max_tokens: 128_000,
        can_stream: true,
        can_think: false,
        pricing: {
          400000: { input: 1.25 / 1_000_000, output: 10.0 / 1_000_000 }, // $1.25 / 1M Input tokens, $10.00 / 1M Output tokens
        },
        supportsVision: true,
        supportsImageVariation: false,
        supportsTools: true,
        logoFile: 'OpenAI_Logo.svg',
        rank: 2,
        trainingCutoff: '2024-10-01',
        releaseDate: '2025-08-07',
        description:
          "OpenAI's advanced language model with exceptional reasoning, creativity, and multimodal capabilities. Ideal for complex tasks requiring deep understanding.",
        isSlowModel: true,
      },
      {
        id: ChatModels.GPT5_MINI,
        type: 'text' as const,
        name: 'GPT-5 Mini',
        backend: ModelBackend.OpenAI,
        contextWindow: 400_000,
        max_tokens: 128_000,
        can_stream: true,
        can_think: false,
        pricing: {
          400000: { input: 0.25 / 1_000_000, output: 2.0 / 1_000_000 }, // $0.25 / 1M Input tokens, $2.00 / 1M Output tokens
        },
        supportsVision: true,
        supportsImageVariation: false,
        supportsTools: true,
        logoFile: 'OpenAI_Logo.svg',
        rank: 2,
        trainingCutoff: '2024-05-31',
        releaseDate: '2025-08-07',
        description:
          'Efficient multimodal model with vision and tool support, suitable for cost-sensitive tasks requiring image analysis and extended context.',
      },
      {
        id: ChatModels.GPT5_NANO,
        type: 'text' as const,
        name: 'GPT-5 Nano',
        backend: ModelBackend.OpenAI,
        contextWindow: 400_000,
        max_tokens: 64_000,
        can_stream: true,
        can_think: false,
        pricing: {
          400000: { input: 0.05 / 1_000_000, output: 0.4 / 1_000_000 }, // $0.05 / 1M Input tokens, $0.40 / 1M Output tokens
        },
        supportsVision: false,
        supportsImageVariation: false,
        supportsTools: true,
        logoFile: 'OpenAI_Logo.svg',
        rank: 3,
        trainingCutoff: '2024-05-31',
        releaseDate: '2025-08-07',
        description:
          'Ultra-efficient GPT-5 variant designed for lightweight tasks and edge deployment. Exceptional value for routine operations.',
      },
      {
        id: ChatModels.GPT5_CHAT_LATEST,
        type: 'text' as const,
        name: 'GPT-5 Chat Latest',
        backend: ModelBackend.OpenAI,
        contextWindow: 400_000,
        // chat-latest snapshot caps completion at 16384 tokens (matches gpt-5.2-chat-latest)
        max_tokens: 16_384,
        can_stream: true,
        can_think: false,
        pricing: {
          400000: { input: 1.25 / 1_000_000, output: 10.0 / 1_000_000 }, // $1.25 / 1M Input tokens, $10.00 / 1M Output tokens
        },
        supportsVision: true,
        supportsImageVariation: false,
        supportsTools: true,
        logoFile: 'OpenAI_Logo.svg',
        rank: 3,
        trainingCutoff: '2024-09-30',
        releaseDate: '2025-08-07',
        description:
          'Continuously updated GPT-5 chat model with advanced conversational abilities and vision support, ideal for dynamic, real-time applications.',
      },
      {
        id: ChatModels.GPT4o,
        type: 'text' as const,
        name: 'GPT-4o',
        backend: ModelBackend.OpenAI,
        contextWindow: 128000,
        max_tokens: 4096,
        can_stream: true,
        pricing: {
          8000: { input: 2.5 / 1000000, output: 10 / 1000000 }, // $2.50 / 1M Input tokens, $10 / 1M Output tokens
        },
        supportsVision: true,
        supportsImageVariation: false,
        logoFile: 'OpenAI_Logo.svg',
        rank: 10,
        supportsTools: true,
        description:
          "OpenAI's multimodal model with strong vision capabilities and reasoning. Good for tasks requiring image understanding and complex tool use.",
      },
      {
        id: ChatModels.GPT4o_MINI,
        type: 'text' as const,
        name: 'GPT-4o Mini',
        backend: ModelBackend.OpenAI,
        contextWindow: 128000,
        max_tokens: 16384,
        can_stream: true,
        pricing: {
          8000: { input: 0.15 / 1000000, output: 0.6 / 1000000 }, // $0.15 / 1M Input tokens, $0.60 / 1M Output tokens
        },
        supportsVision: true,
        supportsImageVariation: false,
        logoFile: 'OpenAI_Logo.svg',
        rank: 10,
        supportsTools: true,
        description:
          "OpenAI's cost-effective multimodal model with vision capabilities. Good for routine tasks requiring image understanding at lower cost.",
      },
      {
        id: ChatModels.GPT4_TURBO,
        type: 'text' as const,
        name: 'GPT-4 Turbo',
        backend: ModelBackend.OpenAI,
        supportsImageVariation: false,
        contextWindow: 128000,
        max_tokens: 4096,
        can_stream: true,
        pricing: {
          128000: { input: 10 / 1000000, output: 30 / 1000000 }, // $10 / 1M Input tokens, $30 / 1M Output tokens
        },
        supportsVision: true,
        logoFile: 'OpenAI_Logo.svg',
        rank: 10,
        supportsTools: true,
        description:
          'Delivers fast, efficient text generation with advanced reasoning, a large context window, and integrated vision and tool capabilities.',
      },
      {
        id: ChatModels.GPT4,
        type: 'text' as const,
        name: 'GPT-4',
        backend: ModelBackend.OpenAI,
        contextWindow: 8192,
        max_tokens: 8192,
        can_stream: true,
        pricing: {
          8000: { input: 30 / 1000000, output: 60.0 / 1000000 }, // $30 / 1M Input tokens, $60 / 1M Output tokens
        },
        supportsVision: false,
        supportsImageVariation: false,
        logoFile: 'OpenAI_Logo.svg',
        rank: 11,
        supportsTools: false,
        description:
          "OpenAI's original GPT-4 model. Legacy model good for basic tasks and content generation, but newer models offer better capabilities.",
      },
      // OpenAI Image Models
      {
        id: ImageModels.GPT_IMAGE_1,
        type: 'image',
        name: 'GPT-Image-1',
        backend: ModelBackend.OpenAI,
        contextWindow: 10000,
        supportsImageVariation: true,
        max_tokens: 10000,
        pricing: {
          1: { input: 8 / 1000000, output: 32 / 1000000 }, // $8 / 1M Input tokens, $32 / 1M Output tokens
        },
        description:
          'OpenAI GPT-Image-1 - Advanced multimodal image generation with text integration, supporting up to 2048x2048 resolution and image editing capabilities.',
        rank: 10,
      },
      {
        id: ImageModels.GPT_IMAGE_1_5,
        type: 'image',
        name: 'GPT-Image-1.5',
        backend: ModelBackend.OpenAI,
        contextWindow: 10000,
        supportsImageVariation: true,
        max_tokens: 10000,
        pricing: {
          1: { input: 8 / 1000000, output: 32 / 1000000 }, // $8 / 1M Input tokens, $32 / 1M Output tokens (same as GPT-Image-1)
        },
        description:
          'OpenAI GPT-Image-1.5 - Enhanced version of GPT-Image-1 with improved image generation quality and text integration, supporting up to 2048x2048 resolution and image editing capabilities.',
        rank: 9,
      },
      {
        id: ImageModels.GPT_IMAGE_2,
        type: 'image',
        name: 'GPT-Image-2',
        backend: ModelBackend.OpenAI,
        contextWindow: 10000,
        supportsImageVariation: true,
        max_tokens: 10000,
        pricing: {
          1: { input: 8 / 1000000, output: 30 / 1000000 },
        },
        description:
          'OpenAI GPT-Image-2 - State-of-the-art image generation with flexible resolutions up to 4K, improved quality, and fast generation. Supports editing and multi-image reference inputs.',
        rank: 8,
        releaseDate: '2026-04-21',
      },
      {
        id: ImageModels.GPT_IMAGE_1_MINI,
        type: 'image',
        name: 'GPT-Image-1 Mini',
        backend: ModelBackend.OpenAI,
        contextWindow: 10000,
        supportsImageVariation: true,
        max_tokens: 10000,
        pricing: {
          1: { input: 4 / 1000000, output: 16 / 1000000 }, // Lower pricing for mini variant
        },
        description:
          'OpenAI GPT-Image-1 Mini - Faster, cost-effective version of GPT-Image-1 with good quality image generation and text integration, supporting up to 2048x2048 resolution and image editing capabilities.',
        rank: 11,
      },
      // OpenAI Speech-to-Text Models
      {
        id: SpeechToTextModels.WHISPER_1,
        type: 'speech-to-text',
        // private: true,
        name: 'Whisper-1',
        backend: ModelBackend.OpenAI,
        contextWindow: 25_000_000, // ~25MB file limit
        max_tokens: 448,
        can_stream: false,
        pricing: {
          60: { input: 0.006 / 60, output: 0 }, // $0.006 per minute
        },
        supportsVision: false,
        supportsTools: false,
        supportsImageVariation: false,
        logoFile: 'OpenAI_Logo.svg',
        rank: 11,
        description:
          "OpenAI's speech-to-text model supporting multiple languages and audio formats. Optimized for transcription and translation tasks.",
      },
      // OpenAI Video Models (Sora)
      {
        id: VideoModels.SORA_2,
        type: 'video',
        name: 'Sora',
        backend: ModelBackend.OpenAI,
        contextWindow: 10000, // Prompt length limit
        max_tokens: 10000,
        can_stream: false,
        pricing: {
          // Pricing per video based on duration: 4s = $0.25, 8s = $0.50, 12s = $0.75
          1: { input: 0.25, output: 0 },
        },
        supportsVision: false,
        supportsTools: false,
        supportsImageVariation: false,
        logoFile: 'OpenAI_Logo.svg',
        rank: 1,
        description:
          "OpenAI's Sora video generation model. Creates high-quality videos from text prompts with durations of 4, 8, or 12 seconds.",
      },
      {
        id: VideoModels.SORA_2_PRO,
        type: 'video',
        name: 'Sora Pro',
        backend: ModelBackend.OpenAI,
        contextWindow: 10000, // Prompt length limit
        max_tokens: 10000,
        can_stream: false,
        pricing: {
          // Pricing per video based on duration: 4s = $0.50, 8s = $1.00, 12s = $1.50
          1: { input: 0.5, output: 0 },
        },
        supportsVision: false,
        supportsTools: false,
        supportsImageVariation: false,
        logoFile: 'OpenAI_Logo.svg',
        rank: 0,
        description:
          "OpenAI's premium Sora video generation model. Produces the highest quality videos with enhanced detail, coherence, and visual fidelity.",
      },
    ];
  }

  /**
   * Request a chat-based completion from the LLM.  The response is delivered
   * by calling the caller-provided `cb()`.  It may be called once if the reply
   * is delivered as a single response, or may come in chunks, if streaming, with
   * each chunk being the additional new text generated by the model.
   * Caller should await this function to ensure the completion is complete. Any
   * errors will be thrown.
   */
  // The OpenAI API uses max_completion_tokens for O1 and GPT-5 models instead of max_tokens.
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

    // Multi-turn token accumulators. Each OpenAI API call (every recursive
    // tool round-trip) is billed independently, so we add each turn's usage
    // and emit the running total on every cb call. wrappedOnChunk in
    // cliCompletions assigns rather than adds, so emitting accum+thisTurn
    // keeps the running total correct across recursive turns. Non-emitting
    // tool-result transient cb calls intentionally keep tokens at 0.
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
          // Reset a caller-forced tool_choice to 'auto' on recursion so it can't
          // persist past the first turn. (Tools are dropped here and tool_choice is
          // only applied when tools are present, so this is just an explicit invariant.)
          tool_choice: 'auto',
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

    // Reasoning models in the GPT-5 narrator family silently break tool calling on
    // /v1/chat/completions (they write the call as text instead of emitting a real
    // tool_call). Route those turns to the Responses API, where
    // reasoning + tools work together and `reasoning_effort` is preserved. Only when
    // function tools are actually present; the terminal (no-tools) synthesis turn
    // falls through to the streaming chat path below.
    if (options.tools?.length && RESPONSES_API_TOOL_MODELS.has(model)) {
      return this.completeViaResponses(model, messages, options, callback, toolsUsed);
    }

    const isO1Model = O1_MODELS.includes(model);
    const isGPT5Model = GPT5_MODELS.includes(model);
    const isGPT5_1Model = GPT5_1_MODELS.includes(model);
    const isGPT5_2Model = GPT5_2_MODELS.includes(model);
    const isGPT5_4Model = GPT5_4_MODELS.includes(model);
    const isGPT5_5Model = GPT5_5_MODELS.includes(model);
    const usesMaxCompletionTokens =
      isO1Model || isGPT5Model || isGPT5_1Model || isGPT5_2Model || isGPT5_4Model || isGPT5_5Model;
    // GPT-5.1/5.2/5.4 share the same complexity->reasoning-effort mapping (effortMap_GPT5_1_2).
    const usesGPT5EffortMap = isGPT5_1Model || isGPT5_2Model || isGPT5_4Model;

    // Base parameters that work for all models
    const parameters: ChatCompletionCreateParams & ReasoningParameter = {
      model,
      messages: this.formatMessages(messages, isO1Model, model, options),
      temperature: options.temperature ?? 0.9,
      // Attribute the request to the end user (opaque, non-PII) so OpenAI can
      // scope abuse enforcement to them instead of the shared platform key.
      ...(this._endUserId ? { safety_identifier: this._endUserId } : {}),
    };

    // Add parameters conditionally based on model type
    const supportsReasoning = REASONING_SUPPORTED_MODELS.has(model);
    const requiresFixedTemp = FIXED_TEMPERATURE_MODELS.has(model);
    if (usesMaxCompletionTokens) {
      // Force temperature to 1.0 for models in FIXED_TEMPERATURE_MODELS
      // (reasoning models, chat-latest variants, and GPT-5.5).
      // Otherwise temperature stays user-configurable.
      Object.assign(parameters, {
        ...(requiresFixedTemp && { temperature: 1.0 }),
        stream: true,
        stream_options: { include_usage: true },
        ...(options.maxTokens && { max_completion_tokens: options.maxTokens }),
      });

      // Only add reasoning_effort for models that support it (o1-preview/o1-mini do not).
      // Also skip when function tools are present for models where OpenAI rejects the
      // combination on /v1/chat/completions (currently GPT-5.4 family). Until we wire up
      // /v1/responses, dropping reasoning_effort keeps tool calling functional.
      const toolsPresent = !!options.tools?.length;
      const reasoningEffortIncompatibleWithTools =
        toolsPresent && REASONING_EFFORT_INCOMPATIBLE_WITH_TOOLS_MODELS.has(model);

      if (supportsReasoning && !reasoningEffortIncompatibleWithTools) {
        // Determine reasoning effort: explicit setting takes precedence over auto-classification
        let reasoningEffort: ReasoningEffort | undefined;

        if (options.reasoningEffort) {
          // User explicitly set reasoning effort - use it directly
          reasoningEffort = options.reasoningEffort;
          this.logger.debug(`Using explicit reasoning effort: ${reasoningEffort}`);
        } else if (options.complexity && effortMap[options.complexity]) {
          // Auto-classify based on query complexity
          reasoningEffort = usesGPT5EffortMap ? effortMap_GPT5_1_2[options.complexity] : effortMap[options.complexity];
          this.logger.debug(
            `Auto-classified reasoning effort from complexity '${options.complexity}': ${reasoningEffort}`
          );
        }

        if (reasoningEffort) {
          Object.assign(parameters, {
            reasoning_effort: reasoningEffort,
          });
        }
      } else if (supportsReasoning && reasoningEffortIncompatibleWithTools) {
        // `supportsReasoning` is re-checked here so the log only fires for models
        // where `reasoning_effort` would otherwise have been set. Today the set
        // invariant (REASONING_EFFORT_INCOMPATIBLE_WITH_TOOLS_MODELS is a subset of
        // REASONING_SUPPORTED_MODELS) makes the two checks equivalent, but the
        // explicit conjunction prevents a noisy log if that invariant ever drifts.
        this.logger.debug(
          `Skipping reasoning_effort for ${model}: function tools present, ` +
            `OpenAI rejects this combination on /v1/chat/completions (requires /v1/responses).`
        );
      }
    } else {
      // OpenAI API doesn't support streaming with n > 1
      const useStreaming = options.stream && (!options.n || options.n === 1);

      // Non-O1 models support these parameters
      Object.assign(parameters, {
        top_p: options.topP,
        // n is only used for non-streaming completions; default 1.
        n: options.n || 1,
        stop: options.stop,
        logit_bias: options.logitBias,
        presence_penalty: options.presencePenalty,
        frequency_penalty: options.frequencyPenalty,
        stream: useStreaming,
        max_tokens: options.maxTokens,
        ...(useStreaming && { stream_options: { include_usage: true } }),
      });
    }

    if (options.tools?.length) {
      parameters.tools = this.formatTools(options.tools);

      // Apply tool_choice if specified (forces model to use specific tool)
      if (options.tool_choice) {
        parameters.tool_choice = options.tool_choice;
      }

      // Apply parallel_tool_calls if specified (should be false for structured outputs)
      if (options.parallel_tool_calls !== undefined) {
        parameters.parallel_tool_calls = options.parallel_tool_calls;
      }
    }

    // Structured output via OpenAI's native response_format.
    // OpenAI's strict-mode subset rejects schemas that contain `oneOf` at the
    // top level, mix `additionalProperties` settings, or use unsupported
    // primitive types. We pass the schema through as-is and surface OpenAI's
    // 400 to the caller so the contract violation is reported at the source.
    if (options.responseFormat?.type === 'json_schema') {
      const rf = options.responseFormat;
      // Cast to any: OpenAI's typed `response_format` lives on a newer
      // ChatCompletionCreateParams but TS sees the older shape here.
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

    // Wrap with retry for transient network errors (TLS abort, fetch terminated)
    const response = await withRetry(
      () =>
        this._api.chat.completions.create(parameters as ChatCompletionCreateParams, {
          signal: options.abortSignal,
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
    let inputTokens = 0;
    let outputTokens = 0;

    if (!(response instanceof Stream)) {
      const streamedText: string[] = [];

      if (!response.choices || response.choices.length === 0) {
        throw new Error('No choices returned from OpenAI API');
      }

      for (const c of response.choices) {
        if (!c.message) continue;

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
              isMcpTool: boolean;
            };
            const resolvedTools: ResolvedTool[] = [];
            for (const toolCall of c.message.tool_calls) {
              if (toolCall.type !== 'function' || !toolCall.function.arguments) continue;
              const toolDef = options.tools?.find(t => t.toolSchema.name === toolCall.function.name);
              const toolFn = toolDef?.toolFn;
              if (!toolFn) continue;
              try {
                const parsedParams = JSON.parse(toolCall.function.arguments);
                resolvedTools.push({
                  id: toolCall.id,
                  name: toolCall.function.name,
                  parameters: toolCall.function.arguments,
                  parsedParams,
                  toolFn,
                  isMcpTool: toolDef?._isMcpTool ?? false,
                });
              } catch {
                this.logger.warn(`JSON parse error for ${toolCall.function.name} arguments`);
                const entry = toolsUsed.find(t => t.name === toolCall.function.name && t.id === toolCall.id);
                if (entry) entry.arguments = '{}';
              }
            }

            // Execute tools - parallel by default, sequential when opted out
            const parallelEnabled = options.parallelToolExecution !== false;

            type ToolPayload = {
              id: string;
              name: string;
              parameters: string;
              isMcpTool: boolean;
              result: { toString(): string };
            };

            this.logger.debug('[Tool Execution] Executing tools (OpenAI non-streaming)', {
              mode: parallelEnabled && resolvedTools.length > 1 ? 'parallel' : 'sequential',
              toolNames: resolvedTools.map(t => t.name),
            });

            const batchOutcomes = await executeToolsBatch<ToolPayload>(
              resolvedTools.map(({ id, name, parameters, parsedParams, toolFn, isMcpTool }) => async () => {
                this.logger.debug('Using tool:', name);
                const result = await toolFn(parsedParams);
                return { id, name, parameters, isMcpTool, result };
              }),
              { parallel: parallelEnabled, maxConcurrency: options.maxParallelTools }
            );

            type ToolOutcome =
              | {
                  ok: true;
                  id: string;
                  name: string;
                  parameters: string;
                  isMcpTool: boolean;
                  result: { toString(): string };
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

            // Inject results in original order; track artifact streaming for deduplication.
            let anyArtifactWasStreamed = false;
            // Keep tools if any resolved tool was an MCP tool - regardless of execution outcome.
            // Using resolvedTools (not outcomes) because a failing MCP tool should still enable
            // chaining: the model needs tools available to retry or continue the chain.
            const anyMcpTool = resolvedTools.some(t => t.isMcpTool);

            for (const outcome of outcomes) {
              if (!outcome.ok) {
                if (outcome.error instanceof PermissionDeniedError) throw outcome.error;
                const errorMsg = `Error processing ${outcome.name} tool: ${
                  outcome.error instanceof Error ? outcome.error.message : 'Unknown error'
                }`;
                streamedText[c.index] = errorMsg;
                // Push error result so the model can acknowledge the failure
                this.pushToolMessages(
                  messages,
                  { id: outcome.id, name: outcome.name, parameters: outcome.parameters },
                  errorMsg
                );
                continue;
              }

              const resultStr = outcome.result.toString();
              this.logger.debug(
                `[Tool Result] Tool executed for ${outcome.name}:`,
                resultStr.substring(0, 200) + '...'
              );

              // Track per-outcome whether this specific tool produced artifacts,
              // so we only sanitize the tool result that actually had artifacts streamed.
              let thisToolHadArtifact = false;

              // Stream artifact-generating tool results immediately to the client.
              await handleToolResultStreaming(outcome.name, outcome.result, async results => {
                thisToolHadArtifact = true;
                anyArtifactWasStreamed = true;
                await callback(results, {
                  inputTokens: 0,
                  outputTokens: 0,
                  toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
                });
              });

              // Sanitize artifact tags from tool result before pushing to conversation history.
              // The artifact has already been streamed to the client via handleToolResultStreaming(),
              // so GPT doesn't need raw <artifact> markup - which it tends to echo verbatim,
              // causing duplicate artifacts.
              const sanitizedResult = thisToolHadArtifact
                ? resultStr.replace(
                    /<artifact(?:\s[^>]*)?>[\s\S]*?<\/artifact>/gi,
                    '[Artifact rendered and delivered to user]'
                  )
                : resultStr;

              this.pushToolMessages(
                messages,
                { id: outcome.id, name: outcome.name, parameters: outcome.parameters },
                sanitizedResult
              );
            }

            // Make one recursive call after all tools have been processed.
            // If any artifact was already streamed, buffer and strip duplicates from recursive response.
            let recursiveBuffer = '';
            let recursiveMeta: CompletionInfo = { inputTokens: 0, outputTokens: 0 };
            const recursiveCallback: typeof callback = anyArtifactWasStreamed
              ? async (results, meta) => {
                  for (const r of results) {
                    if (r != null) recursiveBuffer += r;
                  }
                  if (meta.inputTokens || meta.outputTokens) {
                    recursiveMeta = { ...meta };
                  }
                }
              : callback;

            // Keep tools available for MCP tools (enables chaining); remove for built-in tools
            // Carry this turn's tokens forward so the terminal recursive call's
            // emits carry the full multi-turn billable total (each OpenAI API
            // call is billed independently - accumulating is required for
            // correct credit attribution).
            await this.complete(
              model,
              messages,
              {
                ...options,
                tools: anyMcpTool ? options.tools : undefined,
                // First-turn-only tool_choice: after tools run, let the model synthesize.
                tool_choice: 'auto',
                _internal: {
                  ...options._internal,
                  toolCallCount: toolCallCount + 1,
                  accumInputTokens: accumInputTokens + (response.usage?.prompt_tokens || 0),
                  accumOutputTokens: accumOutputTokens + (response.usage?.completion_tokens || 0),
                },
              },
              recursiveCallback,
              toolsUsed
            );

            if (anyArtifactWasStreamed && recursiveBuffer) {
              const cleaned = recursiveBuffer.replace(/<artifact(?:\s[^>]*)?>[\s\S]*?<\/artifact>/gi, '').trim();
              if (cleaned) {
                await callback([cleaned], recursiveMeta);
              }
            }

            return;
          } else {
            // Pass tool calls through callback without executing.
            // Terminal leaf - emit accumulated total plus this turn's tokens.
            this.logger.debug(`[Tool Execution] executeTools=false, passing tool calls to callback`);
            await callback([null], {
              inputTokens: accumInputTokens + (response.usage?.prompt_tokens || 0),
              outputTokens: accumOutputTokens + (response.usage?.completion_tokens || 0),
              toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
            });
            return;
          }
        } else {
          streamedText[c.index] = c.message.content || '';
        }
      }

      // Extract cache stats if caching is enabled (OpenAI caching is automatic)
      const cacheStrategy = options.cacheStrategy;
      let cacheStats: CacheUsageStats | undefined;

      if (cacheStrategy?.enableCaching && response.usage) {
        const adapter = getCachingAdapter(ModelBackend.OpenAI);
        cacheStats = adapter.extractCacheStats(response as unknown as Record<string, unknown>, model);

        if (cacheStats) {
          logCacheStats(this.logger, cacheStats, { streaming: false });
        }
      }

      // Terminal turn - no choice had tool_calls (otherwise we'd have returned
      // above). Emit accumulated total plus this turn's tokens.
      const completionInfo = {
        inputTokens: accumInputTokens + (response.usage?.prompt_tokens || 0),
        outputTokens: accumOutputTokens + (response.usage?.completion_tokens || 0),
        toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
        cacheStats,
        ...(options.responseFormat?.type === 'json_schema' ? { responseFormatMode: 'native' as const } : {}),
      };
      await callback(streamedText, completionInfo);
      return;
    }

    const func: { name?: string; id?: string; parameters?: string }[] = [];
    let cachedTokensFromStream = 0;
    let chunkCount = 0;
    let usageChunkCount = 0;
    for await (const chunk of response) {
      chunkCount++;
      const streamedText: string[] = [];
      if (chunk.usage) {
        usageChunkCount++;
        this.logger.debug('[OpenAI] Chunk has usage data', {
          chunkNumber: chunkCount,
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
          promptTokenDetails: chunk.usage.prompt_tokens_details,
        });

        inputTokens = Math.max(inputTokens, chunk.usage?.prompt_tokens || 0);
        outputTokens += chunk.usage?.completion_tokens || 0;
        // Capture cached tokens if available in streaming response.
        // Do NOT forward this to CompletionInfo.cacheReadInputTokens: OpenAI's
        // prompt_tokens INCLUDE cached tokens (unlike Anthropic, where the fields
        // are disjoint), so forwarding without subtracting from inputTokens would
        // double-bill the cached portion in provider-basis settlement.
        if (chunk.usage.prompt_tokens_details?.cached_tokens !== undefined) {
          cachedTokensFromStream = chunk.usage.prompt_tokens_details.cached_tokens;
          if (cachedTokensFromStream > 0) {
            this.logger.debug('[OpenAI] Captured cached tokens', {
              cachedTokens: cachedTokensFromStream,
            });
          } else {
            this.logger.debug('[OpenAI] No cached tokens in chunk', {
              note: 'possible cache miss or first request',
            });
          }
        }
      }

      chunk?.choices.forEach((c: ChatCompletionChunk.Choice) => {
        if (!isO1Model) {
          c.delta.tool_calls?.forEach((tool: ChatCompletionChunk.Choice.Delta.ToolCall) => {
            func[tool.index] ||= { parameters: '' };
            func[tool.index].name ||= tool.function?.name;
            func[tool.index].id ||= tool.id;
            func[tool.index].parameters += tool.function?.arguments || '';
          });
        }

        if (c.delta.content) {
          streamedText[c.index] = (streamedText[c.index] || '') + c.delta.content;
        }
      });

      // Always call the callback to maintain streaming, even during tool processing.
      // Emit accumulated total + this turn's running tokens so wrappedOnChunk
      // (assign-not-add) ends each turn at the cumulative cross-turn total.
      await callback(streamedText, {
        inputTokens: accumInputTokens + inputTokens,
        outputTokens: accumOutputTokens + outputTokens,
        toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
      });
    }

    this.logger.debug('[OpenAI] Streaming completed', {
      totalChunks: chunkCount,
      chunksWithUsage: usageChunkCount,
      finalInputTokens: inputTokens,
      finalOutputTokens: outputTokens,
      finalCachedTokens: cachedTokensFromStream,
    });

    if (usageChunkCount === 0) {
      this.logger.debug('[OpenAI] No usage data received', {
        model,
        note: 'Expected for preview models - caching still works server-side but stats unavailable',
      });
    }

    // Extract cache stats after streaming completes (OpenAI caching is automatic)
    const cacheStrategy = options.cacheStrategy;
    let cacheStats: CacheUsageStats | undefined;

    if (cacheStrategy?.enableCaching && inputTokens > 0) {
      const adapter = getCachingAdapter(ModelBackend.OpenAI);
      // Create a response object with usage info for cache stats extraction
      const mockResponse = {
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          prompt_tokens_details: {
            // Use the cached tokens we captured from the streaming chunks
            cached_tokens: cachedTokensFromStream,
          },
        },
      };
      cacheStats = adapter.extractCacheStats(mockResponse, model);

      if (cacheStats) {
        logCacheStats(this.logger, cacheStats, { streaming: true });
      }
    }

    // When response_format=json_schema is set on the streaming path with no
    // tool calls, the per-chunk callback above already delivered the structured
    // text. Emit a final empty cb to surface `responseFormatMode: 'native'` so
    // the SSE consumer sees it on the last frame.
    if ((isO1Model || func.length === 0) && options.responseFormat?.type === 'json_schema') {
      await callback([], {
        inputTokens: accumInputTokens + inputTokens,
        outputTokens: accumOutputTokens + outputTokens,
        toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
        cacheStats,
        responseFormatMode: 'native',
      });
    }

    if (!isO1Model && func.length > 0) {
      // Track all tool usage first
      for (const tool of func) {
        if (tool.name && tool.parameters) {
          toolsUsed.push({
            name: tool.name,
            arguments: tool.parameters,
            id: tool.id,
          });
        }
      }

      // Check if we should execute tools or just report them
      if (options.executeTools !== false) {
        // Resolve executable tools from the accumulated func list
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
          const { id, name } = tool;
          if (!id || !name) continue;
          const parameters = tool.parameters || '{}';
          const toolDef = options.tools?.find(t => t.toolSchema.name === name);
          const toolFn = toolDef?.toolFn;
          if (!toolFn) continue;
          try {
            const parsedParams = JSON.parse(parameters);
            resolvedTools.push({ id, name, parameters, parsedParams, toolFn, isMcpTool: toolDef?._isMcpTool ?? false });
          } catch {
            this.logger.warn('JSON parse error for tool parameters (skipping):', { name, parameters });
            const entry = toolsUsed.find(t => t.name === name && t.id === id);
            if (entry) entry.arguments = '{}';
          }
        }

        // Execute tools - parallel by default, sequential when opted out
        const parallelEnabled = options.parallelToolExecution !== false;

        type ToolPayloadStream = {
          id: string;
          name: string;
          parameters: string;
          isMcpTool: boolean;
          result: { toString(): string };
        };

        this.logger.debug('[Tool Execution] Executing tools (OpenAI streaming)', {
          mode: parallelEnabled && resolvedTools.length > 1 ? 'parallel' : 'sequential',
          toolNames: resolvedTools.map(t => t.name),
        });

        const batchOutcomesStream = await executeToolsBatch<ToolPayloadStream>(
          resolvedTools.map(({ id, name, parameters, parsedParams, toolFn, isMcpTool }) => async () => {
            this.logger.debug('Using tool:', name);
            const result = await toolFn(parsedParams);
            return { id, name, parameters, isMcpTool, result };
          }),
          { parallel: parallelEnabled, maxConcurrency: options.maxParallelTools }
        );

        type ToolOutcome =
          | {
              ok: true;
              id: string;
              name: string;
              parameters: string;
              isMcpTool: boolean;
              result: { toString(): string };
            }
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

        // Inject results in original order; track whether any artifact was streamed
        // so we can strip duplicate artifacts from GPT's recursive follow-up.
        let anyArtifactWasStreamed = false;
        // Keep tools if any resolved tool was an MCP tool - regardless of execution outcome.
        // Using resolvedTools (not outcomes) because a failing MCP tool should still enable
        // chaining: the model needs tools available to retry or continue the chain.
        const anyMcpTool = resolvedTools.some(t => t.isMcpTool);

        for (const outcome of outcomes) {
          if (!outcome.ok) {
            if (outcome.error instanceof PermissionDeniedError) throw outcome.error;
            // Push error result so the model can acknowledge the failure
            this.pushToolMessages(
              messages,
              { id: outcome.id, name: outcome.name, parameters: outcome.parameters },
              `Error processing ${outcome.name} tool: ${outcome.error instanceof Error ? outcome.error.message : 'Unknown error'}`
            );
            continue;
          }

          const resultStr = outcome.result.toString();
          this.logger.debug(`[Tool Result] Tool executed for ${outcome.name}:`, resultStr.substring(0, 200) + '...');

          // Track per-outcome whether this specific tool produced artifacts,
          // so we only sanitize the tool result that actually had artifacts streamed.
          let thisToolHadArtifact = false;

          // Stream artifact-generating tool results immediately to the client.
          // Emit accum + this turn's tokens - same shape as the per-chunk emit
          // above so wrappedOnChunk's cumulative running total isn't reset by
          // a smaller this-turn-only value.
          await handleToolResultStreaming(outcome.name, outcome.result, async results => {
            thisToolHadArtifact = true;
            anyArtifactWasStreamed = true;
            await callback(results, {
              inputTokens: accumInputTokens + inputTokens,
              outputTokens: accumOutputTokens + outputTokens,
              toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
              cacheStats,
            });
          });

          // Sanitize artifact tags from tool result before pushing to conversation history.
          // The artifact has already been streamed to the client via handleToolResultStreaming(),
          // so GPT doesn't need raw <artifact> markup - which it tends to echo/reconstruct.
          const sanitizedResult = thisToolHadArtifact
            ? resultStr.replace(
                /<artifact(?:\s[^>]*)?>[\s\S]*?<\/artifact>/gi,
                '[Artifact rendered and delivered to user]'
              )
            : resultStr;

          this.pushToolMessages(
            messages,
            { id: outcome.id, name: outcome.name, parameters: outcome.parameters },
            sanitizedResult
          );
        }

        // If an artifact was already streamed to the client, buffer GPT's recursive
        // response and strip any <artifact> tags it may reconstruct from tool call
        // parameters. GPT models can rebuild artifacts even when the tool result is
        // sanitized, because they retain the original tool call arguments in context.
        if (anyArtifactWasStreamed) {
          let recursiveBuffer = '';
          let recursiveMeta: CompletionInfo = { inputTokens: 0, outputTokens: 0 };

          // Carry this turn's tokens forward so the recursive call's emits
          // carry the full multi-turn billable total (each OpenAI API call is
          // billed independently - accumulating is required for correct
          // credit attribution).
          await this.complete(
            model,
            messages,
            {
              ...options,
              tools: anyMcpTool ? options.tools : undefined,
              // First-turn-only tool_choice: after tools run, let the model synthesize.
              tool_choice: 'auto',
              _internal: {
                ...options._internal,
                toolCallCount: toolCallCount + 1,
                accumInputTokens: accumInputTokens + inputTokens,
                accumOutputTokens: accumOutputTokens + outputTokens,
              },
            },
            async (results, meta) => {
              for (const r of results) {
                if (r != null) recursiveBuffer += r;
              }
              if (meta.inputTokens || meta.outputTokens) {
                recursiveMeta = { ...meta };
              }
            },
            toolsUsed
          );

          // Strip artifact tags and forward cleaned text to the client
          const cleaned = recursiveBuffer.replace(/<artifact(?:\s[^>]*)?>[\s\S]*?<\/artifact>/gi, '').trim();
          if (cleaned) {
            await callback([cleaned], recursiveMeta);
          }
        } else {
          // No artifact was streamed - use normal callback
          // Keep tools available for MCP tools (enables chaining); remove for built-in tools
          // Carry accumulators forward as above.
          await this.complete(
            model,
            messages,
            {
              ...options,
              tools: anyMcpTool ? options.tools : undefined,
              // First-turn-only tool_choice: after tools run, let the model synthesize.
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
        }
      } else {
        // Pass tool calls through callback without executing.
        // Terminal leaf - emit accumulated total plus this turn's tokens.
        this.logger.debug(`[Tool Execution] executeTools=false, passing tool calls to callback`);
        await callback([null], {
          inputTokens: accumInputTokens + inputTokens,
          outputTokens: accumOutputTokens + outputTokens,
          toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
          cacheStats,
        });
      }
    }
  }

  private formatMessages(
    messages: IMessage[],
    isO1Model: boolean,
    model: string,
    options: Partial<ICompletionOptions>
  ): OpenAI.ChatCompletionMessageParam[] {
    const filteredMessages = isO1Model ? messages.filter(msg => msg.role !== 'system') : messages;

    // Get tool names from options.tools
    const toolNames = options.tools?.map(tool => tool.toolSchema.name) || [];
    const isGPT5Family =
      GPT5_MODELS.includes(model) ||
      GPT5_1_MODELS.includes(model) ||
      GPT5_2_MODELS.includes(model) ||
      GPT5_4_MODELS.includes(model) ||
      GPT5_5_MODELS.includes(model);

    // For GPT-5 models: do NOT list tool names in the system prompt when tools are provided
    // via the API's `tools` parameter. GPT-5 gets confused by dual descriptions (text + API)
    // and defaults to talking ABOUT tools instead of making native function calls.
    // For other models (GPT-4o, etc.): keep the existing behavior which works well.
    let systemContent: string;
    if (isGPT5Family) {
      systemContent = 'You are a helpful assistant.';
      if (toolNames.length > 0) {
        systemContent += ' Use the provided tools when appropriate. Present results clearly and naturally.';
      }
      systemContent += `\nOnly when someone asks, remember that you are specifically the ${model} model.`;
      if (toolNames.includes('web_search')) {
        systemContent +=
          '\nFor web search results, present clean human-readable answers. Do not expose raw search queries or API response metadata to the user.';
      }
    } else {
      systemContent = `You are a helpful assistant${toolNames.length > 0 ? ` with access to these tools:\n      - ${toolNames.join(', ')}: Available tools for various operations\n\n      When responding:\n      1. Identify when a task can be handled by an available tool\n      2. Use the appropriate tool for accurate results\n      3. For tools other than recharts: Explain what you're doing and why\n      4. For tools other than recharts: Present results in a clear, natural way with context\n      5. For tools other than recharts: Add relevant explanations or observations when needed` : '.'}`;
    }

    // Hoist any caller-supplied `role: 'system'` messages (e.g. org-authority guards,
    // CompanyFactsBinder context) into the lead system message instead of leaving them
    // buried inline in the conversation body. This mirrors AnthropicBackend's
    // consolidateSystemMessages so GPT-5.x weights this context the same way Claude does;
    // leaving it inline causes GPT-5.x to under-weight org context and false-fire
    // prompt-body self-checks like "No client selected".
    // Only hoist string `content`. Stringifying a content-block array or `null` would
    // inject literal JSON (or "null") into the prompt - silent prompt corruption, the exact
    // class of bug this change fixes. System content is a string in practice today.
    const callerSystem = filteredMessages
      .filter(
        (m): m is IMessage & { content: string } =>
          m.role === 'system' && typeof m.content === 'string' && m.content.length > 0
      )
      .map(m => m.content)
      .join('\n\n');
    const mergedContent = callerSystem ? `${systemContent}\n\n${callerSystem}` : systemContent;

    const systemMessage: OpenAI.ChatCompletionSystemMessageParam = {
      role: 'system',
      content: mergedContent,
    };

    // Convert B4M standard format (tool_use/tool_result) to OpenAI format (tool_calls/role:tool).
    // Exclude system messages from the body - they are now consolidated into systemMessage above.
    const nonSystemMessages = filteredMessages.filter(m => m.role !== 'system');
    const convertedMessages = convertMessagesToOpenAIFormat(nonSystemMessages);
    const formattedMessages = convertedMessages as OpenAI.ChatCompletionMessageParam[];

    // O1 models take no system message at all (their system content was already stripped
    // from filteredMessages above); every other model gets the consolidated lead message.
    return isO1Model ? formattedMessages : [systemMessage, ...formattedMessages];
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
      content: result,
      tool_call_id: tool.id,
    } as unknown as IMessage);
  }

  replaceLastToolResultObservation(messages: IMessage[], toolCallId: string, newObservation: string): void {
    replaceLastToolResultObservationOpenAI(messages, toolCallId, newObservation);
  }

  getLatestToolCallId(messages: IMessage[], toolName: string): string | undefined {
    return getLatestToolCallIdOpenAI(messages, toolName);
  }

  formatTools(tools: ICompletionOptionTools[] = []) {
    return tools.map(tool => ({
      type: 'function' as const,
      function: tool.toolSchema,
    }));
  }

  /**
   * Tool shape for the Responses API - a FLAT function tool (`{type,name,parameters,...}`),
   * unlike Chat Completions' nested `{type:'function', function:{...}}` (see formatTools).
   */
  private formatToolsForResponses(tools: ICompletionOptionTools[] = []): ResponsesTool[] {
    return tools.map(tool => ({
      type: 'function' as const,
      name: tool.toolSchema.name,
      description: tool.toolSchema.description ?? null,
      // FunctionTool.parameters is a JSON-schema object; our schemas already are one.
      parameters: (tool.toolSchema.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>,
      // Match formatTools/Chat behavior - we do not run strict schema validation.
      strict: false,
    }));
  }

  /**
   * Translate Chat-Completions-shaped messages (what formatMessages produces, incl.
   * assistant.tool_calls + role:'tool' from pushToolMessages) into Responses API input
   * items: assistant tool calls become `function_call` items and tool results become
   * `function_call_output` items, linked by `call_id`.
   */
  private toResponsesInput(messages: OpenAI.ChatCompletionMessageParam[]): ResponseInputItem[] {
    const items: ResponseInputItem[] = [];
    for (const m of messages) {
      if (m.role === 'system' || m.role === 'developer') {
        items.push({ role: 'system', content: chatContentToString(m.content) });
      } else if (m.role === 'user') {
        items.push({ role: 'user', content: chatContentToString(m.content) });
      } else if (m.role === 'assistant') {
        const text = chatContentToString(m.content);
        if (text) items.push({ role: 'assistant', content: text });
        for (const tc of m.tool_calls ?? []) {
          if (tc.type !== 'function') continue;
          items.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      } else if (m.role === 'tool') {
        items.push({
          type: 'function_call_output',
          call_id: m.tool_call_id,
          output: chatContentToString(m.content),
        });
      }
    }
    return items;
  }

  /** Concatenate the assistant text (`output_text`) from a Responses output array. */
  private extractResponsesText(output: ResponseOutputItem[]): string {
    let text = '';
    for (const item of output) {
      if (item.type !== 'message') continue;
      for (const part of item.content) {
        if (part.type === 'output_text') text += part.text;
      }
    }
    return text;
  }

  /**
   * Resolve reasoning effort for the Responses path. Mirrors the chat path
   * (explicit user preference wins, else auto-classify from query complexity) -
   * but here we KEEP it, since reasoning + tools coexist on /v1/responses.
   */
  private resolveReasoningEffort(model: string, options: Partial<ICompletionOptions>): ReasoningEffort | undefined {
    if (options.reasoningEffort) return options.reasoningEffort;
    const complexity = options.complexity as keyof typeof effortMap | undefined;
    if (complexity && effortMap[complexity]) {
      const usesGPT5EffortMap =
        GPT5_1_MODELS.includes(model) || GPT5_2_MODELS.includes(model) || GPT5_4_MODELS.includes(model);
      return (usesGPT5EffortMap ? effortMap_GPT5_1_2 : effortMap)[complexity] as ReasoningEffort;
    }
    return undefined;
  }

  /**
   * Completion via OpenAI's `/v1/responses` API (non-streaming), used for the GPT-5
   * narrator family when tools are present (see RESPONSES_API_TOOL_MODELS). Unlike
   * `/v1/chat/completions`, this endpoint reliably emits real tool calls for reasoning
   * models while keeping `reasoning_effort`. It reuses the same tool-execution +
   * recursion loop as `complete()`: after tools run, results are pushed onto `messages`
   * and we recurse via `complete()` - a reasoning model with tools re-routes here; the
   * terminal (tools-dropped) synthesis turn falls through to the streaming chat path.
   * (Full streaming Responses path tracked separately.)
   */
  private async completeViaResponses(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>,
    callback: (text: (string | null | undefined)[], completionInfo: CompletionInfo) => Promise<void>,
    toolsUsed: Array<{ name: string; arguments?: string; id?: string }> = []
  ): Promise<void> {
    const toolCallCount = options._internal?.toolCallCount ?? 0;
    const accumInputTokens = options._internal?.accumInputTokens ?? 0;
    const accumOutputTokens = options._internal?.accumOutputTokens ?? 0;

    // Reuse the chat-path message formatting (system consolidation + B4M->OpenAI
    // conversion), then translate to Responses input items.
    const chatMessages = this.formatMessages(messages, false, model, options);
    const input = this.toResponsesInput(chatMessages);
    const reasoningEffort = this.resolveReasoningEffort(model, options);

    const params: ResponseCreateParamsNonStreaming = {
      model,
      input,
      stream: false,
      // Stateless: we resend the full translated history each turn (matching the chat
      // path's rebuild-from-messages recursion), so no server-side conversation state.
      store: false,
      ...(options.tools?.length ? { tools: this.formatToolsForResponses(options.tools) } : {}),
      ...(reasoningEffort
        ? {
            reasoning: {
              effort: reasoningEffort as NonNullable<ResponseCreateParamsNonStreaming['reasoning']>['effort'],
            },
          }
        : {}),
      ...(options.maxTokens ? { max_output_tokens: options.maxTokens } : {}),
      ...(mapToolChoiceForResponses(options.tool_choice) !== undefined
        ? { tool_choice: mapToolChoiceForResponses(options.tool_choice) }
        : {}),
      ...(this._endUserId ? { safety_identifier: this._endUserId } : {}),
    };

    const response = await withRetry(() => this._api.responses.create(params, { signal: options.abortSignal }), {
      maxRetries: 3,
      initialDelayMs: 500,
      maxDelayMs: 10000,
      jitterFactor: 0.25,
      isRetryable: err => isRetryableError(err) && !isUserInitiatedAbort(err, options.abortSignal),
      logger: this.logger,
      abortSignal: options.abortSignal,
    }).then(r => r.result);

    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;

    const functionCalls = response.output.filter(
      (item): item is Extract<ResponseOutputItem, { type: 'function_call' }> => item.type === 'function_call'
    );

    // Terminal turn - no tool calls. Emit the model's text.
    if (functionCalls.length === 0) {
      await callback([this.extractResponsesText(response.output)], {
        inputTokens: accumInputTokens + inputTokens,
        outputTokens: accumOutputTokens + outputTokens,
        toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
      });
      return;
    }

    // Record every call for usage/telemetry (mirrors the chat path).
    for (const fc of functionCalls) {
      toolsUsed.push({ name: fc.name, arguments: fc.arguments, id: fc.call_id });
    }

    // executeTools === false: surface the calls without running them.
    if (options.executeTools === false) {
      await callback([null], {
        inputTokens: accumInputTokens + inputTokens,
        outputTokens: accumOutputTokens + outputTokens,
        toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
      });
      return;
    }

    // Resolve executable tools from the (sentinel-wrapped) option tools so uiSideEffects
    // and streaming callbacks fire exactly as they do on the chat path.
    type ResolvedTool = {
      callId: string;
      name: string;
      args: string;
      parsed: Record<string, unknown>;
      toolFn: (p: Record<string, unknown>) => Promise<{ toString(): string }>;
      isMcpTool: boolean;
    };
    const resolved: ResolvedTool[] = [];
    for (const fc of functionCalls) {
      const toolDef = options.tools?.find(t => t.toolSchema.name === fc.name);
      if (!toolDef?.toolFn) continue;
      try {
        resolved.push({
          callId: fc.call_id,
          name: fc.name,
          args: fc.arguments,
          parsed: fc.arguments ? JSON.parse(fc.arguments) : {},
          toolFn: toolDef.toolFn,
          isMcpTool: toolDef._isMcpTool ?? false,
        });
      } catch {
        this.logger.warn(`JSON parse error for ${fc.name} arguments (Responses path)`);
      }
    }

    type ToolPayload = { callId: string; name: string; args: string; result: { toString(): string } };
    const parallelEnabled = options.parallelToolExecution !== false;
    this.logger.debug('[Tool Execution] Executing tools (OpenAI Responses)', {
      mode: parallelEnabled && resolved.length > 1 ? 'parallel' : 'sequential',
      toolNames: resolved.map(t => t.name),
    });
    const batchOutcomes = await executeToolsBatch<ToolPayload>(
      resolved.map(r => async () => {
        this.logger.debug('Using tool:', r.name);
        const result = await r.toolFn(r.parsed);
        return { callId: r.callId, name: r.name, args: r.args, result };
      }),
      { parallel: parallelEnabled, maxConcurrency: options.maxParallelTools }
    );

    for (let i = 0; i < batchOutcomes.length; i++) {
      const outcome = batchOutcomes[i];
      const r = resolved[i];
      if (outcome.ok) {
        this.pushToolMessages(
          messages,
          { id: r.callId, name: r.name, parameters: r.args },
          outcome.result.result.toString()
        );
      } else {
        if (outcome.error instanceof PermissionDeniedError) throw outcome.error;
        const errorMsg = `Error processing ${r.name} tool: ${
          outcome.error instanceof Error ? outcome.error.message : 'Unknown error'
        }`;
        this.pushToolMessages(messages, { id: r.callId, name: r.name, parameters: r.args }, errorMsg);
      }
    }

    const anyMcpTool = resolved.some(r => r.isMcpTool);

    // Recurse. Tool results are now in `messages`; carry this turn's tokens forward so
    // the terminal emit reports the full multi-turn billable total. Drop tools for the
    // synthesis turn (unless MCP, which chains) - mirrors the chat path.
    await this.complete(
      model,
      messages,
      {
        ...options,
        tools: anyMcpTool ? options.tools : undefined,
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
  }
}

/**
 * Coerce a Chat Completions message `content` (string | content-part array | null)
 * to a plain string for Responses input items. Text parts are concatenated; other
 * parts (images/files) are dropped - the Responses path is used for text+tools turns.
 */
function chatContentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (
          part &&
          typeof part === 'object' &&
          'text' in part &&
          typeof (part as { text: unknown }).text === 'string'
        ) {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

/**
 * Map an ICompletionOptions `tool_choice` to the Responses API shape. Strings
 * ('auto' | 'required' | 'none') pass through; the Chat Completions object form
 * `{ type:'function', function:{ name } }` becomes the Responses form
 * `{ type:'function', name }` so a caller-forced tool still applies (the
 * first-turn-only force works here too - recursion resets tool_choice to 'auto').
 * Returns undefined when there's nothing to forward.
 */
function mapToolChoiceForResponses(
  toolChoice: ICompletionOptions['tool_choice']
): ResponseCreateParamsNonStreaming['tool_choice'] | undefined {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === 'string') return toolChoice as ResponseCreateParamsNonStreaming['tool_choice'];
  if (typeof toolChoice === 'object' && (toolChoice as { type?: string }).type === 'function') {
    const fn = toolChoice as { function?: { name?: string }; name?: string };
    const name = fn.function?.name ?? fn.name;
    if (name) return { type: 'function', name };
  }
  return undefined;
}
