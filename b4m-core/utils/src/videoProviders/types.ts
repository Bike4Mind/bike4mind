import type { ProviderJobHandle, ValidatedVideoRequest, VideoModelId, VideoProviderId } from '@bike4mind/common';
import type { AsyncGenerationProvider, ProviderContext } from '../generationProviders/types';

export * from '../generationProviders/types';
export type { ProviderJobHandle };

export type VideoProviderContext = ProviderContext;

export type VideoProvider = AsyncGenerationProvider<VideoProviderId, VideoModelId, ValidatedVideoRequest>;
