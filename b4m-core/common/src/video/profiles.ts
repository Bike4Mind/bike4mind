import type { VideoModelId } from './catalog';
import type { VideoProviderId } from './types';

/** How Studio introduces each video model on its model card. Kept beside VIDEO_MODEL_CATALOG for the same keys. */
export const VIDEO_MODEL_STRENGTHS: Record<VideoModelId, string> = {
  'test-video': 'Returns a sample clip without calling a provider.',
  'gemini-omni-1.1-flash': 'Quick clips with sound, from text or an image.',
  'grok-imagine-video-1.5': 'Stylised clips with sound, from text or an image.',
  'veo-3.1-fast-generate-preview': 'Cinematic motion with native audio.',
  'flux-3-video': 'Detailed clips from text, with optional audio.',
};

export const VIDEO_PROVIDER_LABELS: Record<VideoProviderId, string> = {
  test: 'Test',
  'gemini-omni': 'Google',
  xai: 'xAI',
  veo: 'Google',
  bfl: 'Black Forest Labs',
};
