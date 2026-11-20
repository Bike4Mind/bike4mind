import type { ImageInputRole, ImageJobModelId, ImageProviderId, StoredImageRequest } from '@bike4mind/common';
import type {
  AsyncGenerationProvider,
  ResolvedInputImage,
  ResolvedInputs,
  SyncGenerationProvider,
} from '../generationProviders/types';

export * from '../generationProviders/types';

export type ImageInputs = ResolvedInputs<ImageInputRole>;
export type ResolvedImageInput = ResolvedInputImage<ImageInputRole>;

export type SyncImageProvider = SyncGenerationProvider<
  ImageProviderId,
  ImageJobModelId,
  StoredImageRequest,
  ImageInputRole
>;
export type AsyncImageProvider = AsyncGenerationProvider<
  ImageProviderId,
  ImageJobModelId,
  StoredImageRequest,
  ImageInputRole
>;

// Most answer in one call (sync); BFL queues a task the job engine polls (async), so a slow render spans steps.
export type ImageProvider = SyncImageProvider | AsyncImageProvider;
