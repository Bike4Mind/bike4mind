import type { ModelProfile } from '../generation/types';
import { MUSIC_MODEL_CATALOG, type MusicModelId } from './catalog';
import type { MusicProviderId } from './types';

/** How Studio introduces each music model on its model card. Kept beside MUSIC_MODEL_CATALOG for the same keys. */
export const MUSIC_MODEL_STRENGTHS: Record<MusicModelId, string> = {
  'test-music': 'Returns a sample track without calling a provider.',
  'lyria-3.5': 'Full songs with vocals and your own lyrics.',
  'lyria-3-clip-preview': '30-second clips for sketches and loops.',
  music_v2_5: 'The newest ElevenLabs model: exact-length songs with your lyrics.',
  music_v2: 'Exact-length songs with lyric control.',
  music_v1: 'The first ElevenLabs music model, with longer lyrics.',
};

export const MUSIC_PROVIDER_LABELS: Record<MusicProviderId, string> = {
  test: 'Test',
  'gemini-lyria': 'Google',
  elevenlabs: 'ElevenLabs',
};

export const musicModelProfile = (modelId: MusicModelId): ModelProfile => ({
  blurb: MUSIC_MODEL_STRENGTHS[modelId],
  providerLabel: MUSIC_PROVIDER_LABELS[MUSIC_MODEL_CATALOG[modelId].provider],
});
