import { z } from 'zod';

/**
 * Model backends
 */
export enum ModelBackend {
  OpenAI = 'openai',
  Bedrock = 'bedrock',
  Anthropic = 'anthropic',
  Gemini = 'gemini',
  Ollama = 'ollama',
  BFL = 'bfl',
  XAI = 'xai',
  VoyageAI = 'voyageai',
  AWS = 'aws',
}

/**
 * Image Models
 */
export enum ImageModels {
  GPT_IMAGE_1 = 'gpt-image-1',
  GPT_IMAGE_1_5 = 'gpt-image-1.5',
  GPT_IMAGE_1_MINI = 'gpt-image-1-mini',
  GPT_IMAGE_2 = 'gpt-image-2',
  DALL_E_2 = 'dall-e-2',
  FLUX_PRO = 'flux-pro',
  FLUX_PRO_1_1 = 'flux-pro-1.1',
  FLUX_PRO_ULTRA = 'flux-pro-1.1-ultra',
  FLUX_PRO_FILL = 'flux-pro-1.0-fill',
  FLUX_KONTEXT_PRO = 'flux-kontext-pro',
  FLUX_KONTEXT_MAX = 'flux-kontext-max',
  GROK_IMAGINE_IMAGE_QUALITY = 'grok-imagine-image-quality',
  GEMINI_2_5_FLASH_IMAGE = 'gemini-2.5-flash-image',
  GEMINI_3_PRO_IMAGE_PREVIEW = 'gemini-3-pro-image-preview',
  GEMINI_3_1_FLASH_IMAGE = 'gemini-3.1-flash-image', // Nano Banana 2
  GEMINI_3_PRO_IMAGE = 'gemini-3-pro-image', // Nano Banana Pro
}
export const IMAGE_MODELS = Object.values(ImageModels);
export const supportedImageModels = z.enum(ImageModels);
export type ImageModelName = z.infer<typeof supportedImageModels>;

/**
 * Image size constraints and options
 */
export const IMAGE_SIZE_CONSTRAINTS = {
  BFL: {
    minWidth: 256,
    maxWidth: 1440,
    minHeight: 256,
    maxHeight: 1440,
    stepSize: 32,
    defaultSize: '1280x960',
    sizes: [
      '1280x960', // Default - higher quality 4:3
      '1024x768', // Standard 4:3
      '800x600', // Smaller 4:3
      '1280x720', // HD 16:9
      '1024x576', // Smaller 16:9
      '1440x810', // Larger 16:9
      '1024x1024', // Large square
      '768x768', // Medium square
      '512x512', // Small square
      '960x1280', // Large portrait
      '768x1024', // Standard portrait
      '600x800', // Small portrait
    ] as const,
  },
  GPT_IMAGE_1: {
    sizes: ['1024x1024', '1024x1536', '1536x1024'] as const,
    defaultSize: '1024x1024',
  },
  GPT_IMAGE_2: {
    /** Popular preset sizes shown in the UI. The API accepts any resolution meeting the constraints. */
    sizes: ['1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', '3840x2160', '2160x3840'] as const,
    defaultSize: '1024x1024',
    /** Constraints for custom/flexible sizes */
    constraints: {
      maxEdge: 3840,
      minTotalPixels: 655_360,
      maxTotalPixels: 8_294_400,
      edgeMultiple: 16,
      maxAspectRatio: 3,
    },
  },
} as const;

export type GPTImage1Size = (typeof IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_1.sizes)[number];
export type GPTImage2Size = (typeof IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.sizes)[number] | `${number}x${number}`;
export type BFLSize = `${number}x${number}`;

export type ImageSize = GPTImage1Size | GPTImage2Size | BFLSize;

/**
 * Chat Models
 *
 * https://platform.openai.com/docs/models/continuous-model-upgrades
 */
export enum ChatModels {
  GPT4_1 = 'gpt-4.1-2025-04-14',
  GPT4_1_MINI = 'gpt-4.1-mini-2025-04-14',
  GPT4_1_NANO = 'gpt-4.1-nano-2025-04-14',
  O1 = 'o1-2024-12-17',
  O3 = 'o3-2025-04-16',
  GPT4o = 'gpt-4o',
  GPT4o_MINI = 'gpt-4o-mini',
  O1_PREVIEW = 'o1-preview-2024-09-12',
  O1_MINI = 'o1-mini-2024-09-12',
  O3_MINI = 'o3-mini-2025-01-31',
  O4_MINI = 'o4-mini-2025-04-16',
  GPT4_5_PREVIEW = 'gpt-4.5-preview-2025-02-27',
  GPT4_TURBO = 'gpt-4-turbo',
  GPT4 = 'gpt-4',

  // GPT-5 family
  GPT5 = 'gpt-5',
  GPT5_MINI = 'gpt-5-mini',
  GPT5_NANO = 'gpt-5-nano',
  GPT5_CHAT_LATEST = 'gpt-5-chat-latest',

  //GPT 5.1
  GPT5_1 = 'gpt-5.1',
  GPT5_1_CHAT_LATEST = 'gpt-5.1-chat-latest',

  // GPT 5.2
  GPT5_2 = 'gpt-5.2',
  GPT5_2_CHAT_LATEST = 'gpt-5.2-chat-latest',

  // GPT 5.4
  GPT5_4 = 'gpt-5.4',
  GPT5_4_MINI = 'gpt-5.4-mini',
  GPT5_4_NANO = 'gpt-5.4-nano',

  // GPT 5.5
  GPT5_5 = 'gpt-5.5',

  LLAMA3_INSTRUCT_8B_V1 = 'meta.llama3-8b-instruct-v1:0',
  LLAMA3_INSTRUCT_70B_V1 = 'meta.llama3-70b-instruct-v1:0',

  // Llama 4 models on Bedrock
  LLAMA4_MAVERICK_17B_INSTRUCT_BEDROCK = 'us.meta.llama4-maverick-17b-instruct-v1:0',
  LLAMA4_SCOUT_17B_INSTRUCT_BEDROCK = 'us.meta.llama4-scout-17b-instruct-v1:0',

  // Local Ollama models
  LLAMA3_LOCAL = 'llama3.3',
  DEEPSEEK_R1 = 'deepseek-r1:latest',
  TINYLLAMA = 'tinyllama',
  // End Local Ollama models

  // Bedrock hosted DeepSeek models
  DEEPSEEK_R1_BEDROCK = 'us.deepseek.r1-v1:0',
  DEEPSEEK_V3_1 = 'deepseek.v3-v1:0',

  TITAN_TEXT_G1_LITE = 'amazon.titan-text-lite-v1',
  TITAN_TEXT_G1_EXPRESS = 'amazon.titan-text-express-v1',
  // Bedrock hosted Anthropic models
  CLAUDE_3_HAIKU_BEDROCK = 'anthropic.claude-3-haiku-20240307-v1:0',
  CLAUDE_3_5_HAIKU_BEDROCK = 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
  CLAUDE_3_5_SONNET_BEDROCK = 'anthropic.claude-3-5-sonnet-20240620-v1:0',

  // Claude 4 series on Bedrock
  CLAUDE_4_OPUS_BEDROCK = 'us.anthropic.claude-opus-4-20250514-v1:0',
  CLAUDE_4_1_OPUS_BEDROCK = 'us.anthropic.claude-opus-4-1-20250805-v1:0',
  CLAUDE_4_SONNET_BEDROCK = 'us.anthropic.claude-sonnet-4-20250514-v1:0',
  CLAUDE_3_5_SONNET_V2_BEDROCK = 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
  CLAUDE_3_7_SONNET_BEDROCK = 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
  CLAUDE_4_5_SONNET_BEDROCK = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  CLAUDE_4_5_HAIKU_BEDROCK = 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  CLAUDE_4_5_OPUS_BEDROCK = 'global.anthropic.claude-opus-4-5-20251101-v1:0',
  CLAUDE_4_6_SONNET_BEDROCK = 'global.anthropic.claude-sonnet-4-6',
  CLAUDE_5_SONNET_BEDROCK = 'global.anthropic.claude-sonnet-5',
  CLAUDE_4_6_OPUS_BEDROCK = 'global.anthropic.claude-opus-4-6-v1',
  CLAUDE_4_7_OPUS_BEDROCK = 'global.anthropic.claude-opus-4-7',
  CLAUDE_4_8_OPUS_BEDROCK = 'global.anthropic.claude-opus-4-8',

  // Anthropic hosted Anthropic models
  CLAUDE_3_OPUS = 'claude-3-opus-20240229',
  CLAUDE_3_5_HAIKU_ANTHROPIC = 'claude-3-5-haiku-20241022',
  CLAUDE_3_5_SONNET_ANTHROPIC = 'claude-3-5-sonnet-20241022',
  CLAUDE_3_7_SONNET_ANTHROPIC = 'claude-3-7-sonnet-20250219',
  CLAUDE_4_OPUS = 'claude-opus-4-20250514',
  CLAUDE_4_1_OPUS = 'claude-opus-4-1-20250805',
  CLAUDE_4_SONNET = 'claude-sonnet-4-20250514',
  CLAUDE_4_5_SONNET = 'claude-sonnet-4-5-20250929',
  CLAUDE_4_5_HAIKU = 'claude-haiku-4-5-20251001',
  CLAUDE_4_5_OPUS = 'claude-opus-4-5-20251101',
  CLAUDE_4_6_SONNET = 'claude-sonnet-4-6',
  CLAUDE_5_SONNET = 'claude-sonnet-5',
  CLAUDE_4_6_OPUS = 'claude-opus-4-6',
  CLAUDE_4_7_OPUS = 'claude-opus-4-7',
  CLAUDE_4_8_OPUS = 'claude-opus-4-8',
  CLAUDE_FABLE_5 = 'claude-fable-5',

  JURASSIC2_ULTRA = 'ai21.j2-ultra-v1',
  JURASSIC2_MID = 'ai21.j2-mid-v1',

  // GEMINI
  // Gemini 3.5
  GEMINI_3_5_FLASH = 'gemini-3.5-flash',

  // Gemini 3.1
  GEMINI_3_1_PRO_PREVIEW = 'gemini-3.1-pro-preview',
  GEMINI_3_1_FLASH_LITE = 'gemini-3.1-flash-lite',

  // Gemini 3
  GEMINI_3_FLASH_PREVIEW = 'gemini-3-flash-preview',

  // Gemini Legacy/Experimental/Deprecated Models
  GEMINI_3_PRO_PREVIEW = 'gemini-3-pro-preview',
  GEMINI_2_5_PRO = 'gemini-2.5-pro',
  GEMINI_2_5_FLASH = 'gemini-2.5-flash',
  GEMINI_2_5_FLASH_LITE = 'gemini-2.5-flash-lite',
  GEMINI_2_5_FLASH_PREVIEW = 'gemini-2.5-flash-preview-09-25',
  GEMINI_2_5_PRO_PREVIEW = 'gemini-2.5-pro-preview-05-06',
  GEMINI_2_0_FLASH_EXP = 'gemini-2.0-flash-exp',
  GEMINI_1_5_FLASH = 'gemini-1.5-flash',
  GEMINI_1_5_FLASH_8B = 'gemini-1.5-flash-8b',
  GEMINI_1_5_PRO = 'gemini-1.5-pro',
  GROK_1 = 'grok-1',

  // xAI Models
  GROK_3 = 'grok-3',
  GROK_3_FAST = 'grok-3-fast',
  GROK_3_MINI = 'grok-3-mini',
  GROK_3_MINI_FAST = 'grok-3-mini-fast',
  GROK_2 = 'grok-2-1212',
  GROK_2_VISION = 'grok-2-vision-1212',
  GROK_4 = 'grok-4-0709',
  GROK_BETA = 'grok-beta',
  GROK_VISION_BETA = 'grok-vision-beta',
}
export const CHAT_MODELS = Object.values(ChatModels);
export const supportedChatModels = z.enum(ChatModels);
export type ChatModelName = z.infer<typeof supportedChatModels>;

/**
 * Models that support the reasoning_effort parameter.
 * o1-preview and o1-mini do NOT support reasoning_effort.
 */
export const REASONING_SUPPORTED_MODELS: ReadonlySet<string> = new Set([
  ChatModels.O1,
  ChatModels.O3_MINI,
  ChatModels.O3,
  ChatModels.O4_MINI,
  ChatModels.GPT5,
  ChatModels.GPT5_MINI,
  ChatModels.GPT5_NANO,
  ChatModels.GPT5_1,
  ChatModels.GPT5_2,
  ChatModels.GPT5_4,
  ChatModels.GPT5_4_MINI,
  ChatModels.GPT5_4_NANO,
]);

/**
 * GPT-5-family reasoning models whose tool calling breaks on
 * `/v1/chat/completions` when `reasoning_effort` is also sent. OpenAI requires
 * this combination to go through `/v1/responses` instead. The failure mode
 * differs by model:
 *   - GPT-5.4 (and -mini/-nano) hard-reject with a 400:
 *       "Function tools with reasoning_effort are not supported for <model> in
 *        /v1/chat/completions. Please use /v1/responses instead."
 *   - GPT-5 / -mini / -nano / 5.1 / 5.2 return 200 but silently degrade: the
 *     model *narrates* the tool call in its text ("Calling the tool now...")
 *     instead of emitting a real `tool_calls` entry, so no tool ever executes.
 *     This surfaced as the /opti optimizer's "Draft with AI" doing nothing on
 *     GPT-5: the same request on a model with `reasoning_effort`
 *     dropped (or on Claude) fires the tool correctly.
 *
 * We drop `reasoning_effort` when tools are sent for these models so tool
 * calling continues to work on `/v1/chat/completions`. Dropping it only forgoes
 * explicit effort control - the model still reasons at its default.
 *
 * NOTE: for the base GPT-5 narrator family (`RESPONSES_API_TOOL_MODELS`), the
 * adapter now routes tool turns to `/v1/responses` instead - where reasoning +
 * tools work together, so `reasoning_effort` is kept. This drop remains as
 * defense-in-depth for the (now-unreached) chat path and covers the GPT-5.4
 * family, which is NOT routed to Responses (its drop-path already works).
 *
 * O-series reasoning models (o1/o3/o4) are intentionally excluded: they call
 * tools correctly with `reasoning_effort` on `/v1/chat/completions`.
 *
 * Invariant: every member here MUST also be in `REASONING_SUPPORTED_MODELS`.
 * The gate in `openaiBackend.ts` short-circuits when a model doesn't support
 * reasoning at all, so adding a non-reasoning model here would make the gate
 * a no-op and silently leak `reasoning_effort` to the request.
 */
export const REASONING_EFFORT_INCOMPATIBLE_WITH_TOOLS_MODELS: ReadonlySet<string> = new Set([
  ChatModels.GPT5,
  ChatModels.GPT5_MINI,
  ChatModels.GPT5_NANO,
  ChatModels.GPT5_1,
  ChatModels.GPT5_2,
  ChatModels.GPT5_4,
  ChatModels.GPT5_4_MINI,
  ChatModels.GPT5_4_NANO,
]);

/**
 * GPT-5 reasoning models that silently *narrate* tool calls on
 * `/v1/chat/completions` (return 200 with the call written as text instead of a
 * real `tool_calls` entry, so nothing executes). The adapter
 * routes these to OpenAI's `/v1/responses` API when function tools are present,
 * where reasoning + tools work together and `reasoning_effort` can be kept.
 *
 * Deliberately excludes the GPT-5.4 family: it *hard-errors* (400) on that
 * combination and is already handled by dropping `reasoning_effort` on the chat
 * path (see `REASONING_EFFORT_INCOMPATIBLE_WITH_TOOLS_MODELS`), so it stays on
 * the working chat path to keep this routing's blast radius small. Also excludes
 * `*-chat-latest` (non-reasoning) and O-series (tools work there already).
 *
 * Invariant: every member MUST also be in `REASONING_EFFORT_INCOMPATIBLE_WITH_TOOLS_MODELS`
 * so the chat path still drops `reasoning_effort` as a fallback if routing is bypassed.
 */
export const RESPONSES_API_TOOL_MODELS: ReadonlySet<string> = new Set([
  ChatModels.GPT5,
  ChatModels.GPT5_MINI,
  ChatModels.GPT5_NANO,
  ChatModels.GPT5_1,
  ChatModels.GPT5_2,
]);

/**
 * Models that only support temperature=1 (no custom temperature).
 * Includes:
 *  - All reasoning models (OpenAI requires temp=1 when reasoning is active)
 *  - chat-latest variants that enforce this constraint
 *  - GPT-5.5, which rejects custom temperature even though it does not expose
 *    reasoning controls
 */
export const FIXED_TEMPERATURE_MODELS: ReadonlySet<string> = new Set([
  ...Array.from(REASONING_SUPPORTED_MODELS),
  ChatModels.GPT5_1_CHAT_LATEST,
  ChatModels.GPT5_2_CHAT_LATEST,
  ChatModels.GPT5_5,
]);

/**
 * Models that do not accept the temperature parameter at all.
 * The API will reject requests that include temperature for these models.
 */
export const NO_TEMPERATURE_MODELS: ReadonlySet<string> = new Set([
  // Opus 4.7+, Sonnet 5, and Fable 5 remove temperature/top_p/top_k (adaptive-thinking-only surface) - sending any returns 400
  ChatModels.CLAUDE_4_7_OPUS,
  ChatModels.CLAUDE_4_7_OPUS_BEDROCK,
  ChatModels.CLAUDE_4_8_OPUS,
  ChatModels.CLAUDE_4_8_OPUS_BEDROCK,
  ChatModels.CLAUDE_5_SONNET,
  ChatModels.CLAUDE_5_SONNET_BEDROCK,
  ChatModels.CLAUDE_FABLE_5,
]);

/**
 * Models whose safety classifiers can decline a request with `stop_reason: 'refusal'`
 * (HTTP 200, empty or partial content) - Claude Fable 5's GA classifiers target research
 * biology and most cybersecurity content and occasionally false-positive on benign adjacent
 * work. Per Anthropic's GA guidance a refusal from these is opt-in recoverable: rather than
 * surfacing a hard refusal, the backend throws so the completion loop's existing fallback
 * machinery continues the request on Opus 4.8. A refusal from any *other* model is a genuine
 * decline and surfaces unchanged. Keep in sync with the `claude-fable-5` fallback preference
 * chain in `adminSettings/fallback.ts`.
 */
export const REFUSAL_FALLBACK_MODELS: ReadonlySet<string> = new Set([ChatModels.CLAUDE_FABLE_5]);

/**
 * Bedrock-hosted Claude models that do NOT support prompt caching (`cache_control`).
 * Sending `cache_control` to these models triggers a Bedrock deserialization error:
 *   `tools.N.cache_control: Extra inputs are not permitted`
 *
 * AWS Bedrock added prompt caching for Claude 3.5 Haiku and Claude 3.7 Sonnet (and later);
 * the OG Claude 3 Haiku and the v1 Claude 3.5 Sonnet were not retrofitted.
 *
 * Keep this set narrow - default behavior is to apply caching when `cacheStrategy.enableCaching`
 * is true. Add a model here only when we have concrete evidence (a Bedrock validation error)
 * that it rejects `cache_control`.
 */
export const BEDROCK_NO_PROMPT_CACHING_MODELS: ReadonlySet<string> = new Set([
  ChatModels.CLAUDE_3_HAIKU_BEDROCK,
  ChatModels.CLAUDE_3_5_SONNET_BEDROCK,
]);

/**
 * Speech to Text Models
 *
 */

export enum SpeechToTextModels {
  WHISPER_1 = 'whisper-1',
  AWS_TRANSCRIBE = 'transcribe',
}

export const SPEECH_TO_TEXT_MODELS = Object.values(SpeechToTextModels);
export const supportedSpeechToTextModels = z.enum(SpeechToTextModels);
export type SpeechToTextModelName = z.infer<typeof supportedSpeechToTextModels>;

/**
 * Video Models
 */
export enum VideoModels {
  SORA_2 = 'sora-2',
  SORA_2_PRO = 'sora-2-pro',
}

export const VIDEO_MODELS = Object.values(VideoModels);
export const supportedVideoModels = z.enum(VideoModels);
export type VideoModelName = z.infer<typeof supportedVideoModels>;

/**
 * Video size constraints and options for Sora
 */
export const VIDEO_SIZE_CONSTRAINTS = {
  SORA: {
    durations: [4, 8, 12] as const,
    sizes: ['720x1280', '1280x720', '1024x1792', '1792x1024'] as const,
    defaultDuration: 4,
    defaultSize: '720x1280' as const,
  },
} as const;

export type SoraDuration = (typeof VIDEO_SIZE_CONSTRAINTS.SORA.durations)[number];
export type SoraVideoSize = (typeof VIDEO_SIZE_CONSTRAINTS.SORA.sizes)[number];

/**
 * All supported models
 */
export const supportedModels = z.enum({
  ...ChatModels,
  ...ImageModels,
  ...SpeechToTextModels,
  ...VideoModels,
});

export type ModelName = z.infer<typeof supportedModels>;

export type ModelInfo = {
  id: ModelName;
  type: 'text' | 'image' | 'speech-to-text' | 'video';
  name: string;
  backend: ModelBackend;
  private?: boolean;
  /**
   * The length of the context window.
   * This specifies the number of tokens or characters that the model
   * considers as context for generating the response.
   */
  contextWindow: number;
  /**
   * The maximum number of tokens.
   * This defines the highest number of tokens allowed in the
   * generated response.
   */
  max_tokens: number;
  can_stream?: boolean;
  /**
   * Whether the model supports the thinking feature.
   * This allows the model to perform extended reasoning before responding.
   */
  can_think?: boolean;
  /**
   * The thinking API style for this model. Only meaningful when can_think is true.
   * - 'legacy': Uses `thinking: { type: "enabled", budget_tokens }` (Claude 3.7 through 4.6)
   * - 'adaptive': Uses `thinking: { type: "adaptive" }` + `output_config: { effort }` (Claude 4.7+)
   * Defaults to 'legacy' if unset and can_think is true.
   */
  thinkingStyle?: 'legacy' | 'adaptive';
  pricing: Record<number, PricingInfo>;
  /**
   * Whether the model supports vision tasks.
   */
  supportsVision?: boolean;
  /**
   * Whether the model supports function calls and tools.
   */
  supportsTools?: boolean;
  /**
   * Whether the model accepts an image input alongside the text prompt
   * (image-to-image, image variation, or image-grounded editing).
   * False for text-to-image-only models.
   */
  supportsImageVariation: boolean;
  /**
   * Whether the model supports safety tolerance settings.
   * This is specific to BFL models.
   */
  supportsSafetyTolerance?: boolean;
  /**
   * The cutoff date for the model's training data.
   * This indicates when the model's knowledge stops.
   * Format: YYYY-MM-DD
   */
  trainingCutoff?: string;
  /**
   * Optional date when the model was released.
   * Helps the UI show the <NEW> badge for the model.
   * Format: YYYY-MM-DD
   */
  releaseDate?: string;
  /**
   * Optional date when the model is no longer available.
   * If present and today's date is on/after this date, the model should be hidden.
   * Format: YYYY-MM-DD
   */
  deprecationDate?: string;
  logoFile?: string;
  rank?: number;
  description?: string;
  isSlowModel?: boolean;
  /**
   * When true, the model is still listed in the picker but rendered as disabled and
   * non-selectable, and the server rejects completions to it. Use for a model that is
   * unavailable to this deployment (e.g. gated or retired upstream) but that we still
   * want users to see - so its absence is explained rather than silently hidden.
   * This is distinct from `deprecationDate`, which hides the model entirely.
   */
  disabled?: boolean;
  /** Human-readable reason surfaced in the picker (tooltip) and the server-side rejection when `disabled` is true. */
  disabledReason?: string;
};

// Pricing info type. Optional cache_read / cache_write override the defaults
// (0.1x input for read, 1.25x input for write) when a provider publishes
// non-standard rates.
type PricingInfo = {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
};

/** Anthropic-published default multipliers for prompt cache pricing. */
export const CACHE_READ_MULTIPLIER = 0.1; // 90% discount on cached tokens
export const CACHE_WRITE_MULTIPLIER = 1.25; // 25% surcharge per cached chunk

/**
 * Compute USD cost for a text model call.
 *
 * Cache token accounting: Anthropic returns
 * `cache_read_input_tokens` and `cache_creation_input_tokens` separately from
 * `input_tokens` (they're already excluded from the input total). When provided,
 * we apply 0.1x input rate to reads and 1.25x input rate to writes. Models can
 * publish explicit `cache_read` / `cache_write` rates in their pricing tier to
 * override the multipliers.
 */
export const getTextModelCost = (
  model: ModelInfo,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheCreationTokens: number = 0
): number => {
  const thresholds: number[] = Object.keys(model.pricing)
    .map(Number)
    .sort((a, b) => a - b);

  const tierForTokens = (tokens: number): number | null => {
    for (const threshold of thresholds) {
      if (tokens <= threshold) return threshold;
    }
    return thresholds.length > 0 ? thresholds[thresholds.length - 1] : null;
  };

  const tier = tierForTokens(inputTokens);
  if (tier === null) return 0;

  const tierPricing = model.pricing[tier];
  const cacheReadRate = tierPricing.cache_read ?? tierPricing.input * CACHE_READ_MULTIPLIER;
  const cacheWriteRate = tierPricing.cache_write ?? tierPricing.input * CACHE_WRITE_MULTIPLIER;

  return (
    tierPricing.input * inputTokens +
    tierPricing.output * outputTokens +
    cacheReadRate * cacheReadTokens +
    cacheWriteRate * cacheCreationTokens
  );
};

/** Returns true if the model is deprecated on or before the provided date (default: now). */
export const isModelDeprecated = (model: ModelInfo, now: Date = new Date()): boolean => {
  if (!model.deprecationDate) return false;
  const todayYMD = new Date(now.toISOString().slice(0, 10));
  const cutoff = new Date(model.deprecationDate + 'T00:00:00Z');
  return todayYMD.getTime() >= cutoff.getTime();
};
