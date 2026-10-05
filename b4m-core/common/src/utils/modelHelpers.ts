import { IMAGE_MODELS, ImageModels, VIDEO_MODELS, VideoModels } from '../models';
import { EXTENDED_GPT_IMAGE_QUALITIES, OPENAI_IMAGE_MODELS, type ExtendedGptImageQuality } from '../schemas/openai';
import { GEMINI_IMAGE_MODELS, type GeminiImageModel } from '../schemas/gemini';
import { BFL_IMAGE_MODELS, type BFLImageModel } from '../schemas/bfl';
import { normalizeEntitlementKey } from '../constants/dataLakes';
import type { LLMModelConfig } from '../types/entities/LLMTypes';

export const isImageModel = (model: string): model is ImageModels => {
  return IMAGE_MODELS.includes(model as ImageModels);
};

export const isVideoModel = (model: string): model is VideoModels => {
  return VIDEO_MODELS.includes(model as VideoModels);
};

type GptImageModelId = (typeof OPENAI_IMAGE_MODELS)[number];

/** Returns true for GPT Image models, including versioned IDs (e.g. gpt-image-1.5-2025-12-16, gpt-image-2-2026-04-21). */
export function isGPTImageModel(model: string): model is GptImageModelId;
export function isGPTImageModel(model?: string | null): boolean;
export function isGPTImageModel(model?: string | null): boolean {
  if (!model) return false;
  return (OPENAI_IMAGE_MODELS as readonly string[]).includes(model) || model.startsWith('gpt-image-');
}

/** Returns true for Gemini image models (Nano Banana family); derives from GEMINI_IMAGE_MODELS so it never drifts. */
export function isGeminiImageModel(model: string): model is GeminiImageModel;
export function isGeminiImageModel(model?: string | null): boolean;
export function isGeminiImageModel(model?: string | null): boolean {
  if (!model) return false;
  return (GEMINI_IMAGE_MODELS as readonly string[]).includes(model);
}

/** Returns true for Black Forest Labs image models; derives from BFL_IMAGE_MODELS so it never drifts. */
export function isBflImageModel(model: string): model is BFLImageModel;
export function isBflImageModel(model?: string | null): boolean;
export function isBflImageModel(model?: string | null): boolean {
  if (!model) return false;
  return (BFL_IMAGE_MODELS as readonly string[]).includes(model);
}

/**
 * Flux Ultra is the only BFL generation model driven by `aspect_ratio`; the Pro family takes
 * discrete `width`/`height` and ignores aspect_ratio outright. Must stay in sync with the branch
 * in `BFLImageService.generate`, which is what actually builds the request body.
 */
export function isBflUltraImageModel(model?: string | null): boolean {
  return model === ImageModels.FLUX_PRO_ULTRA;
}

/**
 * Image models sized by discrete `width`/`height` rather than a size string or an aspect ratio.
 * Deliberately just the Flux Pro generation pair: Ultra takes an aspect ratio, and Fill and
 * Kontext are dispatched through the edit path, which reads neither. The settings UI and the
 * generation dispatch both key off this, so they cannot disagree about which controls matter.
 */
export function usesDiscreteImageDimensions(model?: string | null): boolean {
  return model === ImageModels.FLUX_PRO || model === ImageModels.FLUX_PRO_1_1;
}

/**
 * Image models offering a prompt-enhancement toggle in the UI, where the provider is meant to
 * rewrite and expand the prompt before generating. BFL takes it as `prompt_upsampling` and honors
 * it. Gemini models are still included here for historical/UI-grouping reasons, but
 * GeminiImageService.buildGenerationConfig() deliberately never forwards this to Google's API -
 * `generateImages` rejects the mere presence of `enhancePrompt`, so the toggle is a no-op for
 * Gemini today. Do not reintroduce a Gemini enhancePrompt mapping without confirming Google's API
 * accepts it. OpenAI discards the parameter, so GPT-Image and DALL-E are excluded.
 *
 * One predicate on purpose: the settings UI, the reset defaults and the image-template snapshot all
 * have to agree about this field, and they previously did so through three separate BFL checks.
 */
export function supportsPromptUpsampling(model?: string | null): boolean {
  return isBflImageModel(model) || isGeminiImageModel(model);
}

/**
 * Returns true for the gpt-image-2 family: gpt-image-2, its versioned snapshots (gpt-image-2-2026-04-21)
 * and the gpt-image-2.5 models, which share gpt-image-2's flexible size rules (utils/imageSizes.ts).
 * Where 2.5 differs from 2 - transparency, quality tiers, price - use the narrower predicates below.
 */
export function isGPTImage2Model(model?: string | null): boolean {
  if (!model) return false;
  return model === ImageModels.GPT_IMAGE_2 || model.startsWith('gpt-image-2');
}

/** Returns true for gpt-image-2.5-sunburst / -flare, including their dated snapshots. */
export function isGPTImage25Model(model?: string | null): boolean {
  if (!model) return false;
  return model.startsWith('gpt-image-2.5-');
}

/**
 * gpt-image-2 rejects background: 'transparent'; the 2.5 models accept it. Callers step a
 * transparent request on such a model down to gpt-image-1.5 (ImageGeneration, ImageEdit, the
 * image tools) or drop the field (OpenAIImageService).
 */
export function rejectsTransparentBackground(model?: string | null): boolean {
  return isGPTImage2Model(model) && !isGPTImage25Model(model);
}

/**
 * True for models that render a real alpha channel for background: 'transparent' (gpt-image-1.x
 * and the 2.5 models). Every other provider ignores the field and returns an opaque image.
 */
export function supportsTransparentBackground(model?: string | null): boolean {
  return isGPTImageModel(model) && !rejectsTransparentBackground(model);
}

export const isExtendedGptImageQuality = (quality: unknown): quality is ExtendedGptImageQuality =>
  (EXTENDED_GPT_IMAGE_QUALITIES as readonly unknown[]).includes(quality);

/**
 * Steps 'xhigh'/'max' down to 'high' for a model that does not offer them, so every model renders
 * and bills a tier it accepts. The single rule shared by OpenAIImageService (what is sent) and
 * OpenAIImageCostCalculator (what is charged) - if they applied it differently, a user would be
 * charged one tier and rendered another.
 */
export function clampImageQualityForModel<Quality extends string | null | undefined>(
  model: string | null | undefined,
  quality: Quality
): Quality | 'high' {
  return isExtendedGptImageQuality(quality) && !isGPTImage25Model(model) ? 'high' : quality;
}

/**
 * Flux Kontext models - image-to-image *transformation* models dispatched through
 * the Kontext `transform` path. This is deliberately narrower than
 * `REQUIRES_IMAGE_INPUT_MODELS`: "is Kontext" selects a specific dispatch branch,
 * so Fill (which also requires an input image but is an inpainting model routed
 * through ImageEdit, not a Kontext transform) must NOT be included here.
 */
const KONTEXT_MODELS = new Set<string>([ImageModels.FLUX_KONTEXT_PRO, ImageModels.FLUX_KONTEXT_MAX]);

/** Returns true for Flux Kontext transformation models; gates the Kontext transform dispatch. */
export function isKontextModel(model: string): model is ImageModels.FLUX_KONTEXT_PRO | ImageModels.FLUX_KONTEXT_MAX;
export function isKontextModel(model?: string | null): boolean;
export function isKontextModel(model?: string | null): boolean {
  if (!model) return false;
  return KONTEXT_MODELS.has(model);
}

/**
 * Image models that REQUIRE an input image (text-to-image only is not supported):
 * Flux Kontext (image-to-image transform) and Flux Pro Fill (inpainting - needs a
 * base image + mask).
 *
 * Broader than `isKontextModel` (Fill requires an image but is dispatched through a
 * different path), and orthogonal to `ModelInfo.supportsImageVariation`, which marks
 * models that *optionally* accept an image: Kontext sets it, but Fill does NOT despite
 * mandating an input image. Do NOT use this set to detect the Kontext transform branch -
 * use `isKontextModel` for that, or Fill will be misrouted through Kontext's transform.
 */
const REQUIRES_IMAGE_INPUT_MODELS: ReadonlySet<string> = new Set([
  ImageModels.FLUX_KONTEXT_PRO,
  ImageModels.FLUX_KONTEXT_MAX,
  ImageModels.FLUX_PRO_FILL,
]);

/** Returns true for image models that mandate an input image (Flux Kontext transforms and Fill inpainting). */
export function requiresImageInput(model?: string | null): boolean {
  if (!model) return false;
  return REQUIRES_IMAGE_INPUT_MODELS.has(model);
}

/**
 * Whether a user can access a model. Access is any-of (mirrors the Q3b data-lake
 * rule, `getAccessibleDataLakes`): a non-admin reaches the model via
 * `allowedUserTags ∩ userTags` OR `allowedEntitlements ∩ entitlementKeys`.
 *
 * `entitlementKeys` is optional - when omitted/empty the entitlement branch is
 * inert, so a model with no `allowedEntitlements` behaves exactly as before
 * (tag-only). This lets a tag-less subscriber reach an entitlement-gated model
 * while leaving every existing tag-gated model unchanged (zero regression).
 *
 * Pure + zero-dependency (only types + the shared key normalizer), so it lives
 * in `@bike4mind/common` as the SINGLE source of truth - imported by the core
 * `@bike4mind/utils` re-export (server/services) AND the client
 * `useAccessibleModels` hook, which previously kept a hand-rolled twin "to avoid
 * AWS SDK imports". Common is browser-safe, so there is no longer any reason to
 * duplicate the logic.
 */
export function isModelAccessible(
  model: LLMModelConfig,
  userTags: string[],
  isAdmin: boolean = false,
  entitlementKeys: string[] = []
): boolean {
  if (!model.enabled) return false;
  // Admins have access to all enabled models
  if (isAdmin) return true;

  const normalizedUserTags = userTags.map(tag => tag.toLowerCase());
  const normalizedAllowedTags = (model.allowedUserTags ?? []).map(tag => tag.toLowerCase());
  if (normalizedUserTags.some(tag => normalizedAllowedTags.includes(tag))) return true;

  // Shared normalizer (trim + lowercase) - keeps entitlement matching consistent
  // with the data-lake rule and the registry, robust to stray whitespace.
  const normalizedKeys = entitlementKeys.map(normalizeEntitlementKey);
  const normalizedAllowedEntitlements = (model.allowedEntitlements ?? []).map(normalizeEntitlementKey);
  return normalizedAllowedEntitlements.length === 0 || normalizedKeys.some(key => normalizedAllowedEntitlements.includes(key));
}

/**
 * Image models that can serve an *edit* (image + optional mask) request. Deliberately
 * narrower than the generation catalog: of the BFL family only Fill does mask inpainting
 * (Kontext models are image-to-image transforms dispatched through ImageGeneration's
 * transform path, not edit), and XAI exposes no edit endpoint at all.
 *
 * Must stay the single source of truth for both edit dispatchers - the image-edit queue
 * handler (services/llm/ImageEdit.ts) and the chat edit_image tool - so neither silently
 * substitutes a model the user did not pick and was not billed for.
 */
export const EDIT_SUPPORTED_IMAGE_MODELS = [
  ...OPENAI_IMAGE_MODELS,
  ImageModels.FLUX_PRO_FILL,
  ...GEMINI_IMAGE_MODELS,
] as const;

/** Returns true for image models that support editing; gates both edit dispatch paths. */
export function supportsImageEdit(model?: string | null): boolean {
  if (!model) return false;
  return (EDIT_SUPPORTED_IMAGE_MODELS as readonly string[]).includes(model);
}

/**
 * Images an edit request renders, whatever `n` it asks for. Every provider's `edit()`
 * resolves to a single-image ImageEditResponse, so on the edit path `n` is not a billable
 * multiplier the way it is for generation.
 *
 * Both edit dispatchers bill through this so the charge equals what is delivered: the
 * image-edit queue handler (services/llm/ImageEdit.ts) and the chat edit_image tool, whose
 * onToolStart payload feeds both the classic (ToolBuilder.reserveImageCredits) and agent-mode
 * (estimateGeneratedMediaUsd) credit rails. Raise it only together with ImageEditResponse itself -
 * billing more than one image before the response can carry more re-opens the overcharge.
 */
export const IMAGES_PER_EDIT_REQUEST = 1;

/**
 * Reference ("style anchor") images a single gpt-image request may carry, on top of the
 * primary input image. OpenAI's images.edit accepts up to 16 for the gpt-image family, but
 * the cap here is deliberately lower: OpenAIImageCostCalculator prices output only (tier x
 * size) and image credits are never reconciled after the call, so every input image OpenAI
 * bills as input tokens is unbilled margin. At 4 that leak is a rounding error; at 16 it is
 * roughly a free high-tier render per request. Raise it only together with an input-image
 * term in OpenAIImageCostCalculator.
 */
export const MAX_REFERENCE_IMAGES = 4;
