import { IMAGE_MODELS, ImageModels, VIDEO_MODELS, VideoModels } from '../models';
import { OPENAI_IMAGE_MODELS } from '../schemas/openai';
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

type GptImageModelId =
  ImageModels.GPT_IMAGE_1 | ImageModels.GPT_IMAGE_1_5 | ImageModels.GPT_IMAGE_1_MINI | ImageModels.GPT_IMAGE_2;

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

/** Returns true for BlackForest Labs image models; derives from BFL_IMAGE_MODELS so it never drifts. */
export function isBflImageModel(model: string): model is BFLImageModel;
export function isBflImageModel(model?: string | null): boolean;
export function isBflImageModel(model?: string | null): boolean {
  if (!model) return false;
  return (BFL_IMAGE_MODELS as readonly string[]).includes(model);
}

/** Returns true specifically for gpt-image-2 (including versioned snapshots like gpt-image-2-2026-04-21). */
export function isGPTImage2Model(model?: string | null): boolean {
  if (!model) return false;
  return model === ImageModels.GPT_IMAGE_2 || model.startsWith('gpt-image-2');
}

/**
 * Image models that REQUIRE an input image (text-to-image only is not supported).
 * Currently only Flux Kontext models - they exclusively perform image-to-image transformations.
 *
 * Note: this is distinct from `ModelInfo.supportsImageVariation`, which marks models that
 * *accept* an image input (optional). All `requiresImageInput` models also support it.
 */
const REQUIRES_IMAGE_INPUT_MODELS: ReadonlySet<string> = new Set([
  ImageModels.FLUX_KONTEXT_PRO,
  ImageModels.FLUX_KONTEXT_MAX,
]);

/** Returns true for image models that mandate an input image (e.g. Flux Kontext transformations). */
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
  return normalizedKeys.some(key => normalizedAllowedEntitlements.includes(key));
}
