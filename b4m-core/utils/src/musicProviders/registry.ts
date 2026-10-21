import { MUSIC_MODEL_CATALOG, MUSIC_MODEL_IDS, type MusicModelId, type MusicProviderId } from '@bike4mind/common';
import { createGenerationProviderRegistry, type GenerationProviderRegistry } from '../generationProviders/registry';
import type { MusicProvider } from './types';

export type MusicProviderRegistry = GenerationProviderRegistry<MusicProviderId, MusicProvider>;

export const createMusicProviderRegistry = (providers: readonly MusicProvider[]): MusicProviderRegistry =>
  createGenerationProviderRegistry<MusicProviderId, MusicModelId, MusicProvider>(
    { label: 'music', modelIds: MUSIC_MODEL_IDS, providerOf: model => MUSIC_MODEL_CATALOG[model].provider },
    providers
  );
