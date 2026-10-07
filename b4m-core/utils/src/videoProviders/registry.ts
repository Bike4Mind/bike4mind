import { VIDEO_MODEL_CATALOG, VIDEO_MODEL_IDS, type VideoProviderId } from '@bike4mind/common';
import type { VideoProvider } from './types';

export type VideoProviderRegistry = {
  get(id: VideoProviderId): VideoProvider | undefined;
  ids(): VideoProviderId[];
};

// The catalog is the single owner of model -> provider, so a provider must serve exactly the models assigned to it.
const assertModelsMatchCatalog = (provider: VideoProvider): void => {
  for (const model of provider.models) {
    const owner = VIDEO_MODEL_CATALOG[model].provider;
    if (owner !== provider.id) {
      throw new Error(`video provider ${provider.id} lists ${model}, which the catalog assigns to ${owner}`);
    }
  }
  const missing = VIDEO_MODEL_IDS.filter(
    id => VIDEO_MODEL_CATALOG[id].provider === provider.id && !provider.models.includes(id)
  );
  if (missing.length > 0) {
    throw new Error(`video provider ${provider.id} does not list catalog models: ${missing.join(', ')}`);
  }
};

export const createVideoProviderRegistry = (providers: readonly VideoProvider[]): VideoProviderRegistry => {
  const byId = new Map<VideoProviderId, VideoProvider>();
  for (const provider of providers) {
    if (byId.has(provider.id)) throw new Error(`duplicate video provider: ${provider.id}`);
    assertModelsMatchCatalog(provider);
    byId.set(provider.id, provider);
  }
  return { get: id => byId.get(id), ids: () => [...byId.keys()] };
};
