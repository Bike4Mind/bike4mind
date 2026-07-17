import {
  BEDROCK_NO_PROMPT_CACHING_MODELS,
  ChatModels,
  IMessage,
  MessageContentText,
  ModelBackend,
  NO_TEMPERATURE_MODELS,
  type ModelInfo,
} from '@bike4mind/common';
import {
  ChoiceEndReason,
  ChoiceStatus,
  IChoice,
  IChoiceEnd,
  IChoiceEndToolUse,
  ICompletionOptionTools,
  ICompletionOptions,
  ICompletionResponseChunk,
  replaceLastToolResultObservationCanonical,
  getLatestToolCallIdCanonical,
} from '../backend';
import { BaseBedrockBackend } from './base';
import { getCachingAdapter } from '../caching/adapters';
import { buildThinkingParams } from '../thinkingParams';

enum ClaudeChunkTypes {
  MESSAGE_START = 'message_start',
  CONTENT_BLOCK_START = 'content_block_start',
  CONTENT_BLOCK_DELTA = 'content_block_delta',
  CONTENT_BLOCK_STOP = 'content_block_stop',
  MESSAGE_DELTA = 'message_delta',
  MESSAGE_STOP = 'message_stop',
}

interface BaseClaudeChunk {
  type: ClaudeChunkTypes;
}

interface ClaudeChunkMessageStart extends BaseClaudeChunk {
  type: ClaudeChunkTypes.MESSAGE_START;
  message: {
    id: string;
    type: string;
    role: string;
    model: string;
    content: unknown[];
    stop_reason: string;
    stop_sequence: string;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

interface ClaudeChunkContentBlockStartText extends BaseClaudeChunk {
  type: ClaudeChunkTypes.CONTENT_BLOCK_START;
  index: number;
  content_block: { type: 'text'; text: string };
}

interface ClaudeChunkContentBlockStartToolUse extends BaseClaudeChunk {
  type: ClaudeChunkTypes.CONTENT_BLOCK_START;
  index: number;
  content_block: { type: 'tool_use'; name: string; id: string };
}

interface ClaudeChunkContentBlockStartThinking extends BaseClaudeChunk {
  type: ClaudeChunkTypes.CONTENT_BLOCK_START;
  index: number;
  content_block: { type: 'thinking' };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

// Type guard functions
function isToolUseContentBlock(
  content_block: unknown
): content_block is { type: 'tool_use'; name: string; id: string } {
  return (
    isRecord(content_block) && content_block.type === 'tool_use' && 'name' in content_block && 'id' in content_block
  );
}

function isThinkingContentBlock(content_block: unknown): content_block is { type: 'thinking' } {
  return isRecord(content_block) && content_block.type === 'thinking';
}

type ClaudeChunkContentBlockStart =
  ClaudeChunkContentBlockStartText | ClaudeChunkContentBlockStartToolUse | ClaudeChunkContentBlockStartThinking;

enum ClaudeChunkDeltaTypes {
  TEXT = 'text_delta',
  INPUT_JSON = 'input_json_delta',
  THINKING = 'thinking_delta',
}

interface ClaudeChunkDeltaBase {
  type: ClaudeChunkDeltaTypes;
  text?: string;
  partial_json?: string;
  thinking?: string;
}

interface ClaudeChunkDeltaText extends ClaudeChunkDeltaBase {
  type: ClaudeChunkDeltaTypes.TEXT;
  text: string;
}

interface ClaudeChunkDeltaInputJson extends ClaudeChunkDeltaBase {
  type: ClaudeChunkDeltaTypes.INPUT_JSON;
  partial_json: string;
}

interface ClaudeChunkDeltaThinking extends ClaudeChunkDeltaBase {
  type: ClaudeChunkDeltaTypes.THINKING;
  thinking: string;
}

// Type guard functions for delta types
function isTextDelta(delta: unknown): delta is ClaudeChunkDeltaText {
  return isRecord(delta) && delta.type === ClaudeChunkDeltaTypes.TEXT && 'text' in delta;
}

function isInputJsonDelta(delta: unknown): delta is ClaudeChunkDeltaInputJson {
  return isRecord(delta) && delta.type === ClaudeChunkDeltaTypes.INPUT_JSON && 'partial_json' in delta;
}

function isThinkingDelta(delta: unknown): delta is ClaudeChunkDeltaThinking {
  return isRecord(delta) && delta.type === ClaudeChunkDeltaTypes.THINKING && 'thinking' in delta;
}

type ClaudeChunkDelta = ClaudeChunkDeltaText | ClaudeChunkDeltaInputJson | ClaudeChunkDeltaThinking;

interface ClaudeChunkContentBlockDelta extends BaseClaudeChunk {
  type: ClaudeChunkTypes.CONTENT_BLOCK_DELTA;
  index: number;
  delta: ClaudeChunkDelta;
}

interface ClaudeChunkContentStop extends BaseClaudeChunk {
  type: ClaudeChunkTypes.CONTENT_BLOCK_STOP;
  index: number;
}

interface ClaudeChunkMessageDelta extends BaseClaudeChunk {
  type: ClaudeChunkTypes.MESSAGE_DELTA;
  delta: {
    stop_reason: 'tool_use' | 'end_turn';
  };
  usage: { output_tokens: number };
}

interface ClaudeChunkMessageStop extends BaseClaudeChunk {
  type: ClaudeChunkTypes.MESSAGE_STOP;
}

// Type guard for chunk types
function isMessageStart(chunk: unknown): chunk is ClaudeChunkMessageStart {
  return isRecord(chunk) && chunk.type === ClaudeChunkTypes.MESSAGE_START;
}

function isContentBlockStart(chunk: unknown): chunk is ClaudeChunkContentBlockStart {
  return isRecord(chunk) && chunk.type === ClaudeChunkTypes.CONTENT_BLOCK_START;
}

function isContentBlockDelta(chunk: unknown): chunk is ClaudeChunkContentBlockDelta {
  return isRecord(chunk) && chunk.type === ClaudeChunkTypes.CONTENT_BLOCK_DELTA;
}

function isContentBlockStop(chunk: unknown): chunk is ClaudeChunkContentStop {
  return isRecord(chunk) && chunk.type === ClaudeChunkTypes.CONTENT_BLOCK_STOP;
}

function isMessageDelta(chunk: unknown): chunk is ClaudeChunkMessageDelta {
  return isRecord(chunk) && chunk.type === ClaudeChunkTypes.MESSAGE_DELTA;
}

function isMessageStop(chunk: unknown): chunk is ClaudeChunkMessageStop {
  return isRecord(chunk) && chunk.type === ClaudeChunkTypes.MESSAGE_STOP;
}

const TEMPERATURE_ONLY_MODELS = [
  ChatModels.CLAUDE_4_5_SONNET_BEDROCK,
  ChatModels.CLAUDE_4_5_HAIKU_BEDROCK,
  ChatModels.CLAUDE_4_5_OPUS_BEDROCK,
  ChatModels.CLAUDE_4_6_SONNET_BEDROCK,
  ChatModels.CLAUDE_4_6_OPUS_BEDROCK,
];

export default class AnthropicBedrockBackend extends BaseBedrockBackend {
  // Track thinking block state
  private isInThinkingBlock = false;

  /** Static model info list - synchronous access for getPayload, also used by getModelInfo */
  private getModelInfoList(): ModelInfo[] {
    return [
      {
        id: ChatModels.CLAUDE_3_HAIKU_BEDROCK,
        type: 'text',
        name: 'Claude 3 Haiku',
        backend: ModelBackend.Bedrock,
        contextWindow: 200000,
        supportsImageVariation: false,
        max_tokens: 4096,
        can_stream: true,
        pricing: {
          200000: { input: 0.00025 / 1000, output: 0.00125 / 1000 }, // $0.00025 / 1,000 Input tokens, $0.00125 / 1,000 Output tokens. @see https://aws.amazon.com/bedrock/pricing/
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 6,
        supportsTools: true,
        trainingCutoff: '2023-08-01',
        description:
          "Anthropic's fast and efficient Claude 3 Haiku model via AWS Bedrock. Good balance of speed and capability with vision support.",
      },
      {
        id: ChatModels.CLAUDE_3_5_HAIKU_BEDROCK,
        type: 'text',
        name: 'Claude 3.5 Haiku',
        backend: ModelBackend.Bedrock,
        supportsImageVariation: false,
        contextWindow: 200000,
        max_tokens: 8192,
        can_stream: true,
        pricing: {
          200000: { input: 0.0008 / 1000, output: 0.004 / 1000 }, // $0.0008 / 1,000 Input tokens, $0.004 / 1,000 Output tokens. @see https://aws.amazon.com/bedrock/pricing/
        },

        // Note: The Claude 3.5 Haiku model does NOT support vision when accessed via Amazon Bedrock.
        // Vision support is only available when using the model directly through the Anthropic API.
        supportsVision: false,

        logoFile: 'Anthropic_logo.png',
        rank: 5,
        supportsTools: true,
        trainingCutoff: '2024-07-01',
        deprecationDate: '2026-02-19',
        description:
          "Anthropic's Claude 3.5 Haiku model via AWS Bedrock. Fast and efficient with improved reasoning capabilities.",
      },
      {
        id: ChatModels.CLAUDE_3_5_SONNET_BEDROCK,
        type: 'text',
        name: 'Claude 3.5 Sonnet',
        backend: ModelBackend.Bedrock,
        contextWindow: 200000,
        supportsImageVariation: false,
        max_tokens: 8192,
        can_stream: true,
        pricing: {
          200000: { input: 0.003 / 1000, output: 0.015 / 1000 }, // $0.003 / 1,000 Input tokens, $0.015 / 1,000 Output tokens. @see https://aws.amazon.com/bedrock/pricing/
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 2,
        supportsTools: true,
        trainingCutoff: '2024-04-01',
        deprecationDate: '2025-10-22',
        description:
          "Anthropic's highly capable Claude 3.5 Sonnet model via AWS Bedrock. Excellent for complex tasks requiring nuanced understanding.",
      },
      {
        id: ChatModels.CLAUDE_3_5_SONNET_V2_BEDROCK,
        type: 'text',
        name: 'Claude 3.5 Sonnet V2',
        backend: ModelBackend.Bedrock,
        supportsImageVariation: false,
        contextWindow: 200000,
        max_tokens: 8192,
        can_stream: true,
        pricing: {
          200000: { input: 0.003 / 1000, output: 0.015 / 1000 }, // $0.003 / 1,000 Input tokens, $0.015 / 1,000 Output tokens. @see https://aws.amazon.com/bedrock/pricing/
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 1,
        supportsTools: true,
        trainingCutoff: '2024-04-01',
        deprecationDate: '2025-10-22',
        description:
          "Anthropic\'s Claude 3.5 Sonnet V2 model via AWS Bedrock. Designed for complex tasks with enhanced reasoning and vision capabilities.",
      },
      {
        id: ChatModels.CLAUDE_3_7_SONNET_BEDROCK,
        type: 'text',
        name: 'Claude 3.7 Sonnet',
        backend: ModelBackend.Bedrock,
        supportsImageVariation: false,
        contextWindow: 200000,
        max_tokens: 8192,
        can_stream: true,
        can_think: true,
        pricing: {
          200000: { input: 0.0003 / 1000, output: 0.0015 / 1000 }, // $0.0003 / 1,000 Input tokens, $0.0015 / 1,000 Output tokens. @see https://aws.amazon.com/bedrock/pricing/
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 1,
        supportsTools: true,
        trainingCutoff: '2024-11-01',
        deprecationDate: '2025-10-28',
        description:
          "Anthropic's most advanced Claude 3.7 Sonnet model via AWS Bedrock. Highly capable with excellent reasoning, tool use, and thinking capabilities.",
      },

      // Claude 4 series
      {
        id: ChatModels.CLAUDE_4_OPUS_BEDROCK,
        type: 'text',
        name: 'Claude 4 Opus',
        backend: ModelBackend.Bedrock,
        supportsImageVariation: false,
        contextWindow: 200000,
        max_tokens: 8192,
        can_stream: true,
        can_think: true,
        pricing: {
          200000: { input: 0.015 / 1000, output: 0.075 / 1000 }, // Placeholder pricing - update with public rates
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 0,
        supportsTools: true,
        trainingCutoff: '2025-05-01',
        releaseDate: '2025-05-23',
        description:
          "Claude 4 Opus via AWS Bedrock. Anthropic's most capable model with enhanced reasoning and multimodal capabilities. Routes across us-east-1, us-east-2, us-west-2.",
        isSlowModel: true,
      },
      {
        id: ChatModels.CLAUDE_4_1_OPUS_BEDROCK,
        type: 'text',
        name: 'Claude 4.1 Opus',
        backend: ModelBackend.Bedrock,
        supportsImageVariation: false,
        contextWindow: 200000,
        max_tokens: 8192,
        can_stream: true,
        can_think: true,
        pricing: {
          200000: { input: 0.015 / 1000, output: 0.075 / 1000 }, // Placeholder pricing - update with public rates
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 0,
        supportsTools: true,
        trainingCutoff: '2025-08-01',
        releaseDate: '2025-08-06',
        description:
          'Claude 4.1 Opus via AWS Bedrock. Latest iteration with improved performance and reliability. Routes across us-east-1, us-east-2, us-west-2.',
        isSlowModel: true,
      },
      {
        id: ChatModels.CLAUDE_4_SONNET_BEDROCK,
        type: 'text',
        name: 'Claude 4 Sonnet',
        backend: ModelBackend.Bedrock,
        supportsImageVariation: false,
        contextWindow: 200000,
        max_tokens: 64000,
        can_stream: true,
        can_think: true,
        pricing: {
          200000: { input: 0.003 / 1000, output: 0.015 / 1000 }, // Placeholder pricing - update with public rates
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 1,
        supportsTools: true,
        trainingCutoff: '2025-05-01',
        releaseDate: '2025-05-23',
        description:
          'Claude 4 Sonnet via AWS Bedrock. Balanced model offering excellent performance at competitive pricing. Routes across us-east-1, us-east-2, us-west-2.',
      },
      {
        id: ChatModels.CLAUDE_4_5_SONNET_BEDROCK,
        type: 'text',
        name: 'Claude 4.5 Sonnet',
        backend: ModelBackend.Bedrock,
        contextWindow: 200000,
        max_tokens: 64000,
        can_stream: true,
        can_think: true,
        pricing: {
          200000: {
            input: 3 / 1000000, // $3 per 1M input tokens same with  sonnet4
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
          "Anthropic's most intelligent model hosted in AWS Bedrock. Delivers exceptional performance across coding, analysis, and complex reasoning tasks with improved speed and efficiency. Ideal for production workloads requiring both power and reliability.",
      },
      {
        id: ChatModels.CLAUDE_4_5_HAIKU_BEDROCK,
        type: 'text',
        name: 'Claude 4.5 Haiku',
        backend: ModelBackend.Bedrock,
        contextWindow: 200000,
        max_tokens: 64000,
        can_stream: true,
        can_think: true,
        pricing: {
          200000: { input: 1 / 1_000_000, output: 5 / 1_000_000 }, // Placeholder pricing - update with public rates
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 1,
        supportsTools: true,
        trainingCutoff: '2025-07-01',
        releaseDate: '2025-10-16',
        supportsImageVariation: false,
        description: 'Claude 4.5 Haiku via AWS Bedrock. Latest iteration with the fastest performance and reliability.',
      },
      {
        id: ChatModels.CLAUDE_4_5_OPUS_BEDROCK,
        type: 'text',
        name: 'Claude 4.5 Opus',
        backend: ModelBackend.Bedrock,
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
        trainingCutoff: '2025-03-01',
        releaseDate: '2025-11-25',
        description:
          'Claude 4.5 Opus via AWS Bedrock. Top-tier extended thinking model with excellent performance for complex reasoning, coding, and creative tasks.',
        isSlowModel: true,
      },
      {
        id: ChatModels.CLAUDE_4_6_SONNET_BEDROCK,
        type: 'text',
        name: 'Claude 4.6 Sonnet',
        backend: ModelBackend.Bedrock,
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
        rank: 1, // demoted below Sonnet 5 (the new default) — opt-in via picker
        trainingCutoff: '2025-10-01',
        releaseDate: '2026-02-19',
        description:
          "Anthropic's Claude 4.6 Sonnet model via AWS Bedrock. Delivers enhanced performance across coding, analysis, and complex reasoning tasks with improved speed and efficiency.",
      },
      {
        id: ChatModels.CLAUDE_5_SONNET_BEDROCK,
        type: 'text',
        name: 'Claude 5 Sonnet',
        backend: ModelBackend.Bedrock,
        contextWindow: 1_000_000,
        max_tokens: 128_000,
        can_stream: true,
        can_think: true,
        thinkingStyle: 'adaptive',
        pricing: {
          1_000_000: {
            input: 3 / 1000000, // $3 per 1M input tokens
            output: 15 / 1000000, // $15 per 1M output tokens
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
          "Anthropic's newest Claude 5 Sonnet model via AWS Bedrock. Near-Opus quality on coding and agentic work at Sonnet cost, with adaptive extended thinking and a 1M-token context window.",
      },
      {
        id: ChatModels.CLAUDE_4_6_OPUS_BEDROCK,
        type: 'text',
        name: 'Claude 4.6 Opus',
        backend: ModelBackend.Bedrock,
        supportsImageVariation: false,
        contextWindow: 1_000_000,
        max_tokens: 128_000,
        can_stream: true,
        can_think: true,
        pricing: {
          1_000_000: { input: 15 / 1000000, output: 75 / 1000000 }, // $15 / 1M Input tokens, $75 / 1M Output tokens
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 0,
        supportsTools: true,
        trainingCutoff: '2025-05-01',
        releaseDate: '2026-02-06',
        description:
          "Anthropic's earlier flagship model via AWS Bedrock. Claude 4.6 Opus delivers frontier intelligence with extended thinking, coding, and agentic capabilities.",
        isSlowModel: true,
      },
      {
        id: ChatModels.CLAUDE_4_7_OPUS_BEDROCK,
        type: 'text',
        name: 'Claude 4.7 Opus',
        backend: ModelBackend.Bedrock,
        supportsImageVariation: false,
        contextWindow: 1_000_000,
        max_tokens: 128_000,
        can_stream: true,
        can_think: true,
        thinkingStyle: 'adaptive',
        pricing: {
          1_000_000: { input: 5 / 1000000, output: 25 / 1000000 }, // $5 / 1M Input tokens, $25 / 1M Output tokens
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 0,
        supportsTools: true,
        trainingCutoff: '2025-10-01',
        releaseDate: '2026-04-17',
        description:
          "Anthropic's previous flagship model via AWS Bedrock. Claude 4.7 Opus delivers frontier intelligence with extended thinking, coding, and agentic capabilities.",
        isSlowModel: true,
      },
      {
        id: ChatModels.CLAUDE_4_8_OPUS_BEDROCK,
        type: 'text',
        name: 'Claude 4.8 Opus',
        backend: ModelBackend.Bedrock,
        supportsImageVariation: false,
        contextWindow: 1_000_000,
        max_tokens: 128_000,
        can_stream: true,
        can_think: true,
        thinkingStyle: 'adaptive',
        pricing: {
          1_000_000: { input: 5 / 1000000, output: 25 / 1000000 }, // $5 / 1M Input tokens, $25 / 1M Output tokens
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 0,
        supportsTools: true,
        trainingCutoff: '2026-01-01',
        releaseDate: '2026-05-28',
        description:
          "Anthropic's latest flagship model via AWS Bedrock. Claude 4.8 Opus delivers enhanced frontier intelligence with improved extended thinking, coding, and agentic capabilities.",
        isSlowModel: true,
      },
    ];
  }

  async getModelInfo(): Promise<ModelInfo[]> {
    return this.getModelInfoList();
  }

  protected getModelContextWindow(model: string): number {
    return this.getModelInfoList().find(m => m.id === model)?.contextWindow ?? 0;
  }

  getPayload(model: string, messages: IMessage[], options: Partial<ICompletionOptions>) {
    const rawTools = options.tools as unknown;
    const normalizedTools = Array.isArray(rawTools)
      ? (rawTools as ICompletionOptionTools[])
      : rawTools
        ? [rawTools as ICompletionOptionTools]
        : undefined;
    options.tools = normalizedTools;

    // Filter and validate messages to ensure content is valid
    // Bedrock/Anthropic rejects "text content blocks must contain non-whitespace text"
    const filteredMessages = messages
      .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content !== null && m.content !== undefined)
      .map(m => {
        // Handle string content - check for empty/whitespace-only
        if (typeof m.content === 'string') {
          const trimmed = m.content.trim();
          if (!trimmed) {
            return { ...m, content: '' }; // Will be filtered out below
          }
          return m;
        }

        // Handle array content - filter out empty text blocks
        if (Array.isArray(m.content)) {
          const sanitizedContent = m.content
            .map(block => {
              // For text blocks, check if text is empty/whitespace-only
              if (isRecord(block) && block.type === 'text') {
                const text = typeof block.text === 'string' ? block.text : '';
                if (!text.trim()) {
                  return null; // Mark for removal
                }
              }
              return block;
            })
            .filter(block => block !== null);

          // If array is now empty, mark message for removal
          if (sanitizedContent.length === 0) {
            return { ...m, content: '' };
          }

          return { ...m, content: sanitizedContent };
        }

        // Convert non-string/non-array content to empty string
        return { ...m, content: '' };
      })
      .filter(m => m.content !== '' && (Array.isArray(m.content) ? m.content.length > 0 : true));

    let systemMessage = messages
      .filter(m => m.role === 'system' && m.content)
      .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');

    // Append model identity so the model correctly identifies itself when asked
    const modelIdentity = `IMPORTANT! Only when someone asks, remember that you are specifically the ${model} model.`;
    systemMessage = systemMessage ? `${systemMessage}\n${modelIdentity}` : modelIdentity;

    // Check if model ID needs to be transformed
    const hasVendorPrefix =
      model.includes(':') || model.startsWith('global.') || model.startsWith('us.') || model.startsWith('anthropic.');
    const modelId = hasVendorPrefix ? model : `anthropic.${model}`;

    // Ensure maxTokens is always provided and is a number
    const maxTokens = typeof options.maxTokens === 'number' ? options.maxTokens : 4096;

    const body: Record<string, unknown> = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: maxTokens,
      messages: filteredMessages,
    };

    // Only add system message if it's not empty
    if (systemMessage) {
      body.system = systemMessage;
    }

    if (options.tools?.length) {
      body.tools = this.formatTools(options.tools);
    }

    // Add temperature if provided (Claude 4.7 Opus does not accept temperature at all)
    if (typeof options.temperature === 'number' && !NO_TEMPERATURE_MODELS.has(model)) {
      body.temperature = options.temperature;
    }

    // Add top_p if provided
    // top_p and temperature together is not supported for claude-4-5-sonnet
    if (
      typeof options.topP === 'number' &&
      !TEMPERATURE_ONLY_MODELS.includes(model as ChatModels) &&
      !NO_TEMPERATURE_MODELS.has(model)
    ) {
      body.top_p = options.topP;
    }

    // Add thinking parameters for models that support it
    const currentModelInfo = this.getModelInfoList().find(m => m.id === model);
    const supportsThinking = currentModelInfo?.can_think === true;

    if (supportsThinking && currentModelInfo) {
      // questMaster is an Anthropic-specific extra not on the generic ICompletionOptions;
      // cast locally for that one field (thinking is already declared on the type).
      const isQuestMaster = (options as { questMaster?: boolean }).questMaster === true;
      const userThinkingEnabled = options.thinking?.enabled === true;

      if (userThinkingEnabled || isQuestMaster) {
        const budgetTokens = isQuestMaster
          ? Math.min(Math.floor(maxTokens * 0.25), 4096)
          : (options.thinking?.budget_tokens ?? 16000);
        const effort = isQuestMaster ? ('medium' as const) : ('high' as const);

        const result = buildThinkingParams(model, currentModelInfo, budgetTokens, maxTokens, effort);

        // Apply thinking config
        body.thinking = result.thinkingConfig.thinking;
        if ('output_config' in result.thinkingConfig && result.thinkingConfig.output_config) {
          body.output_config = result.thinkingConfig.output_config;
        }
        body.max_tokens = result.maxTokens;

        // Apply temperature/top_p constraints
        if (result.temperature === 'delete') {
          delete body.temperature;
        } else {
          body.temperature = result.temperature;
        }
        delete body.top_p;
      }
    }

    // Log the complete payload for debugging
    console.log(
      `[AnthropicBedrockBackend] Request payload: ${JSON.stringify(
        {
          modelId,
          options: {
            maxTokens,
            messageCount: filteredMessages.length,
            hasSystemMessage: !!systemMessage,
            hasTools: !!options.tools,
            temperature: options.temperature,
            topP: options.topP,
          },
        },
        null,
        2
      )}`
    );

    // Apply prompt caching if enabled (Bedrock uses Anthropic caching format).
    // Skip models known to reject `cache_control` (e.g. the OG Claude 3 Haiku / Claude 3.5
    // Sonnet v1 on Bedrock) - sending it causes a Bedrock deserialization error and the
    // assistant turn never resolves.
    const cacheStrategy = options.cacheStrategy;
    const modelSupportsCaching = !BEDROCK_NO_PROMPT_CACHING_MODELS.has(modelId);
    if (cacheStrategy?.enableCaching && modelSupportsCaching) {
      const adapter = getCachingAdapter(ModelBackend.Bedrock);
      const cachedBody = adapter.applyCaching(body as Record<string, unknown>, cacheStrategy);
      Object.assign(body, cachedBody);

      // TODO: Add logger to BaseBedrockBackend for consistent logging
      console.debug(
        '[PromptCache] Bedrock caching enabled',
        JSON.stringify({
          model: modelId,
          cacheSystemPrompt: cacheStrategy.cacheSystemPrompt,
          cacheTools: cacheStrategy.cacheTools,
          cacheConversationHistory: cacheStrategy.cacheConversationHistory,
          cacheTTL: cacheStrategy.cacheTTL,
        })
      );
    } else if (cacheStrategy?.enableCaching && !modelSupportsCaching) {
      console.debug(
        '[PromptCache] Bedrock caching skipped — model does not support cache_control',
        JSON.stringify({ model: modelId })
      );
    }

    // Log the actual body being sent (first 1000 chars)
    const bodyStr = JSON.stringify(body);
    console.log(
      `[AnthropicBedrockBackend] Request body: ${bodyStr.substring(0, 1000)}${bodyStr.length > 1000 ? '...' : ''}`
    );
    return {
      modelId: modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    };
  }

  formatMessages(messages: IMessage[]): IMessage[] {
    const formattedMessages = messages.reduce((cur, value) => {
      const previousMessage = cur[cur.length - 1];

      // Check if the previous message has the same role as the current message
      if (previousMessage && value.role === previousMessage.role) {
        // if the previous message is the same
        // then skip the current message
        if (previousMessage.content === value.content) {
          return cur;

          // if the previous message content is a text
          // then convert the content to an array of text
        } else if (!Array.isArray(previousMessage.content)) {
          const lastIndex = cur.length - 1;
          // Ensure both contents are valid strings
          const prevContent = typeof cur[lastIndex].content === 'string' ? cur[lastIndex].content : '';
          const currContent = typeof value.content === 'string' ? value.content : '';

          // Only merge if current value.content is also a string (not an array with images)
          if (typeof value.content !== 'string') {
            cur.push(value);
            return cur;
          }

          if (prevContent || currContent) {
            const contentArray: MessageContentText[] = [];
            if (prevContent) {
              contentArray.push({ type: 'text' as const, text: prevContent });
            }
            if (currContent) {
              contentArray.push({ type: 'text' as const, text: currContent });
            }
            if (contentArray.length > 0) {
              cur[lastIndex].content = contentArray;
            }
          }

          // if not
          // then add the current message to the previous message content
        } else {
          // Only merge if current value.content is a string (not an array with images)
          if (typeof value.content !== 'string') {
            cur.push(value);
            return cur;
          }

          const content = previousMessage.content as MessageContentText[];
          if (content.some(c => c.type === 'text')) {
            return cur;
          }
          // Ensure value.content is a valid string before adding to message
          const textContent = typeof value.content === 'string' ? value.content : '';
          if (textContent) {
            previousMessage.content = [...content, { type: 'text', text: textContent }];
          }
        }

        return cur;
      }

      // Push the message if the role is different
      cur.push(value);

      return cur;
    }, [] as IMessage[]);

    return formattedMessages;
  }

  translateChunk(
    model: string,
    chunk: Record<string, unknown>
  ): { done: boolean; chunk?: ICompletionResponseChunk | undefined } {
    try {
      // Parse the response from Anthropic API
      const response = chunk as {
        id: string;
        type: string;
        role: string;
        content: Array<{ type: string; text?: string; thinking?: string }>;
        model: string;
        stop_reason: string;
        usage: {
          input_tokens: number;
          output_tokens: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      };

      // Warn if thinking blocks are present when they shouldn't be
      const thinkingBlocks = response.content.filter(c => c.type === 'thinking');
      if (thinkingBlocks.length > 0) {
        console.warn(`[AnthropicBedrockBackend] Unexpected thinking blocks in response`, {
          thinkingBlockCount: thinkingBlocks.length,
          thinkingLengths: thinkingBlocks.map(b => b.thinking?.length || 0),
        });
      }

      // Extract text content from the response
      const textContent = response.content
        .filter(item => item.type === 'text')
        .map(item => item.text || '')
        .join('');

      // Extract tool_use blocks from the response
      const toolUseBlocks = response.content.filter(item => item.type === 'tool_use') as Array<{
        type: 'tool_use';
        id: string;
        name: string;
        input: Record<string, unknown>;
      }>;

      // Create a choice object with the extracted text and tool info
      let choice: IChoiceEnd;

      if (toolUseBlocks.length > 0) {
        // If there are tool_use blocks, create IChoiceEndToolUse
        choice = {
          status: ChoiceStatus.END,
          statusEndReason: ChoiceEndReason.TOOL_USE,
          index: 0,
          chunkText: textContent,
          usage: {
            input_tokens: response.usage?.input_tokens || 0,
            output_tokens: response.usage?.output_tokens || 0,
            cache_read_input_tokens: response.usage?.cache_read_input_tokens,
            cache_creation_input_tokens: response.usage?.cache_creation_input_tokens,
          },
          tool: {
            id: toolUseBlocks[0].id,
            name: toolUseBlocks[0].name,
            parameters: JSON.stringify(toolUseBlocks[0].input),
          },
        };
      } else {
        // No tool use, create IChoiceEndComplete
        choice = {
          status: ChoiceStatus.END,
          statusEndReason: ChoiceEndReason.COMPLETE,
          index: 0,
          chunkText: textContent,
          usage: {
            input_tokens: response.usage?.input_tokens || 0,
            output_tokens: response.usage?.output_tokens || 0,
            cache_read_input_tokens: response.usage?.cache_read_input_tokens,
            cache_creation_input_tokens: response.usage?.cache_creation_input_tokens,
          },
        };
      }

      return {
        done: true,
        chunk: {
          model,
          choices: [choice],
        },
      };
    } catch (error) {
      console.error('[AnthropicBedrockBackend] Error translating non-streaming chunk:', error);
      throw error;
    }
  }

  translateStreamChunk(model: string, chunk: unknown): { done: boolean; chunk?: ICompletionResponseChunk } {
    let done = false;
    let choice: IChoice;

    // Default choice with empty text
    choice = {
      status: ChoiceStatus.STREAM,
      chunkText: '',
    } as IChoice;

    try {
      if (isMessageStart(chunk)) {
        // Reset thinking block state at the start of a new message
        this.isInThinkingBlock = false;
        choice = {
          chunkText: '',
          usage: {
            input_tokens: chunk.message.usage.input_tokens,
            cache_read_input_tokens: chunk.message.usage.cache_read_input_tokens,
            cache_creation_input_tokens: chunk.message.usage.cache_creation_input_tokens,
          },
        } as IChoice;
      } else if (isContentBlockStart(chunk)) {
        choice = {
          status: ChoiceStatus.STREAM,
          index: chunk.index,
          chunkText: '',
        } as IChoice;

        const contentBlock = chunk.content_block;

        if (isToolUseContentBlock(contentBlock)) {
          choice.tool = {
            name: contentBlock.name,
            id: contentBlock.id,
          };
        } else if (isThinkingContentBlock(contentBlock)) {
          this.isInThinkingBlock = true;
          choice.chunkText = '<think>';
        }
      } else if (isContentBlockDelta(chunk)) {
        choice = {
          status: ChoiceStatus.STREAM,
          index: chunk.index,
          chunkText: '',
        } as IChoice;

        const delta = chunk.delta;

        if (isTextDelta(delta)) {
          choice.chunkText = delta.text;
        } else if (isInputJsonDelta(delta)) {
          choice.chunkText = delta.partial_json;
        } else if (isThinkingDelta(delta)) {
          choice.chunkText = delta.thinking;
        }
      } else if (isContentBlockStop(chunk)) {
        choice = {
          status: ChoiceStatus.STREAM,
          index: chunk.index,
          chunkText: this.isInThinkingBlock ? '</think>' : '',
        } as IChoice;

        // Reset thinking block state
        this.isInThinkingBlock = false;
      } else if (isMessageDelta(chunk)) {
        choice = {
          status: ChoiceStatus.STREAM,
          chunkText: '',
          usage: {
            output_tokens: chunk.usage.output_tokens,
          },
        } as IChoice;
      } else if (isMessageStop(chunk)) {
        done = true;
        choice = {
          status: ChoiceStatus.END,
          statusEndReason: ChoiceEndReason.COMPLETE,
          chunkText: '',
        } as IChoice;
      } else {
        console.warn('[AnthropicBedrockBackend] Unknown chunk type:', isRecord(chunk) ? chunk.type : chunk);
        return { done: false };
      }
    } catch (error) {
      console.error('[AnthropicBedrockBackend] Error processing stream chunk:', error);
      // Return a default choice with empty text
      return {
        done: false,
        chunk: {
          model,
          choices: [choice],
        },
      };
    }

    return {
      done,
      chunk: {
        model,
        choices: [choice],
      },
    };
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

  pushToolMessages(messages: IMessage[], tool: IChoiceEndToolUse['tool'], result: string, thinkingBlocks?: unknown[]) {
    const toolUseBlock = {
      type: 'tool_use' as const,
      id: tool.id,
      name: tool.name,
      input: JSON.parse(tool.parameters || '{}'),
    };

    const assistantContent: IMessage['content'] =
      thinkingBlocks && thinkingBlocks.length > 0
        ? [...(thinkingBlocks as Array<{ type: 'thinking'; thinking: string; signature: string }>), toolUseBlock]
        : [toolUseBlock];

    messages.push({
      role: 'assistant',
      content: assistantContent,
    });
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
}
