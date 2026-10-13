import type { MusicModelId, MusicProviderId, ValidatedMusicRequest } from '@bike4mind/common';
import type { GenerationProvider } from '../generationProviders/types';

export * from '../generationProviders/types';

export type MusicProvider = GenerationProvider<MusicProviderId, MusicModelId, ValidatedMusicRequest>;
