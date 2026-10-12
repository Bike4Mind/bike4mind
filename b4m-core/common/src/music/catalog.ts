import { z } from 'zod';
import type { MusicModelCapabilities } from './types';

// Adding a model: append its id here, then TypeScript forces a declaration in MUSIC_MODEL_CATALOG.
export const MUSIC_MODEL_IDS = ['test-music', 'lyria-3.5', 'lyria-3-clip-preview', 'music_v1'] as const;
export type MusicModelId = (typeof MUSIC_MODEL_IDS)[number];
export const MusicModelIdSchema = z.enum(MUSIC_MODEL_IDS);

// Lyria documents no lyrics limit; these bounds cover a full song and are revisited against the live adapter.
const LYRIA_SONG_LYRICS_MAX_CHARS = 3000;
const LYRIA_CLIP_LYRICS_MAX_CHARS = 1000;

export const MUSIC_MODEL_CATALOG: Record<MusicModelId, MusicModelCapabilities> = {
  // Deterministic, free, registered only when ENABLE_TEST_MUSIC_PROVIDER=true (never in production).
  'test-music': {
    provider: 'test',
    displayName: 'Test music (non-production)',
    vocals: 'optional',
    lyrics: { maxChars: 2000 },
    duration: { control: 'exact', min: 1, max: 30, default: 5 },
    outputFormats: ['mp3'],
    typicalRenderSeconds: 2,
    pricing: { unit: 'per_song', usd: 0 },
    preview: false,
    defaultEnabled: true,
  },
  // Length is steered by the prompt only and documented as "a couple of minutes"; billed per song whatever it runs.
  'lyria-3.5': {
    provider: 'gemini-lyria',
    displayName: 'Lyria 3.5',
    vocals: 'optional',
    lyrics: { maxChars: LYRIA_SONG_LYRICS_MAX_CHARS },
    duration: { control: 'approximate', min: 30, max: 180, default: 120 },
    outputFormats: ['mp3'],
    typicalRenderSeconds: 60,
    pricing: { unit: 'per_song', usd: 0.08 },
    preview: false,
    defaultEnabled: true,
  },
  'lyria-3-clip-preview': {
    provider: 'gemini-lyria',
    displayName: 'Lyria 3 Clip',
    vocals: 'optional',
    lyrics: { maxChars: LYRIA_CLIP_LYRICS_MAX_CHARS },
    duration: { control: 'fixed', seconds: 30 },
    outputFormats: ['mp3'],
    typicalRenderSeconds: 20,
    pricing: { unit: 'per_song', usd: 0.04 },
    preview: true,
    defaultEnabled: true,
  },
  // music_length_ms is 3-300 s here: the API reference allows 600 s but the capability page caps songs at 5 min.
  // Custom lyrics go through a composition plan, which caps each line at 200 characters. $0.15 per output minute.
  music_v1: {
    provider: 'elevenlabs',
    displayName: 'ElevenLabs Music',
    vocals: 'optional',
    lyrics: { maxChars: 4000, maxLineChars: 200 },
    duration: { control: 'exact', min: 3, max: 300, default: 60 },
    outputFormats: ['mp3'],
    typicalRenderSeconds: 60,
    pricing: { unit: 'per_second', usd: 0.0025 },
    preview: false,
    defaultEnabled: true,
  },
};

export const getMusicModelCapabilities = (id: MusicModelId): MusicModelCapabilities => MUSIC_MODEL_CATALOG[id];
