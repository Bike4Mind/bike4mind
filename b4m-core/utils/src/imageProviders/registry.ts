import {
  ALL_IMAGE_MODELS,
  TEST_IMAGE_MODEL,
  getImageModelCatalogEntry,
  type ImageJobModelId,
  type ImageProviderId,
} from '@bike4mind/common';
import { createGenerationProviderRegistry, type GenerationProviderRegistry } from '../generationProviders/registry';
import type { ImageProvider } from './types';

export type ImageProviderRegistry = GenerationProviderRegistry<ImageProviderId, ImageProvider>;

// ALL_IMAGE_MODELS, not every ImageModels member: the retired dall-e-2 is in the catalog but never served. Local
// checkpoints are discovered at runtime, so no static id names them and the local provider lists none.
const STATIC_IMAGE_JOB_MODELS: readonly ImageJobModelId[] = [...ALL_IMAGE_MODELS, TEST_IMAGE_MODEL];

export const createImageProviderRegistry = (providers: readonly ImageProvider[]): ImageProviderRegistry =>
  createGenerationProviderRegistry<ImageProviderId, ImageJobModelId, ImageProvider>(
    {
      label: 'image',
      modelIds: STATIC_IMAGE_JOB_MODELS,
      providerOf: model => getImageModelCatalogEntry(model).provider,
    },
    providers
  );
