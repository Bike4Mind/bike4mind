import type { VideoProviderId } from '@bike4mind/common';
import type { VideoProvider } from './types';

export type VideoProviderRegistry = {
  get(id: VideoProviderId): VideoProvider | undefined;
  ids(): VideoProviderId[];
};

export const createVideoProviderRegistry = (providers: readonly VideoProvider[]): VideoProviderRegistry => {
  const byId = new Map<VideoProviderId, VideoProvider>();
  for (const provider of providers) {
    if (byId.has(provider.id)) throw new Error(`duplicate video provider: ${provider.id}`);
    byId.set(provider.id, provider);
  }
  return { get: id => byId.get(id), ids: () => [...byId.keys()] };
};
