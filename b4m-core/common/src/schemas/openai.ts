import { IMAGE_SIZE_CONSTRAINTS, ImageModels } from '../models';
import { z } from 'zod';
import { BFL_IMAGE_MODELS } from './bfl';
import { XAI_IMAGE_MODELS } from './xai';
import { GEMINI_IMAGE_MODELS } from './gemini';

export const ChatCompletionCreateInputSchema = z.object({
  // We are flexible about model name, since we'll validate it against the model info
  model: z.string(),
  imageModel: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  n: z.number().min(1).max(10).optional(),
  /**
   * Optional so "the caller expressed no output budget" stays distinguishable from
   * "the caller asked for exactly N". ChatCompletionProcess resolves the absent case
   * against the resolved model, which is the only layer that knows whether it reasons
   * inside the output budget (those need a larger default - see
   * reasonsWithinOutputBudget). A number here is treated as deliberate.
   */
  max_tokens: z.number().optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  logit_bias: z.record(z.string(), z.number()).nullable().optional(),
  stream: z.boolean().optional(),
  thinking: z
    .object({
      enabled: z.boolean(),
      budget_tokens: z.number().optional(),
    })
    .optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system', 'function', 'tool']),
        content: z.string(),
      })
    )
    .optional(),
});
export type ChatCompletionCreateInput = z.infer<typeof ChatCompletionCreateInputSchema>;

export const OPENAI_IMAGE_MODELS = [
  ImageModels.GPT_IMAGE_1,
  ImageModels.GPT_IMAGE_1_5,
  ImageModels.GPT_IMAGE_1_MINI,
  ImageModels.GPT_IMAGE_2,
] as const;
export const ALL_IMAGE_MODELS = [
  ...OPENAI_IMAGE_MODELS,
  ...BFL_IMAGE_MODELS,
  ...XAI_IMAGE_MODELS,
  ...GEMINI_IMAGE_MODELS,
] as const;

export const OPENAI_GPT_IMAGE_1_IMAGE_SIZES = IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_1.sizes;
/**
 * The UI presets plus 'auto', which the API accepts but is not a resolution, so it has no
 * place in the preset list the size picker renders.
 */
export const OPENAI_GPT_IMAGE_2_IMAGE_SIZES = [...IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.sizes, 'auto'] as const;
export const BFL_IMAGE_SIZES = ['1024x768'] as const;

export const OPENAI_IMAGE_SIZES = [...OPENAI_GPT_IMAGE_1_IMAGE_SIZES] as const;
export const ALL_IMAGE_SIZES = [...OPENAI_IMAGE_SIZES, ...OPENAI_GPT_IMAGE_2_IMAGE_SIZES, ...BFL_IMAGE_SIZES] as const;
export const OpenAIImageSizeSchema = z.enum(OPENAI_IMAGE_SIZES);
export const ImageSizeSchema = z.union([
  z.enum(ALL_IMAGE_SIZES),
  z.string().regex(/^\d+x\d+$/, {
    error: "Size must be in format 'widthxheight'",
  }),
]);
export type OpenAIImageSize = z.infer<typeof OpenAIImageSizeSchema> | string;
export type ImageSizeFromSchema = z.infer<typeof ImageSizeSchema>;

// 'auto' is accepted but priced at the GPT-Image CEILING tier (the same as an explicit 'high'),
// because OpenAI chooses the render effort per request and image credits are held once, before
// the call, with no reconciliation afterwards. On gpt-image-2 @1024x1024 that is $0.211 rather
// than the $0.053 a mid-tier request costs. Pass an explicit tier to pay for that tier.
export const OPENAI_IMAGE_QUALITIES = ['standard', 'hd', 'low', 'medium', 'high', 'auto'] as const;
export const OpenAIImageQualitySchema = z.enum(OPENAI_IMAGE_QUALITIES);
export type OpenAIImageQuality = z.infer<typeof OpenAIImageQualitySchema>;

/**
 * The tiers offered to the LLM in the image_generation tool schema: every accepted quality
 * except 'auto', whose price the model cannot reason about (see the note above). Omitting the
 * field is how a tool call defers to the user's saved preference, at that preference's price.
 *
 * Deliberately narrower than OPENAI_IMAGE_QUALITIES, which stays the API contract - an existing
 * caller sending 'auto' keeps working, it is simply priced honestly.
 */
export const TOOL_SELECTABLE_IMAGE_QUALITIES: readonly Exclude<OpenAIImageQuality, 'auto'>[] =
  OPENAI_IMAGE_QUALITIES.filter((quality): quality is Exclude<OpenAIImageQuality, 'auto'> => quality !== 'auto');

export const OPENAI_IMAGE_STYLES = ['vivid', 'natural'] as const;
export const OpenAIImageStyleSchema = z.enum(OPENAI_IMAGE_STYLES);
export type OpenAIImageStyle = z.infer<typeof OpenAIImageStyleSchema>;

/**
 * Alpha handling for gpt-image renders. `transparent` only yields real alpha when the
 * output format also carries an alpha channel (png or webp) - OpenAI rejects it alongside
 * jpeg. Ignored by every other provider (see OpenAIImageService.generate).
 */
export const OpenAIImageBackgroundSchema = z.enum(['transparent', 'opaque', 'auto']);
export type OpenAIImageBackground = z.infer<typeof OpenAIImageBackgroundSchema>;

/** Container for a generated image. `webp` is gpt-image only; BFL and Gemini take png/jpeg. */
export const ImageOutputFormatSchema = z.enum(['png', 'jpeg', 'webp']);
export type ImageOutputFormat = z.infer<typeof ImageOutputFormatSchema>;

/**
 * Degrade a shared output-format setting to what BFL and Gemini accept, so selecting
 * webp for gpt-image cannot fail an unrelated render after a model switch.
 */
export function toNonWebpOutputFormat(format?: ImageOutputFormat | null): 'png' | 'jpeg' | null | undefined {
  return format === 'webp' ? 'png' : format;
}

/**
 * Maps legacy/removed image model IDs to their current replacements.
 * Prevents Zod validation failures when clients send stale persisted model names.
 *
 * Values are constrained to `ALL_IMAGE_MODELS` so a remap target can never point at
 * a model that the schema would itself reject. If a target model is later retired,
 * re-point its entry to the current replacement rather than deleting it - clients may
 * still hold the legacy key in persisted state. When adding an entry, bump the
 * `llm-settings` persist `version` in LLMContext so existing clients re-run the remap.
 *
 * Only `flux-dev` is aliased among the recently removed Flux ids. It was a general
 * text-to-image model with a confirmed stale client, so remapping to the
 * current BFL standard is safe and faithful. `flux-pro-1.0-canny` and
 * `flux-pro-1.0-depth` are intentionally left as hard validation errors: they were
 * never UI-selectable (nothing persists them, and no alerts show callers sending them)
 * and they are structural-control models - silently remapping them to a plain
 * text-to-image model would drop the control image and return the wrong kind of result,
 * so a clear "unsupported model" error is the more honest response.
 *
 * The three `grok-2-image*` ids are the prior xAI image-model ids, all superseded
 * in the enum by `grok-imagine-image-quality`. The id went through an un-aliased
 * rename chain - `grok-2-image-1212` (original) -> `grok-2-image` -> `grok-2-image-gen`
 * -> `grok-imagine-image-quality` - so any of the three could survive in stale
 * persisted client state (`grok-2-image-1212` was the one actually observed). All are
 * xAI text-to-image models, so remapping to the current id is a faithful
 * same-provider, same-modality replacement.
 */
export const LEGACY_IMAGE_MODEL_MAP: Record<string, (typeof ALL_IMAGE_MODELS)[number]> = {
  'dall-e-3': ImageModels.GPT_IMAGE_2,
  'dall-e-2': ImageModels.GPT_IMAGE_2,
  'flux-dev': ImageModels.FLUX_PRO_1_1, // removed model -> live BFL standard
  'grok-2-image-1212': ImageModels.GROK_IMAGINE_IMAGE_QUALITY, // original xAI image id -> current id
  'grok-2-image': ImageModels.GROK_IMAGINE_IMAGE_QUALITY, // intermediate xAI image id -> current id
  'grok-2-image-gen': ImageModels.GROK_IMAGINE_IMAGE_QUALITY, // intermediate xAI image id -> current id
};

export const OpenAIImageGenerationInput = z.object({
  prompt: z.string(),
  model: z.preprocess(
    val =>
      typeof val === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_IMAGE_MODEL_MAP, val)
        ? LEGACY_IMAGE_MODEL_MAP[val]
        : val,
    // Self-hosted image models are namespaced `local-image/<checkpoint>` and are
    // not part of the static enum (the checkpoint set is discovered at runtime
    // from the local backend), so accept them via a pattern - same approach as
    // ImageSizeSchema above. The suffix allows spaces and forward slashes because
    // A1111/SD.Next checkpoint names can contain both (e.g. "Deliberate v2",
    // "anime/foo.safetensors"); the `local-image/` prefix stays anchored. The
    // leading (?=.*\S) lookahead requires at least one non-whitespace character
    // so an all-blank suffix (e.g. "local-image/   ") is rejected.
    z.union([z.enum(ALL_IMAGE_MODELS), z.string().regex(/^local-image\/(?=.*\S)[\w.:/ -]+$/)])
  ),
  n: z.number().min(1).max(10).optional(),
  // 'auto' is valid here and bills at the ceiling tier - see OPENAI_IMAGE_QUALITIES.
  quality: OpenAIImageQualitySchema.optional(),
  response_format: z.enum(['b64_json', 'url']).optional(),
  size: ImageSizeSchema.nullable().optional(),
  style: OpenAIImageStyleSchema.optional(),
  background: OpenAIImageBackgroundSchema.nullable().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  aspect_ratio: z.string().optional(),
});
