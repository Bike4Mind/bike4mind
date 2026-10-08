/**
 * Test-only builders shared by the video data-layer, listener and studio component tests. App code must never
 * import this module. Model fixtures mirror the wire shape of GET /api/v1/video-models; rangeModel and
 * discreteModel use real catalog ids so estimates resolve, optionalAudioModel does not (no catalog model has
 * optional audio today).
 */
import type { VideoGeneration, VideoModel } from '@bike4mind/common';
import type { VideoGenerationList } from '../videoGenerationCache';

type VideoOutput = NonNullable<VideoGeneration['output']>;

export const videoJob = (overrides: Partial<VideoGeneration> = {}): VideoGeneration => ({
  id: 'job-1',
  object: 'video_generation',
  state: 'running',
  model: 'grok-imagine-video-1.5',
  mode: 'text_to_video',
  prompt: 'a lighthouse at dusk',
  duration_seconds: 6,
  aspect_ratio: '16:9',
  resolution: '480p',
  source: 'studio',
  progress: null,
  error: null,
  output: null,
  credits: { reserved: 10, settled: null },
  created_at: '2026-10-07T00:00:00.000Z',
  updated_at: '2026-10-07T00:00:00.000Z',
  ...overrides,
});

export const readyOutput = (overrides: Partial<VideoOutput> = {}): VideoOutput => ({
  availability: 'ready',
  url: 'https://files.example/video-1.mp4?sig=a',
  expires_at: '2026-10-07T00:15:00.000Z',
  content_type: 'video/mp4',
  duration_seconds: 6,
  file_id: 'file-1',
  ...overrides,
});

export const listOf = (...pages: VideoGeneration[][]): VideoGenerationList => ({
  pages: pages.map((data, index) => ({ data, next_cursor: index < pages.length - 1 ? `cursor-${index + 1}` : null })),
  pageParams: pages.map((_, index) => (index === 0 ? undefined : `cursor-${index}`)),
});

export const rangeModel: VideoModel = {
  id: 'grok-imagine-video-1.5',
  object: 'video_model',
  display_name: 'Grok Imagine Video 1.5',
  provider: 'xai',
  modes: ['text_to_video', 'image_to_video'],
  duration: { kind: 'range', min: 1, max: 15, step: 1 },
  aspect_ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'],
  resolutions: ['480p', '720p'],
  defaults: { duration_seconds: 6, aspect_ratio: '16:9', resolution: '480p' },
  audio: 'always',
  credits_per_second: { '480p': 133, '720p': 233 },
  deprecation_date: null,
};

export const discreteModel: VideoModel = {
  id: 'veo-3.1-fast-generate-preview',
  object: 'video_model',
  display_name: 'Veo 3.1 Fast',
  provider: 'veo',
  modes: ['text_to_video', 'image_to_video'],
  duration: { kind: 'discrete', values: [4, 6, 8] },
  aspect_ratios: ['16:9', '9:16'],
  resolutions: ['720p'],
  defaults: { duration_seconds: 4, aspect_ratio: '16:9', resolution: '720p' },
  audio: 'always',
  credits_per_second: { '720p': 167 },
  deprecation_date: null,
};

export const optionalAudioModel: VideoModel = {
  id: 'synthetic-optional-audio',
  object: 'video_model',
  display_name: 'Synthetic Optional Audio',
  provider: 'test',
  modes: ['text_to_video'],
  duration: { kind: 'range', min: 2, max: 6, step: 2 },
  aspect_ratios: ['16:9'],
  resolutions: ['1080p'],
  defaults: { duration_seconds: 4, aspect_ratio: '16:9', resolution: '1080p' },
  audio: 'optional',
  credits_per_second: null,
  deprecation_date: null,
};
