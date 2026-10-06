import { z } from 'zod';
import type { VideoModelCapabilities } from './types';

// Adding a model: append its id here, then TypeScript forces a declaration in VIDEO_MODEL_CATALOG.
export const VIDEO_MODEL_IDS = ['test-video', 'gemini-omni-1.1-flash'] as const;
export type VideoModelId = (typeof VIDEO_MODEL_IDS)[number];
export const VideoModelIdSchema = z.enum(VIDEO_MODEL_IDS);

export const VIDEO_MODEL_CATALOG: Record<VideoModelId, VideoModelCapabilities> = {
  // Deterministic, free, registered only when ENABLE_TEST_VIDEO_PROVIDER=true (never in production).
  'test-video': {
    provider: 'test',
    displayName: 'Test video (non-production)',
    modes: ['text_to_video', 'image_to_video'],
    duration: { kind: 'range', min: 1, max: 10, step: 1 },
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p'],
    defaults: { durationSeconds: 4, aspectRatio: '16:9', resolution: '720p' },
    audio: 'none',
    pricing: { unit: 'per_second', usdByResolution: { '720p': 0.01 } },
    defaultEnabled: true,
  },
  // Audio is always generated and is included in the per-second price.
  'gemini-omni-1.1-flash': {
    provider: 'gemini-omni',
    displayName: 'Gemini Omni Flash',
    modes: ['text_to_video', 'image_to_video'],
    duration: { kind: 'range', min: 3, max: 10, step: 1 },
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p'],
    defaults: { durationSeconds: 6, aspectRatio: '16:9', resolution: '720p' },
    audio: 'always',
    pricing: { unit: 'per_second', usdByResolution: { '720p': 0.1014 } },
    defaultEnabled: true,
  },
};

export const getVideoModelCapabilities = (id: VideoModelId): VideoModelCapabilities => VIDEO_MODEL_CATALOG[id];
