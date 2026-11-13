import { ImageModels } from '../models';
import type { ModelProfile } from '../generation/types';
import { IMAGE_MODEL_CATALOG } from './catalog';
import type { ImageProviderId } from './types';

/**
 * How Studio introduces each image model on its model card: a one-line strength. Kept beside the capability catalog
 * so a model added to ImageModels fails to compile until it has one. Prices are not here: cards read them from the
 * same cost tables the credit hold uses (@bike4mind/services/imageCost), so the two cannot drift.
 */
export const IMAGE_MODEL_STRENGTHS: Record<ImageModels, string> = {
  [ImageModels.GPT_IMAGE_1]: 'Reliable prompt following with legible text in the image.',
  [ImageModels.GPT_IMAGE_1_5]: 'Sharper detail and text than gpt-image-1, at a lower price.',
  [ImageModels.GPT_IMAGE_1_MINI]: 'The cheapest OpenAI option for quick drafts.',
  [ImageModels.GPT_IMAGE_2]: 'Flexible sizes and strong layout for posters and diagrams.',
  [ImageModels.GPT_IMAGE_2_5_SUNBURST]: 'Extra quality tiers up to max for finished artwork.',
  [ImageModels.GPT_IMAGE_2_5_FLARE]: 'Extra quality tiers up to max, tuned for vivid styles.',
  [ImageModels.DALL_E_2]: 'Legacy model kept for older workflows.',
  [ImageModels.FLUX_PRO]: 'Photoreal images with fine texture.',
  [ImageModels.FLUX_PRO_1_1]: 'Fast photoreal images with fine texture.',
  [ImageModels.FLUX_PRO_ULTRA]: 'High-resolution photoreal images in any aspect ratio.',
  [ImageModels.FLUX_PRO_FILL]: 'Fills a masked area of an existing image.',
  [ImageModels.FLUX_KONTEXT_PRO]: 'Edits an image from instructions while keeping its subject.',
  [ImageModels.FLUX_KONTEXT_MAX]: 'The strongest FLUX instruction edits, with better text.',
  [ImageModels.FLUX_2_MAX]: 'Top FLUX 2 quality with multi-reference control.',
  [ImageModels.FLUX_2_PRO]: 'Balanced FLUX 2 quality and speed with references.',
  [ImageModels.FLUX_2_PRO_PREVIEW]: 'Preview build of FLUX 2 Pro.',
  [ImageModels.FLUX_2_FLEX]: 'FLUX 2 tuned for typography and fine detail.',
  [ImageModels.FLUX_2_KLEIN_9B]: 'Small, fast FLUX 2 for quick iterations.',
  [ImageModels.FLUX_2_KLEIN_9B_PREVIEW]: 'Preview build of FLUX 2 Klein 9B.',
  [ImageModels.FLUX_2_KLEIN_4B]: 'The fastest, cheapest FLUX 2.',
  [ImageModels.FLUX_3_IMAGE]: 'The newest FLUX generation for detailed scenes.',
  [ImageModels.FLUX_3_IMAGE_KLEIN]: 'A fast, low-cost FLUX 3.',
  [ImageModels.GROK_IMAGINE_IMAGE_QUALITY]: 'Bold, stylised images from xAI.',
  [ImageModels.GEMINI_2_5_FLASH_IMAGE]: 'Quick conversational edits and blends.',
  [ImageModels.GEMINI_3_PRO_IMAGE_PREVIEW]: 'Preview build of Gemini 3 Pro Image.',
  [ImageModels.GEMINI_3_1_FLASH_IMAGE]: 'Fast, low-cost images with good text rendering.',
  [ImageModels.GEMINI_3_PRO_IMAGE]: 'Studio-grade detail, text and multi-image composition.',
};

export const IMAGE_PROVIDER_LABELS: Record<ImageProviderId, string> = {
  openai: 'OpenAI',
  bfl: 'Black Forest Labs',
  xai: 'xAI',
  gemini: 'Google',
  test: 'Test (non-production)',
  local: 'Local',
};

const hasImageProfile = (modelId: string): modelId is ImageModels => Object.hasOwn(IMAGE_MODEL_STRENGTHS, modelId);

/** The card copy for a catalog image model, or null for any other id (text models, retired ids). */
export const imageModelProfile = (modelId: string): ModelProfile | null =>
  hasImageProfile(modelId)
    ? {
        blurb: IMAGE_MODEL_STRENGTHS[modelId],
        providerLabel: IMAGE_PROVIDER_LABELS[IMAGE_MODEL_CATALOG[modelId].provider],
      }
    : null;
