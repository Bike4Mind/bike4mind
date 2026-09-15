import { ImageModels, BFL_IMAGE_MODELS, ALL_IMAGE_MODELS, type GenerateImageToolCall } from '@bike4mind/common';

type SupportedImageModel = (typeof ALL_IMAGE_MODELS)[number];

/**
 * Get default image generation config for a given model.
 * Used when triggering image generation from Slack (model picker or inline override).
 */
export function getImageConfigForModel(model: ImageModels): GenerateImageToolCall {
  const base: GenerateImageToolCall = { model: model as SupportedImageModel, n: 1 };

  // BFL models (Flux Pro, Flux Ultra, etc.)
  if ((BFL_IMAGE_MODELS as readonly string[]).includes(model)) {
    if (model === ImageModels.FLUX_PRO_ULTRA) {
      return { ...base, aspect_ratio: '16:9', output_format: 'png' };
    }
    return { ...base, width: 1024, height: 768, output_format: 'png' };
  }

  // OpenAI, XAI, Gemini
  return { ...base, quality: 'standard', size: '1024x1024' };
}
