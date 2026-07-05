import { ImageModels } from '../models';

/**
 * XAI/Grok Image Models
 * Based on https://docs.x.ai/docs/guides/image-generations
 */
export const XAI_IMAGE_MODELS = [ImageModels.GROK_IMAGINE_IMAGE_QUALITY] as const;

export type XAIImageModel = (typeof XAI_IMAGE_MODELS)[number];
