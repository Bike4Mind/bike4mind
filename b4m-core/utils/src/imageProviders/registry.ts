import { ALL_IMAGE_MODELS, IMAGE_MODEL_CATALOG, type ImageModels, type ImageProviderId } from '@bike4mind/common';
import { createGenerationProviderRegistry, type GenerationProviderRegistry } from '../generationProviders/registry';
import type { ImageProvider } from './types';

export type ImageProviderRegistry = GenerationProviderRegistry<ImageProviderId, ImageProvider>;

// ALL_IMAGE_MODELS, not every ImageModels member: the retired dall-e-2 is in the catalog but never served.
export const createImageProviderRegistry = (providers: readonly ImageProvider[]): ImageProviderRegistry =>
  createGenerationProviderRegistry<ImageProviderId, ImageModels, ImageProvider>(
    { label: 'image', modelIds: ALL_IMAGE_MODELS, providerOf: model => IMAGE_MODEL_CATALOG[model].provider },
    providers
  );
