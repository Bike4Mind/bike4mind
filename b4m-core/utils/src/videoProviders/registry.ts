import { VIDEO_MODEL_CATALOG, VIDEO_MODEL_IDS, type VideoModelId, type VideoProviderId } from '@bike4mind/common';
import { createGenerationProviderRegistry, type GenerationProviderRegistry } from '../generationProviders/registry';
import type { VideoProvider } from './types';

export type VideoProviderRegistry = GenerationProviderRegistry<VideoProviderId, VideoProvider>;

export const createVideoProviderRegistry = (providers: readonly VideoProvider[]): VideoProviderRegistry =>
  createGenerationProviderRegistry<VideoProviderId, VideoModelId, VideoProvider>(
    { label: 'video', modelIds: VIDEO_MODEL_IDS, providerOf: model => VIDEO_MODEL_CATALOG[model].provider },
    providers
  );
