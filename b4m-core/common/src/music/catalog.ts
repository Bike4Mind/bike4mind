import { z } from 'zod';
import { MAX_MUSIC_LYRICS_CHARS, type MusicModelCapabilities } from './types';

// Adding a model: append its id here, then TypeScript forces a declaration in MUSIC_MODEL_CATALOG.
export const MUSIC_MODEL_IDS = [
  'test-music',
  'lyria-3.5',
  'lyria-3-clip-preview',
  'music_v2_5',
  'music_v2',
  'music_v1',
] as const;
export type MusicModelId = (typeof MUSIC_MODEL_IDS)[number];
export const MusicModelIdSchema = z.enum(MUSIC_MODEL_IDS);

// ElevenLabs bills every music model at $0.15 per output minute.
const ELEVENLABS_MUSIC_USD_PER_SECOND = 0.15 / 60;
// music_length_ms: the API reference allows 3-600 s, the capability page caps songs at 5 min; take the stricter.
const ELEVENLABS_MUSIC_DURATION = { control: 'exact', min: 3, max: 300, default: 60 } as const;

export const MUSIC_MODEL_CATALOG: Record<MusicModelId, MusicModelCapabilities> = {
  // Deterministic and free; the test provider will be registered only behind a non-production flag, as test-video is.
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
  // Lyrics travel inside the prompt (131k input tokens), so only the shared lyrics cap applies.
  'lyria-3.5': {
    provider: 'gemini-lyria',
    displayName: 'Lyria 3.5',
    vocals: 'optional',
    lyrics: { maxChars: MAX_MUSIC_LYRICS_CHARS },
    duration: { control: 'approximate', min: 30, max: 180, default: 120 },
    outputFormats: ['mp3'],
    // Measured 2026-10-13: a 2-minute song took 29 s. A WAV response_format still returned MP3.
    typicalRenderSeconds: 30,
    pricing: { unit: 'per_song', usd: 0.08 },
    preview: false,
    defaultEnabled: true,
  },
  'lyria-3-clip-preview': {
    provider: 'gemini-lyria',
    displayName: 'Lyria 3 Clip',
    vocals: 'optional',
    lyrics: { maxChars: MAX_MUSIC_LYRICS_CHARS },
    duration: { control: 'fixed', seconds: 30 },
    outputFormats: ['mp3'],
    // Measured 2026-10-13: 14 s.
    typicalRenderSeconds: 15,
    pricing: { unit: 'per_song', usd: 0.04 },
    preview: true,
    defaultEnabled: true,
  },
  // Newest ElevenLabs model. Custom lyrics go through a chunked composition plan (3-120 s per chunk).
  music_v2_5: {
    provider: 'elevenlabs',
    displayName: 'ElevenLabs Music v2.5',
    vocals: 'optional',
    lyrics: { maxChars: MAX_MUSIC_LYRICS_CHARS },
    duration: ELEVENLABS_MUSIC_DURATION,
    outputFormats: ['mp3'],
    typicalRenderSeconds: 60,
    pricing: { unit: 'per_second', usd: ELEVENLABS_MUSIC_USD_PER_SECOND },
    preview: false,
    defaultEnabled: true,
  },
  music_v2: {
    provider: 'elevenlabs',
    displayName: 'ElevenLabs Music v2',
    vocals: 'optional',
    lyrics: { maxChars: MAX_MUSIC_LYRICS_CHARS },
    duration: ELEVENLABS_MUSIC_DURATION,
    outputFormats: ['mp3'],
    typicalRenderSeconds: 60,
    pricing: { unit: 'per_second', usd: ELEVENLABS_MUSIC_USD_PER_SECOND },
    preview: false,
    defaultEnabled: true,
  },
  // Superseded by v2/v2.5 (ElevenLabs gives months of notice before removal); off unless an admin enables it.
  // Its section-based composition plan caps each lyric line at 200 characters.
  music_v1: {
    provider: 'elevenlabs',
    displayName: 'ElevenLabs Music v1',
    vocals: 'optional',
    lyrics: { maxChars: 4000, maxLineChars: 200 },
    duration: ELEVENLABS_MUSIC_DURATION,
    outputFormats: ['mp3'],
    typicalRenderSeconds: 60,
    pricing: { unit: 'per_second', usd: ELEVENLABS_MUSIC_USD_PER_SECOND },
    preview: false,
    defaultEnabled: false,
  },
};

export const getMusicModelCapabilities = (id: MusicModelId): MusicModelCapabilities => MUSIC_MODEL_CATALOG[id];
