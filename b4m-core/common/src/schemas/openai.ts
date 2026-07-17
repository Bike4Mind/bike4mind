import { ImageModels } from '../models';
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
  max_tokens: z.number(),
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

export const OPENAI_GPT_IMAGE_1_IMAGE_SIZES = ['1024x1024', '1024x1536', '1536x1024'] as const;
export const OPENAI_GPT_IMAGE_2_IMAGE_SIZES = [
  '1024x1024',
  '1536x1024',
  '1024x1536',
  '2048x2048',
  '2048x1152',
  '3840x2160',
  '2160x3840',
  'auto',
] as const;
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

export const OPENAI_IMAGE_QUALITIES = ['standard', 'hd', 'low', 'medium', 'high', 'auto'] as const;
export const OpenAIImageQualitySchema = z.enum(OPENAI_IMAGE_QUALITIES);
export type OpenAIImageQuality = z.infer<typeof OpenAIImageQualitySchema>;

export const OPENAI_IMAGE_STYLES = ['vivid', 'natural'] as const;
export const OpenAIImageStyleSchema = z.enum(OPENAI_IMAGE_STYLES);
export type OpenAIImageStyle = z.infer<typeof OpenAIImageStyleSchema>;

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
  'dall-e-3': ImageModels.GPT_IMAGE_1,
  'dall-e-2': ImageModels.GPT_IMAGE_1,
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
    // ImageSizeSchema above.
    z.union([z.enum(ALL_IMAGE_MODELS), z.string().regex(/^local-image\/[\w.:-]+$/)])
  ),
  n: z.number().min(1).max(10).optional(),
  quality: OpenAIImageQualitySchema.optional(),
  response_format: z.enum(['b64_json', 'url']).optional(),
  size: ImageSizeSchema.nullable().optional(),
  style: OpenAIImageStyleSchema.optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  aspect_ratio: z.string().optional(),
});
