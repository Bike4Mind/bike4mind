/** Test-only builders for the music data layer, listener and card tests. App code must never import this module. */
import type { MusicGeneration } from '@bike4mind/common';

type MusicOutput = NonNullable<MusicGeneration['output']>;

export const musicJob = (overrides: Partial<MusicGeneration> = {}): MusicGeneration => ({
  id: 'music-1',
  object: 'music_generation',
  state: 'running',
  model: 'lyria-3',
  prompt: 'a calm piano piece',
  lyrics: null,
  instrumental: false,
  duration_seconds: 30,
  source: 'agent',
  error: null,
  output: null,
  credits: { reserved: 10, settled: null },
  created_at: '2026-10-07T00:00:00.000Z',
  updated_at: '2026-10-07T00:00:00.000Z',
  ...overrides,
});

export const musicOutput = (overrides: Partial<MusicOutput> = {}): MusicOutput => ({
  availability: 'ready',
  url: 'https://files.example/song-1.mp3?sig=a',
  expires_at: '2026-10-07T00:15:00.000Z',
  content_type: 'audio/mpeg',
  duration_seconds: 30,
  lyrics: null,
  file_id: 'file-1',
  ...overrides,
});
