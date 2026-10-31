import {
  BadRequestError,
  BEDROCK_NO_PROMPT_CACHING_MODELS,
  ChatModels,
  createThinkMarkerEscaper,
  IMessage,
  isBedrockRegionProfileId,
  isToolChangeMessage,
  MessageContentText,
  ModelBackend,
  NO_TEMPERATURE_MODELS,
  REFUSAL_FALLBACK_MODELS,
  TOOL_SEARCH_BLOCK_TYPES,
  type ModelInfo,
  type ProviderBlock,
  type ToolSearchServerTool,
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
import { Logger } from '@bike4mind/observability';
import { BaseBedrockBackend } from './base';
import { capCacheControlMarkers, getCachingAdapter, withRequestTtlMarkers } from '../caching/adapters';
import { systemContentToText } from '../systemContent';
import { sortToolsForStableCacheKey } from '../caching/stableToolOrder';
import { DispatchModel } from '../dispatchModel';
import {
  applyAnthropicOutputCeiling,
  buildThinkingParams,
  effortForComplexity,
  planReasoningEffort,
  resolveAnthropicEffort,
} from '../thinkingParams';
import { toAnthropicContent } from '../anthropicContent';
import { ensureToolPairingIntegrity } from '../toolPairingUtils';
import { TOOL_CHANGES_BETA } from '../toolChanges';
import { appendIdentityReminder, buildIdentityReminder, shouldOmitIdentityReminder } from '../identityReminder';

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
  content_block: { type: 'thinking'; thinking?: string; signature?: string };
}

interface ClaudeChunkContentBlockStartRedactedThinking extends BaseClaudeChunk {
  type: ClaudeChunkTypes.CONTENT_BLOCK_START;
  index: number;
  content_block: { type: 'redacted_thinking'; data: string };
}

/**
 * A reasoning block of the assistant turn being streamed. Anthropic requires these be
 * replayed unmodified - signature included - in the assistant message that carries
 * `tool_use`, whenever extended thinking is active on the turn.
 * @see AnthropicBedrockBackend.takeReasoningBlocks
 */
type ClaudeReasoningBlock =
  { type: 'thinking'; thinking: string; signature?: string } | { type: 'redacted_thinking'; data: string };

/** One block of the assistant turn as the provider sent it, kept for replay. */
type AssistantBlock = { type: string; [key: string]: unknown };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const isReasoningBlock = (block: AssistantBlock): boolean =>
  block.type === 'thinking' || block.type === 'redacted_thinking';

// Replayed verbatim and surfaced to the caller, never executed. Same set as anthropicBackend's isProviderBlock.
function isProviderBlock(block: unknown): block is AssistantBlock {
  return isRecord(block) && typeof block.type === 'string' && TOOL_SEARCH_BLOCK_TYPES.has(block.type);
}

const anthropicBlock = (block: AssistantBlock): ProviderBlock => ({ provider: 'anthropic', block: { ...block } });

// Type guard functions
function isToolUseContentBlock(
  content_block: unknown
): content_block is { type: 'tool_use'; name: string; id: string } {
  return (
    isRecord(content_block) && content_block.type === 'tool_use' && 'name' in content_block && 'id' in content_block
  );
}

function isThinkingContentBlock(
  content_block: unknown
): content_block is { type: 'thinking'; thinking?: string; signature?: string } {
  return isRecord(content_block) && content_block.type === 'thinking';
}

function isRedactedThinkingContentBlock(
  content_block: unknown
): content_block is { type: 'redacted_thinking'; data: string } {
  return isRecord(content_block) && content_block.type === 'redacted_thinking';
}

type ClaudeChunkContentBlockStart =
  | ClaudeChunkContentBlockStartText
  | ClaudeChunkContentBlockStartToolUse
  | ClaudeChunkContentBlockStartThinking
  | ClaudeChunkContentBlockStartRedactedThinking;

enum ClaudeChunkDeltaTypes {
  TEXT = 'text_delta',
  INPUT_JSON = 'input_json_delta',
  THINKING = 'thinking_delta',
  SIGNATURE = 'signature_delta',
}

interface ClaudeChunkDeltaBase {
  type: ClaudeChunkDeltaTypes;
  text?: string;
  partial_json?: string;
  thinking?: string;
  signature?: string;
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

interface ClaudeChunkDeltaSignature extends ClaudeChunkDeltaBase {
  type: ClaudeChunkDeltaTypes.SIGNATURE;
  signature: string;
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

function isSignatureDelta(delta: unknown): delta is ClaudeChunkDeltaSignature {
  return isRecord(delta) && delta.type === ClaudeChunkDeltaTypes.SIGNATURE && 'signature' in delta;
}

type ClaudeChunkDelta =
  ClaudeChunkDeltaText | ClaudeChunkDeltaInputJson | ClaudeChunkDeltaThinking | ClaudeChunkDeltaSignature;

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
    stop_reason: string;
  };
  usage: {
    output_tokens: number;
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
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

// Account-level Bedrock setting, not a request parameter.
const FABLE_DISABLED_REASON = 'Requires the aws_review data-retention mode on the Bedrock account';

export default class AnthropicBedrockBackend extends BaseBedrockBackend {
  /** Reports done only on message_stop (anthropic.ts translateStreamChunk), so a missing terminal event means a truncated stream. */
  protected override get signalsStreamTermination(): boolean {
    return true;
  }

  // Track thinking block state
  private isInThinkingBlock = false;
  private reasoningEscaper = createThinkMarkerEscaper();
  /**
   * Blocks of the assistant turn currently being translated, indexed by the stream's
   * content-block index. Reset at `message_start` and moved to `replayContent` by
   * `takeReasoningBlocks` when that turn is rebuilt for a tool continuation.
   */
  private assistantContent: Array<AssistantBlock | undefined> = [];
  /** Raw input JSON of each streaming server_tool_use block, by content-block index. */
  private serverToolInputJson = new Map<number, string>();
  /** The taken turn pushToolMessages rebuilds from; see pushToolMessages. */
  private replayContent: AssistantBlock[] = [];
  /** The assistant content array pushToolMessages last pushed, which a parallel sibling's result joins. */
  private replayedTurn: unknown[] | undefined;
  /** Catalog view of the model being completed; see DispatchModel. */
  private readonly _dispatch = new DispatchModel();

  setDispatchModel(info: ModelInfo): void {
    this._dispatch.set(info);
  }

  /**
   * The reasoning blocks the last translated assistant turn produced, cleared as they
   * are taken. Anthropic requires a `tool_use` assistant turn to replay its own signed
   * thinking blocks whenever extended thinking is active on the turn, and an adaptive
   * model thinks on every turn whether or not the request asked it to - so dropping
   * them is what makes the synthesis round of a multi-round tool turn come back empty.
   *
   * Taken once per provider turn. base.ts takes them before its tool loop and hands the
   * same array to every assistant message it rebuilds for that round, because a parallel
   * round splits one provider turn across several synthetic turns and each of them has to
   * carry the reasoning.
   */
  protected override takeReasoningBlocks(): ClaudeReasoningBlock[] {
    const taken = this.assistantContent.filter((b): b is AssistantBlock => b != null);
    this.assistantContent = [];
    // A second take in the same round (pushToolMessages' fallback) must not wipe the turn being replayed.
    // A new turn also ends the previous one's sibling joins, so its replay cannot overwrite that turn.
    if (taken.length > 0) {
      this.replayContent = taken;
      this.replayedTurn = undefined;
    }
    return taken.filter(isReasoningBlock) as ClaudeReasoningBlock[];
  }

  /**
   * The record the payload is shaped from: the adapter table first, then the
   * catalog for a model the table never listed. Table-first keeps every
   * currently-dispatched Bedrock id on exactly today's payload.
   */
  private modelRecordFor(model: string): ModelInfo | undefined {
    return this.getModelInfoList().find(m => m.id === model) ?? this._dispatch.for(model);
  }

  /**
   * The adaptive-thinking surface has no sampling knobs: those models reject
   * temperature and top_p outright. NO_TEMPERATURE_MODELS lists the ids this
   * build ships; for a model only the catalog knows, `thinkingStyle: 'adaptive'`
   * is the same statement in record form.
   */
  private omitsSamplingParams(model: string): boolean {
    if (NO_TEMPERATURE_MODELS.has(model)) return true;
    const listed = this.getModelInfoList().some(m => m.id === model);
    return !listed && this._dispatch.for(model)?.thinkingStyle === 'adaptive';
  }

  /**
   * Static model info list - synchronous access for getPayload, also used by getModelInfo.
   * `rank` must match the identically-named entry in anthropicBackend.ts: it is the same
   * model, so the picker must not show the Bedrock copy above or below its direct twin.
   */
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
        deprecationDate: '2026-09-10',
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
          200000: { input: 3 / 1_000_000, output: 15 / 1_000_000 }, // $3 / 1M Input tokens, $15 / 1M Output tokens. @see https://aws.amazon.com/bedrock/pricing/
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
        name: 'Claude Opus 4',
        backend: ModelBackend.Bedrock,
        supportsImageVariation: false,
        contextWindow: 200000,
        max_tokens: 8192,
        can_stream: true,
        can_think: true,
        pricing: {
          200000: { input: 0.015 / 1000, output: 0.075 / 1000 },
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 1,
        supportsTools: true,
        trainingCutoff: '2025-05-01',
        releaseDate: '2025-05-23',
        deprecationDate: '2026-10-15',
        description:
          "Claude 4 Opus via AWS Bedrock. Anthropic's most capable model with enhanced reasoning and multimodal capabilities. Routes across us-east-1, us-east-2, us-west-2.",
        isSlowModel: true,
      },
      {
        id: ChatModels.CLAUDE_4_1_OPUS_BEDROCK,
        type: 'text',
        name: 'Claude Opus 4.1',
        backend: ModelBackend.Bedrock,
        supportsImageVariation: false,
        contextWindow: 200000,
        max_tokens: 8192,
        can_stream: true,
        can_think: true,
        pricing: {
          200000: { input: 0.015 / 1000, output: 0.075 / 1000 },
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 1,
        supportsTools: true,
        trainingCutoff: '2025-08-01',
        releaseDate: '2025-08-06',
        deprecationDate: '2027-01-08',
        disabled: true,
        disabledReason: 'Legacy on Bedrock; account access lapsed after inactivity',
        description:
          'Claude 4.1 Opus via AWS Bedrock. Latest iteration with improved performance and reliability. Routes across us-east-1, us-east-2, us-west-2.',
        isSlowModel: true,
      },
      {
        id: ChatModels.CLAUDE_4_SONNET_BEDROCK,
        type: 'text',
        name: 'Claude Sonnet 4',
        backend: ModelBackend.Bedrock,
        supportsImageVariation: false,
        contextWindow: 200000,
        max_tokens: 64000,
        can_stream: true,
        can_think: true,
        pricing: {
          200000: { input: 0.003 / 1000, output: 0.015 / 1000 },
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 2,
        supportsTools: true,
        trainingCutoff: '2025-05-01',
        releaseDate: '2025-05-23',
        deprecationDate: '2026-10-14',
        description:
          'Claude 4 Sonnet via AWS Bedrock. Balanced model offering excellent performance at competitive pricing. Routes across us-east-1, us-east-2, us-west-2.',
      },
      {
        id: ChatModels.CLAUDE_4_5_SONNET_BEDROCK,
        type: 'text',
        name: 'Claude Sonnet 4.5',
        backend: ModelBackend.Bedrock,
        contextWindow: 200000,
        max_tokens: 64000,
        can_stream: true,
        can_think: true,
        // us. is a regional endpoint: AWS bills a 10% premium over the global rate ($3 / $15).
        pricing: {
          200000: {
            input: 3.3e-6, // $3.30 per 1M input tokens
            output: 16.5 / 1000000, // $16.50 per 1M output tokens
          },
        },
        supportsVision: true,
        supportsTools: true,
        supportsImageVariation: false,
        logoFile: 'Anthropic_logo.png',
        rank: 2,
        trainingCutoff: '2025-07-01',
        releaseDate: '2025-09-30',
        // Bedrock reports it LEGACY; the static redirect in resolveDeprecatedModel.ts already serves it as 4.6,
        // so hide it from the picker even before discovery has written the lifecycle.
        deprecationDate: '2026-10-08',
        description:
          "Anthropic's most intelligent model hosted in AWS Bedrock. Delivers exceptional performance across coding, analysis, and complex reasoning tasks with improved speed and efficiency. Ideal for production workloads requiring both power and reliability.",
      },
      {
        id: ChatModels.CLAUDE_4_5_HAIKU_BEDROCK,
        type: 'text',
        name: 'Claude Haiku 4.5',
        backend: ModelBackend.Bedrock,
        contextWindow: 200000,
        max_tokens: 64000,
        can_stream: true,
        can_think: true,
        // us. is a regional endpoint: AWS bills a 10% premium over the global rate ($1 / $5).
        pricing: {
          200000: { input: 1.1 / 1_000_000, output: 5.5 / 1_000_000 },
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 3,
        supportsTools: true,
        trainingCutoff: '2025-07-01',
        releaseDate: '2025-10-16',
        supportsImageVariation: false,
        description: 'Claude 4.5 Haiku via AWS Bedrock. Latest iteration with the fastest performance and reliability.',
      },
      {
        id: ChatModels.CLAUDE_4_5_OPUS_BEDROCK,
        type: 'text',
        name: 'Claude Opus 4.5',
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
        name: 'Claude Sonnet 4.6',
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
        rank: 2,
        trainingCutoff: '2025-10-01',
        releaseDate: '2026-02-19',
        description:
          "Anthropic's Claude 4.6 Sonnet model via AWS Bedrock. Delivers enhanced performance across coding, analysis, and complex reasoning tasks with improved speed and efficiency.",
      },
      {
        id: ChatModels.CLAUDE_5_SONNET_BEDROCK,
        type: 'text',
        name: 'Claude Sonnet 5',
        backend: ModelBackend.Bedrock,
        contextWindow: 1_000_000,
        max_tokens: 128_000,
        can_stream: true,
        can_think: true,
        thinkingStyle: 'adaptive',
        pricing: {
          1_000_000: {
            input: 2 / 1000000, // $2 per 1M input tokens
            output: 10 / 1000000, // $10 per 1M output tokens
          },
        },
        supportsVision: true,
        supportsTools: true,
        supportsImageVariation: false,
        logoFile: 'Anthropic_logo.png',
        rank: 1, // the Opus and Fable flagships hold rank 0
        trainingCutoff: '2026-01-01',
        releaseDate: '2026-07-01',
        description:
          "Anthropic's newest Claude 5 Sonnet model via AWS Bedrock. Near-Opus quality on coding and agentic work at Sonnet cost, with adaptive extended thinking and a 1M-token context window.",
      },
      {
        id: ChatModels.CLAUDE_5_5_SONNET_BEDROCK,
        type: 'text',
        name: 'Claude Sonnet 5.5',
        backend: ModelBackend.Bedrock,
        contextWindow: 1_000_000,
        max_tokens: 128_000,
        can_stream: true,
        can_think: true,
        thinkingStyle: 'adaptive',
        // Global endpoint; cache hits are 0.05x input on Sonnet 5.5, not the default 0.1x.
        pricing: {
          1_000_000: {
            input: 2 / 1_000_000,
            output: 10 / 1_000_000,
            cache_read: 0.1 / 1_000_000,
            cache_write: 2.5 / 1_000_000,
          },
        },
        supportsVision: true,
        supportsTools: true,
        supportsImageVariation: false,
        logoFile: 'Anthropic_logo.png',
        rank: 1,
        description:
          "Anthropic's Claude 5.5 Sonnet model via AWS Bedrock, with adaptive extended thinking and a 1M-token context window.",
      },
      {
        id: ChatModels.CLAUDE_4_6_OPUS_BEDROCK,
        type: 'text',
        name: 'Claude Opus 4.6',
        backend: ModelBackend.Bedrock,
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
        rank: 1,
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
        name: 'Claude Opus 4.7',
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
        rank: 1,
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
        name: 'Claude Opus 4.8',
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
        rank: 1,
        supportsTools: true,
        trainingCutoff: '2026-01-01',
        releaseDate: '2026-05-28',
        description:
          "Anthropic's previous flagship model via AWS Bedrock. Claude 4.8 Opus delivers enhanced frontier intelligence with improved extended thinking, coding, and agentic capabilities.",
        isSlowModel: true,
      },
      {
        id: ChatModels.CLAUDE_FABLE_5_BEDROCK,
        type: 'text',
        name: 'Claude Fable 5',
        backend: ModelBackend.Bedrock,
        supportsImageVariation: false,
        contextWindow: 1_000_000,
        max_tokens: 128_000,
        can_stream: true,
        can_think: true,
        thinkingStyle: 'adaptive',
        pricing: {
          1_000_000: { input: 10 / 1_000_000, output: 50 / 1_000_000 },
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 0,
        supportsTools: true,
        description: "Anthropic's Claude Fable 5 model via AWS Bedrock for complex, long-running agentic tasks.",
        isSlowModel: true,
        disabled: true,
        disabledReason: FABLE_DISABLED_REASON,
      },
      {
        id: ChatModels.CLAUDE_FABLE_5_1_BEDROCK,
        type: 'text',
        name: 'Claude Fable 5.1',
        backend: ModelBackend.Bedrock,
        supportsImageVariation: false,
        contextWindow: 1_000_000,
        max_tokens: 128_000,
        can_stream: true,
        can_think: true,
        thinkingStyle: 'adaptive',
        // Global endpoint; cache hits are 0.025x input on Fable 5.1, not the default 0.1x.
        pricing: {
          1_000_000: {
            input: 10 / 1_000_000,
            output: 50 / 1_000_000,
            cache_read: 0.25 / 1_000_000,
            cache_write: 12.5 / 1_000_000,
          },
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 0,
        supportsTools: true,
        description: "Anthropic's Claude Fable 5.1 model via AWS Bedrock for complex, long-running agentic tasks.",
        isSlowModel: true,
        disabled: true,
        disabledReason: FABLE_DISABLED_REASON,
      },
      {
        id: ChatModels.CLAUDE_5_OPUS_BEDROCK,
        type: 'text',
        name: 'Claude Opus 5',
        backend: ModelBackend.Bedrock,
        supportsImageVariation: false,
        contextWindow: 1_000_000,
        max_tokens: 128_000,
        can_stream: true,
        can_think: true,
        thinkingStyle: 'adaptive',
        pricing: {
          1_000_000: { input: 5 / 1_000_000, output: 25 / 1_000_000 },
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 0,
        supportsTools: true,
        description: "Anthropic's Claude 5 Opus model via AWS Bedrock for coding, reasoning, and agentic tasks.",
        isSlowModel: true,
      },
      {
        id: ChatModels.CLAUDE_5_5_OPUS_BEDROCK,
        type: 'text',
        name: 'Claude Opus 5.5',
        backend: ModelBackend.Bedrock,
        supportsImageVariation: false,
        contextWindow: 1_000_000,
        max_tokens: 128_000,
        can_stream: true,
        can_think: true,
        thinkingStyle: 'adaptive',
        // Global endpoint, first-party parity; cache hits are 0.05x input on Opus 5.5, not the default 0.1x.
        pricing: {
          1_000_000: {
            input: 4 / 1_000_000,
            output: 20 / 1_000_000,
            cache_read: 0.2 / 1_000_000,
            cache_write: 5 / 1_000_000,
          },
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 0,
        supportsTools: true,
        description: "Anthropic's Claude 5.5 Opus model via AWS Bedrock for coding, reasoning, and agentic tasks.",
        isSlowModel: true,
      },
      {
        id: ChatModels.CLAUDE_5_5_HAIKU_BEDROCK,
        type: 'text',
        name: 'Claude Haiku 5.5',
        backend: ModelBackend.Bedrock,
        supportsImageVariation: false,
        contextWindow: 1_000_000,
        max_tokens: 128_000,
        can_stream: true,
        can_think: true,
        thinkingStyle: 'adaptive',
        // First-party parity on the global endpoint, tiered by prompt length (over 100K prompt tokens pays the higher tier).
        pricing: {
          100_000: { input: 0.1 / 1_000_000, output: 0.5 / 1_000_000 },
          1_000_000: { input: 0.5 / 1_000_000, output: 2.5 / 1_000_000 },
        },
        supportsVision: true,
        logoFile: 'Anthropic_logo.png',
        rank: 3,
        supportsTools: true,
        releaseDate: '2026-10-07',
        description:
          "Anthropic's Claude Haiku 5.5 via AWS Bedrock, built for high-volume, latency-sensitive work, with adaptive thinking and a 1M-token context window.",
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
    const sanitizedMessages = messages
      .filter(
        m =>
          isToolChangeMessage(m) ||
          ((m.role === 'user' || m.role === 'assistant') && m.content !== null && m.content !== undefined)
      )
      // Unlike the other backends this one forwards IMessage objects into the request body largely
      // as-is, so control-only fields have to be dropped here rather than left to the invariant that
      // nothing sets them on a user/assistant message.
      .map(({ requiresTool: _requiresTool, ...m }) => m)
      .map(m => {
        // tool_addition/tool_removal blocks go out verbatim, in place, as on the direct API.
        if (isToolChangeMessage(m)) return m;
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
          // Empty text blocks are filtered BEFORE translation (matching
          // anthropicBackend.ts's sanitizeMessageContent -> toAnthropicContent order),
          // so an image-only array reaches toAnthropicContent's own placeholder guard
          // instead of being padded out with a blank text block that later survives
          // as `content.length === 1` and masks a fully-dropped image.
          const textFiltered = m.content.filter(block => {
            if (isRecord(block) && block.type === 'text') {
              const text = typeof block.text === 'string' ? block.text : '';
              return !!text.trim();
            }
            return true;
          });

          // This body takes the native Anthropic request shape (image/source blocks),
          // so a canonical `image_url` block (guaranteed by normalizeMultimodalMessages
          // upstream, or forwarded as-is by any caller that skips it) needs the same
          // translation anthropicBackend.ts applies to the direct API.
          const translatedContent = toAnthropicContent(textFiltered, Logger.globalInstance) as unknown[];

          // If array is now empty, mark message for removal
          if (translatedContent.length === 0) {
            return { ...m, content: '' };
          }

          return { ...m, content: translatedContent };
        }

        // Convert non-string/non-array content to empty string
        return { ...m, content: '' };
      })
      .filter(m => m.content !== '' && (Array.isArray(m.content) ? m.content.length > 0 : true));

    // Dropping role/empty messages above can leave a tool_result with no tool_use right before it,
    // which Bedrock rejects. Same pass anthropicBackend runs - keep the two in sync.
    const filteredMessages = ensureToolPairingIntegrity(
      sanitizedMessages as unknown as IMessage[],
      Logger.globalInstance
    ) as unknown as typeof sanitizedMessages;

    if (filteredMessages.length === 0) {
      throw new BadRequestError('request must contain at least one non-empty user or assistant message');
    }

    // Kept as discrete blocks, not joined immediately, because a mid-stack cache breakpoint
    // needs a block boundary to attach to. The joined string below is still what the
    // non-caching path sends.
    const systemBlocks = messages
      .filter(m => m.role === 'system' && m.content && !isToolChangeMessage(m))
      .map(m => ({ text: systemContentToText(m.content), cache: m.cache === true }))
      // A block array carrying no text flattens to '', which would otherwise
      // contribute a blank line to the joined prompt. Trim-checked because
      // Bedrock rejects a text block with no non-whitespace content (see the
      // user/assistant sanitizer above, which system messages never reach).
      .filter(block => block.text.trim() !== '');

    // Append model identity so the model correctly identifies itself when asked.
    // Skipped for raw or while current_model_details is on the request (see
    // shouldOmitIdentityReminder) - must stay in sync with anthropicBackend.
    const identityReminder = shouldOmitIdentityReminder(options)
      ? null
      : buildIdentityReminder(options.modelIdentityId ?? model, options.modelDisplayName);

    let systemMessage = systemBlocks.map(block => block.text).join('\n');
    if (identityReminder) {
      systemMessage = appendIdentityReminder(systemMessage, identityReminder);
    }

    // Check if model ID needs to be transformed
    const hasVendorPrefix = model.includes(':') || isBedrockRegionProfileId(model) || model.startsWith('anthropic.');
    const modelId = hasVendorPrefix ? model : `anthropic.${model}`;

    // Ensure maxTokens is always provided and is a number
    const maxTokens = typeof options.maxTokens === 'number' ? options.maxTokens : 4096;

    const body: Record<string, unknown> = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: maxTokens,
      messages: filteredMessages,
    };
    // Bedrock takes Anthropic betas in the body rather than as a header.
    if (filteredMessages.some(m => isToolChangeMessage(m))) {
      body.anthropic_beta = [TOOL_CHANGES_BETA];
    }

    // A `cache: true` system message declares a breakpoint part-way down the stack (the
    // deployment-wide shareable prefix - see markShareablePrefixBoundary in @bike4mind/services).
    // Bedrock takes the native Anthropic body, so the array-of-blocks `system` form carries
    // cache_control here exactly as it does on the direct API; the joined string above collapses
    // the whole stack into one block, which leaves nowhere to put a breakpoint except the end and
    // makes the flag a silent no-op. Gated on the same two checks as applyCaching below so a model
    // that rejects cache_control never sees one. Must stay in sync with anthropicBackend, which
    // makes the same string-vs-blocks choice.
    // A tool round appends the previous round's tool_use/tool_result, which the next round re-sends
    // verbatim, so the end of the array is history again - unlike the first call, where it is the
    // volatile current turn the caller anchors ahead of itself. See the same override in
    // anthropicBackend.
    const cacheStrategy =
      (options._internal?.toolCallCount ?? 0) > 0 && options.cacheStrategy
        ? { ...options.cacheStrategy, cacheConversationHistory: true }
        : options.cacheStrategy;
    const modelSupportsCaching = !BEDROCK_NO_PROMPT_CACHING_MODELS.has(modelId);
    const emitCaching = Boolean(cacheStrategy?.enableCaching) && modelSupportsCaching;
    const emitSystemCacheBreakpoint = emitCaching && systemBlocks.some(block => block.cache);
    // Same TTL as applyCaching gives the other breakpoints: Anthropic constrains how
    // mixed-TTL breakpoints may be ordered, and matching sidesteps that entirely.
    const cacheControl = {
      type: 'ephemeral' as const,
      ...(cacheStrategy?.cacheTTL === '1h' ? { ttl: cacheStrategy.cacheTTL } : {}),
    };

    // A `cache: true` user/assistant message declares a mid-history breakpoint (see
    // markHistoryCacheAnchor in @bike4mind/services). This backend forwards IMessage objects into
    // the request body, so the control flag has to become cache_control on the message's last
    // content block - and must never be serialized, since the wire has no such field.
    // On a tool round only the newest flagged message is still read; see the same rule in anthropicBackend.
    const newestFlagged =
      (options._internal?.toolCallCount ?? 0) > 0 ? filteredMessages.findLastIndex(m => m.cache === true) : -1;
    body.messages = filteredMessages.map((message, index) => {
      const { cache, ...wire } = message;
      if (!emitCaching || cache !== true || index < newestFlagged) return wire;
      const content =
        typeof wire.content === 'string'
          ? [{ type: 'text' as const, text: wire.content }]
          : [...(wire.content as Array<Record<string, unknown>>)];
      if (content.length === 0) return wire;
      content[content.length - 1] = { ...content[content.length - 1], cache_control: cacheControl };
      return { ...wire, content };
    });

    if (emitSystemCacheBreakpoint) {
      const blocks: Array<Record<string, unknown>> = systemBlocks.map(block =>
        block.cache
          ? { type: 'text', text: block.text, cache_control: cacheControl }
          : { type: 'text', text: block.text }
      );
      // Identity reminder stays last and carries no breakpoint of ours: it holds the model id, so
      // anchoring the shared head on it would bust that prefix on every model change. applyCaching
      // still marks the final block as the end-of-system breakpoint, exactly as it did when this
      // was one joined string.
      if (identityReminder) {
        blocks.push({ type: 'text', text: identityReminder });
      }
      body.system = blocks;
    } else if (systemMessage) {
      body.system = systemMessage;
    }

    if (options.tools?.length || options.providerTools?.length) {
      body.tools = this.formatTools(options.tools, options.providerTools);
    }

    // Add temperature if provided (Claude 4.7 Opus does not accept temperature at all)
    if (typeof options.temperature === 'number' && !this.omitsSamplingParams(model)) {
      body.temperature = options.temperature;
    }

    // Add top_p if provided
    // top_p and temperature together is not supported for claude-4-5-sonnet
    if (
      typeof options.topP === 'number' &&
      !TEMPERATURE_ONLY_MODELS.includes(model as ChatModels) &&
      !this.omitsSamplingParams(model)
    ) {
      body.top_p = options.topP;
    }

    // Add thinking parameters for models that support it. A catalog-only model
    // brings its own record, so a new Bedrock Claude gets the right thinking
    // shape (buildThinkingParams reads thinkingStyle) instead of none at all.
    const currentModelInfo = this.modelRecordFor(model);
    const supportsThinking = currentModelInfo?.can_think === true;

    if (supportsThinking && currentModelInfo) {
      // questMaster is an Anthropic-specific extra not on the generic ICompletionOptions;
      // cast locally for that one field (thinking is already declared on the type).
      const isQuestMaster = (options as { questMaster?: boolean }).questMaster === true;
      const reasoningEffort =
        options.reasoningEffort ?? effortForComplexity(model, currentModelInfo, options.complexity);
      const userThinkingEnabled = options.thinking?.enabled === true;

      if (userThinkingEnabled || isQuestMaster) {
        const budgetTokens = isQuestMaster
          ? Math.min(Math.floor(maxTokens * 0.25), 4096)
          : (options.thinking?.budget_tokens ?? 16000);
        const effort = resolveAnthropicEffort({
          questMaster: isQuestMaster,
          anthropicEffort: options.anthropicEffort,
          reasoningEffort: options.reasoningEffort,
        });

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
      } else if (reasoningEffort) {
        const plan = planReasoningEffort(model, currentModelInfo, reasoningEffort, maxTokens);
        if (plan.kind !== 'default') body.thinking = plan.thinking;
        if (plan.kind === 'adaptive') body.output_config = plan.output_config;
        if (plan.kind === 'budget') {
          if (plan.temperature === 'delete') delete body.temperature;
          else body.temperature = plan.temperature;
          delete body.top_p;
        }
      }
    }
    applyAnthropicOutputCeiling(body, options.outputTokenCeiling);

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

    // A caller's own content-block markers ride in on `messages` untouched; Bedrock reports no 5m/1h
    // split, so on a 1h request they must write at 1h to match what settlement charges.
    if (cacheStrategy?.cacheTTL === '1h') Object.assign(body, withRequestTtlMarkers(body, cacheControl));
    Object.assign(body, capCacheControlMarkers(body));

    return {
      modelId: modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    };
  }

  formatMessages(messages: IMessage[]): IMessage[] {
    // Pure: base.ts re-runs this over the SAME messages array every tool round, so the merges
    // below push shallow copies (content arrays are replaced, never mutated in place).
    // Regression context: anthropic.cacheControlToolRounds.test.ts.
    const formattedMessages = messages.reduce((cur, value) => {
      const previousMessage = cur[cur.length - 1];

      // A message carrying a cache breakpoint ENDS its run: merging the next one into it would
      // drag content past the boundary and the breakpoint would no longer describe the shared
      // prefix. getPayload emits each surviving system message as its own `system` block, so the
      // split here is what gives the breakpoint somewhere to land.
      if (previousMessage && value.role === previousMessage.role && previousMessage.cache !== true) {
        // if the previous message is the same
        // then skip the current message
        if (previousMessage.content === value.content) {
          if (value.cache === true) previousMessage.cache = true;
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
            cur.push({ ...value });
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
          if (value.cache === true) cur[lastIndex].cache = true;

          // if not
          // then add the current message to the previous message content
        } else {
          // Only merge if current value.content is a string (not an array with images)
          if (typeof value.content !== 'string') {
            cur.push({ ...value });
            return cur;
          }

          const content = previousMessage.content as MessageContentText[];
          // APPEND, never discard. This branch used to bail out with `return cur` whenever the
          // accumulated content already held a text block - which is true for every message after
          // the second - so a run of N same-role messages silently collapsed to the FIRST TWO and
          // the rest vanished before the request was built.
          //
          // System messages are all consecutive at the head of the prompt, so on Bedrock that meant
          // only the date + artifact prompt survived: the help-center prompt, tool guidance,
          // knowledge retrieval, session/org prompts and BOTH Mementos versions were dropped, with
          // no error and no log. Mementos could never reach the model on a Bedrock Claude - the
          // default chat model.
          const textContent = typeof value.content === 'string' ? value.content : '';
          if (textContent) {
            previousMessage.content = [...content, { type: 'text', text: textContent }];
          }
          if (value.cache === true) previousMessage.cache = true;
        }

        return cur;
      }

      // Push the message if the role is different
      cur.push({ ...value });

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
        content: Array<AssistantBlock & { text?: string }>;
        model: string;
        stop_reason: string;
        usage: {
          input_tokens: number;
          output_tokens: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      };

      // Keep the turn's reasoning blocks for the tool-continuation replay. An adaptive
      // model returns them whether or not the request asked for thinking, so their mere
      // presence is not an anomaly - see takeReasoningBlocks.
      this.assistantContent = response.content.map(c => ({ ...c }));
      const reasoningCount = response.content.filter(isReasoningBlock).length;
      if (reasoningCount > 0) {
        console.log(`[AnthropicBedrockBackend] Captured ${reasoningCount} reasoning block(s) for tool continuation`);
      }

      const providerBlocks: NonNullable<ICompletionResponseChunk['providerBlocks']> = [];
      let textOffset = 0;
      for (const block of response.content) {
        if (block.type === 'text') textOffset += block.text?.length ?? 0;
        else if (isProviderBlock(block)) providerBlocks.push({ providerBlock: anthropicBlock(block), textOffset });
      }

      const stopReason = (response as { stop_reason?: string }).stop_reason;
      if (stopReason === 'refusal' && REFUSAL_FALLBACK_MODELS.has(model)) {
        throw new Error(`Anthropic safety classifier refusal for ${model} - falling back to an alternative model`);
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

      const usage = {
        input_tokens: response.usage?.input_tokens || 0,
        output_tokens: response.usage?.output_tokens || 0,
        cache_read_input_tokens: response.usage?.cache_read_input_tokens,
        cache_creation_input_tokens: response.usage?.cache_creation_input_tokens,
      };
      // The base loop executes every TOOL_USE choice; keep prose and usage on the first
      // choice only so a parallel tool turn neither duplicates text nor counts usage twice.
      const choices: IChoiceEnd[] =
        toolUseBlocks.length > 0
          ? toolUseBlocks.map((tool, index) => ({
              status: ChoiceStatus.END,
              statusEndReason: ChoiceEndReason.TOOL_USE,
              index,
              chunkText: index === 0 ? textContent : '',
              ...(index === 0 ? { usage } : {}),
              tool: { id: tool.id, name: tool.name, parameters: JSON.stringify(tool.input) },
            }))
          : [
              {
                status: ChoiceStatus.END,
                statusEndReason: ChoiceEndReason.COMPLETE,
                index: 0,
                chunkText: textContent,
                usage,
              },
            ];

      return {
        done: true,
        chunk: {
          model,
          choices,
          ...(providerBlocks.length > 0 ? { providerBlocks } : {}),
          ...(stopReason ? { stopReason } : {}),
        },
      };
    } catch (error) {
      console.error('[AnthropicBedrockBackend] Error translating non-streaming chunk:', error);
      throw error;
    }
  }

  translateStreamChunk(model: string, chunk: unknown): { done: boolean; chunk?: ICompletionResponseChunk } {
    let done = false;
    let refused = false;
    let choice: IChoice;
    let stopReason: string | undefined;
    const providerBlocks: NonNullable<ICompletionResponseChunk['providerBlocks']> = [];

    // Default choice with empty text
    choice = {
      status: ChoiceStatus.STREAM,
      chunkText: '',
    } as IChoice;

    try {
      if (isMessageStart(chunk)) {
        // Reset thinking block state at the start of a new message
        this.isInThinkingBlock = false;
        this.reasoningEscaper = createThinkMarkerEscaper();
        this.assistantContent = [];
        this.serverToolInputJson.clear();
        // output_tokens is deliberately omitted: message_start reports only a placeholder for it, and
        // base.ts's stopped-call estimate keys on a 0 output count to detect that the terminal usage
        // event never arrived. Forwarding it here would silently disable that estimate; keep in sync
        // with the guard in base.ts.
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

        const contentBlock: unknown = chunk.content_block;

        if (isToolUseContentBlock(contentBlock)) {
          choice.tool = {
            name: contentBlock.name,
            id: contentBlock.id,
          };
          // A placeholder for its position; pushToolMessages fills in the input base.ts parsed.
          this.assistantContent[chunk.index] = { type: 'tool_use', id: contentBlock.id, name: contentBlock.name };
        } else if (isThinkingContentBlock(contentBlock)) {
          this.isInThinkingBlock = true;
          // thinking_delta / signature_delta accumulate into this block for the replay.
          this.assistantContent[chunk.index] = { ...contentBlock, thinking: contentBlock.thinking ?? '' };
          choice.chunkText = '<think>';
          choice.channel = 'reasoning';
        } else if (isRedactedThinkingContentBlock(contentBlock)) {
          // Arrives whole and carries no readable text, so it opens no <think> markers -
          // but it still has to be replayed alongside its turn's tool_use block.
          this.assistantContent[chunk.index] = { ...contentBlock };
        } else if (isProviderBlock(contentBlock)) {
          this.assistantContent[chunk.index] = { ...contentBlock };
          if (contentBlock.type === 'server_tool_use') {
            // Its input streams as input_json_delta; surfaced at content_block_stop once whole.
            this.serverToolInputJson.set(chunk.index, '');
          } else {
            providerBlocks.push({ providerBlock: anthropicBlock(contentBlock), textOffset: 0 });
          }
        } else if (isRecord(contentBlock) && contentBlock.type === 'text') {
          // Citations are not kept: the replayed turn only needs the text.
          this.assistantContent[chunk.index] = {
            type: 'text',
            text: typeof contentBlock.text === 'string' ? contentBlock.text : '',
          };
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
          choice.toolArguments = false;
          const block = this.assistantContent[chunk.index];
          if (block?.type === 'text') block.text = `${block.text}${delta.text}`;
        } else if (isInputJsonDelta(delta) && this.serverToolInputJson.has(chunk.index)) {
          // Not a tool argument and not prose: kept off chunkText so base.ts never streams it as text.
          this.serverToolInputJson.set(chunk.index, this.serverToolInputJson.get(chunk.index) + delta.partial_json);
        } else if (isInputJsonDelta(delta)) {
          choice.chunkText = delta.partial_json;
        } else if (isThinkingDelta(delta)) {
          // Escaped for the transcript; the replay copy in assistantContent stays
          // raw since it is resent to the API verbatim in tool-use loops.
          choice.chunkText = this.reasoningEscaper.push(delta.thinking);
          choice.channel = 'reasoning';
          const block = this.assistantContent[chunk.index];
          if (block?.type === 'thinking') block.thinking = `${block.thinking}${delta.thinking}`;
        } else if (isSignatureDelta(delta)) {
          // Cryptographic signature for the open thinking block, arriving just before
          // content_block_stop. Carries no user-visible text - it exists only so the
          // block can be replayed on a tool continuation and still validate.
          const block = this.assistantContent[chunk.index];
          if (block?.type === 'thinking') block.signature = delta.signature;
        }
      } else if (isContentBlockStop(chunk)) {
        choice = {
          status: ChoiceStatus.STREAM,
          index: chunk.index,
          chunkText: this.isInThinkingBlock ? this.reasoningEscaper.flush() + '</think>' : '',
          ...(this.isInThinkingBlock ? { channel: 'reasoning' as const } : {}),
        } as IChoice;

        // Reset thinking block state
        this.isInThinkingBlock = false;

        const inputJson = this.serverToolInputJson.get(chunk.index);
        const serverBlock = this.assistantContent[chunk.index];
        if (inputJson !== undefined && serverBlock) {
          this.serverToolInputJson.delete(chunk.index);
          // content_block_start may omit input; the API rejects a replayed server_tool_use without one.
          serverBlock.input ??= {};
          if (inputJson) {
            try {
              serverBlock.input = JSON.parse(inputJson);
            } catch (e) {
              console.warn('[AnthropicBedrockBackend] Malformed server tool input JSON at content_block_stop', {
                model,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }
          providerBlocks.push({ providerBlock: anthropicBlock(serverBlock), textOffset: 0 });
        }
      } else if (isMessageDelta(chunk)) {
        refused = chunk.delta?.stop_reason === 'refusal' && REFUSAL_FALLBACK_MODELS.has(model);
        // Anthropic's native vocabulary is the canonical one, so it passes through unchanged. base.ts
        // forwards it to CompletionInfo.stopReason; without it a max_tokens cut-off is silent. pause_turn
        // additionally tells the caller to re-send and resume a paused server tool loop.
        if (chunk.delta?.stop_reason) stopReason = chunk.delta.stop_reason;
        // The final usage, which can exceed message_start's input: a tool search that loads deferred
        // definitions mid-response bills them here. base.ts keeps the larger of the two.
        choice = {
          status: ChoiceStatus.STREAM,
          chunkText: '',
          usage: {
            output_tokens: chunk.usage.output_tokens,
            ...(chunk.usage.input_tokens != null ? { input_tokens: chunk.usage.input_tokens } : {}),
            ...(chunk.usage.cache_read_input_tokens != null
              ? { cache_read_input_tokens: chunk.usage.cache_read_input_tokens }
              : {}),
            ...(chunk.usage.cache_creation_input_tokens != null
              ? { cache_creation_input_tokens: chunk.usage.cache_creation_input_tokens }
              : {}),
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

    // Thrown outside the try: the catch above swallows errors.
    if (refused) {
      throw new Error(`Anthropic safety classifier refusal for ${model} - falling back to an alternative model`);
    }

    return {
      done,
      chunk: {
        model,
        choices: [choice],
        ...(providerBlocks.length > 0 ? { providerBlocks } : {}),
        ...(stopReason ? { stopReason } : {}),
      },
    };
  }

  formatTools(tools: ICompletionOptionTools[] = [], providerTools: ToolSearchServerTool[] = []) {
    const customTools = sortToolsForStableCacheKey(tools).map(tool => {
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
    return [...customTools, ...providerTools];
  }

  pushToolMessages(messages: IMessage[], tool: IChoiceEndToolUse['tool'], result: string, thinkingBlocks?: unknown[]) {
    const toolUseBlock = {
      type: 'tool_use' as const,
      id: tool.id,
      name: tool.name,
      input: JSON.parse(tool.parameters || '{}'),
    };
    const toolResult = { type: 'tool_result' as const, tool_use_id: tool.id, content: result };

    // Blocks the caller supplies win: base.ts's tool loop takes them once per round and
    // passes the same array for every tool in it, and the executeTools: false path knows
    // its own. Falling back covers a direct call with neither - an assistant turn that
    // reasoned must not reach the provider as a bare tool_use. See takeReasoningBlocks.
    const reasoningBlocks = thinkingBlocks?.length ? thinkingBlocks : this.takeReasoningBlocks();

    // A turn with provider blocks is replayed as the provider sent it: those blocks cannot be split
    // across synthetic turns, so parallel calls share one assistant turn and one user message.
    const replaysTurn =
      this.replayContent.some(isProviderBlock) &&
      this.replayContent.some(b => b.type === 'tool_use' && b.id === tool.id);
    if (replaysTurn) {
      this.pushReplayedToolMessages(messages, toolUseBlock, toolResult);
      return;
    }

    const assistantContent: IMessage['content'] =
      reasoningBlocks.length > 0
        ? [...(reasoningBlocks as Array<{ type: 'thinking'; thinking: string; signature: string }>), toolUseBlock]
        : [toolUseBlock];

    messages.push({
      role: 'assistant',
      content: assistantContent,
    });
    messages.push({
      role: 'user',
      content: [toolResult],
    });
  }

  /**
   * Replays `replayContent` in order with only the tool_use blocks that have a result so far, so a
   * call base.ts skipped (no toolFn, bad arguments) never reaches the provider unanswered.
   */
  private pushReplayedToolMessages(
    messages: IMessage[],
    toolUseBlock: { type: 'tool_use'; id: string; name: string; input: unknown },
    toolResult: { type: 'tool_result'; tool_use_id: string; content: string }
  ): void {
    const previousTurn = messages[messages.length - 2];
    const previousResults = messages[messages.length - 1];
    const joinsSibling =
      this.replayedTurn !== undefined &&
      previousTurn?.role === 'assistant' &&
      previousTurn.content === this.replayedTurn &&
      previousResults?.role === 'user' &&
      Array.isArray(previousResults.content);

    const answered = new Map<string, unknown>();
    if (joinsSibling) {
      for (const block of this.replayedTurn as Array<{ type?: string; id?: string }>) {
        if (block.type === 'tool_use' && block.id) answered.set(block.id, block);
      }
    }
    answered.set(toolUseBlock.id, toolUseBlock);

    const content = this.replayContent.flatMap(block => {
      if (block.type === 'tool_use') return answered.has(block.id as string) ? [answered.get(block.id as string)] : [];
      // The API rejects an empty text block on replay.
      if (block.type === 'text' && !block.text) return [];
      return [block];
    }) as IMessage['content'];
    this.replayedTurn = content as unknown[];

    if (joinsSibling) {
      messages[messages.length - 2] = { ...previousTurn, content };
      messages[messages.length - 1] = {
        ...previousResults,
        content: [...(previousResults.content as unknown[]), toolResult] as IMessage['content'],
      };
      return;
    }
    messages.push({ role: 'assistant', content });
    messages.push({ role: 'user', content: [toolResult] });
  }

  replaceLastToolResultObservation(messages: IMessage[], toolCallId: string, newObservation: string): void {
    replaceLastToolResultObservationCanonical(messages, toolCallId, newObservation);
  }

  getLatestToolCallId(messages: IMessage[], toolName: string): string | undefined {
    return getLatestToolCallIdCanonical(messages, toolName);
  }
}
