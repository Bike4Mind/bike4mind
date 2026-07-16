import { z } from 'zod';
import {
  ALL_IMAGE_MODELS,
  ImageSizeSchema,
  LEGACY_IMAGE_MODEL_MAP,
  OpenAIImageQualitySchema,
  OpenAIImageStyleSchema,
} from './openai';

// Image-generation template validation (Milestone 1).
//
// A template is a userId-scoped, reusable snapshot of the image-mode settings,
// bound to exactly one model. Compatibility is EXACT-MODEL: a template only
// applies under the model it was authored with, so its `settings` are valid for
// that model by construction (no cross-model field reconciliation in M1).
//
// Storage-layer floor is Zod (min/max/shape) + plain-text fields rendered as
// text - matching the Briefcase reference, which does not HTML-sanitize its
// short text fields.

export const IMAGE_TEMPLATE_NAME_MAX = 100;
export const IMAGE_TEMPLATE_DESCRIPTION_MAX = 500;
export const IMAGE_TEMPLATE_CATEGORY_MAX = 50;

/** Hard per-user ceiling on stored templates, enforced server-side. */
export const IMAGE_TEMPLATES_PER_USER_MAX = 50;

/** Result cap for the (paginated) list endpoint. */
export const IMAGE_TEMPLATE_LIST_LIMIT = 50;

/** A 24-char hex Mongo ObjectId string (for get / update / delete / apply). */
export const ImageTemplateIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid template id');

/**
 * The bound model. Reuses the legacy-remap preprocess so a template saved under
 * a since-renamed model id resolves to its current id rather than failing.
 */
export const ImageTemplateModelSchema = z.preprocess(
  val =>
    typeof val === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_IMAGE_MODEL_MAP, val)
      ? LEGACY_IMAGE_MODEL_MAP[val]
      : val,
  z.enum(ALL_IMAGE_MODELS)
);

/**
 * The settings blob - the image-mode controls captured from LLMContext, minus
 * `model` (stored top-level on the template) and `prompt`. All fields optional;
 * which ones are meaningful is model-dependent and enforced at generation time.
 *
 * SNAPSHOTTED from `apps/client/app/contexts/LLMContext.tsx` at implementation
 * time - when a new image-mode setting is added there, add it here too. Unknown
 * keys are stripped on parse (forward-safe, but the new field won't persist
 * until declared).
 */
export const ImageTemplateSettingsSchema = z.object({
  size: ImageSizeSchema.nullable().optional(),
  quality: OpenAIImageQualitySchema.optional(),
  style: OpenAIImageStyleSchema.optional(),
  seed: z.number().int().nullable().optional(),
  n: z.number().int().min(1).max(10).optional(),
  width: z.number().int().min(256).max(4096).optional(),
  height: z.number().int().min(256).max(4096).optional(),
  aspect_ratio: z.string().max(16).optional(),
  output_format: z.enum(['jpeg', 'png']).optional(),
  safety_tolerance: z.number().min(0).max(6).optional(),
  prompt_upsampling: z.boolean().optional(),
});
export type ImageTemplateSettingsType = z.infer<typeof ImageTemplateSettingsSchema>;

/**
 * Input for creating a template. `userId` is intentionally NOT accepted from the
 * body - the service binds ownership to the authenticated caller. `usageCount`
 * is server-managed (incremented on apply), never client-set.
 */
export const ImageGenerationTemplateInput = z.object({
  name: z.string().min(1).max(IMAGE_TEMPLATE_NAME_MAX),
  description: z.string().max(IMAGE_TEMPLATE_DESCRIPTION_MAX).optional(),
  category: z.string().max(IMAGE_TEMPLATE_CATEGORY_MAX).optional(),
  model: ImageTemplateModelSchema,
  settings: ImageTemplateSettingsSchema,
});
export type ImageGenerationTemplateInputType = z.infer<typeof ImageGenerationTemplateInput>;

/**
 * Partial update of an owned template. `model` is intentionally omitted - the
 * bound model is immutable (exact-model), so settings can't drift out of sync
 * with it. To retarget a template to a different model, save a new one.
 */
export const ImageGenerationTemplateUpdateInput = ImageGenerationTemplateInput.omit({ model: true }).partial();
export type ImageGenerationTemplateUpdateInputType = z.infer<typeof ImageGenerationTemplateUpdateInput>;
