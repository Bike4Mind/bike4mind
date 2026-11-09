import type { ImageInputRole, ImageModels, ImageProviderId, StoredImageRequest } from '@bike4mind/common';
import type { ResolvedInputImage, ResolvedInputs, SyncGenerationProvider } from '../generationProviders/types';

export * from '../generationProviders/types';

export type ImageInputs = ResolvedInputs<ImageInputRole>;
export type ResolvedImageInput = ResolvedInputImage<ImageInputRole>;

// Every image provider answers in one call, so there is no async variant.
export type ImageProvider = SyncGenerationProvider<ImageProviderId, ImageModels, StoredImageRequest, ImageInputRole>;
