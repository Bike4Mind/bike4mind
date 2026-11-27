import type { UsageEventFeature } from '@bike4mind/common';
import { humanizeToolId } from '@client/app/utils/toolMapping';

// Typed as a full Record so a new UsageEventFeature fails typecheck here instead of showing raw.
const USAGE_FEATURE_LABELS: Record<UsageEventFeature, string> = {
  chat: 'Chat',
  image_generation: 'Image generation',
  image_edit: 'Image editing',
  video_generation: 'Video generation',
  voice: 'Voice',
  transcription: 'Transcription',
  text_to_speech: 'Text to speech',
  sound_effects: 'Sound effects',
  music_generation: 'Music generation',
  agent_execution: 'Agent runs',
  completion_api: 'API completions',
  tool: 'Tools',
  operations: 'Background operations',
  embedding: 'Search embeddings',
  decision: 'Decisions',
};

/** Readable feature name; an id outside the enum (an older row) is humanized rather than shown raw. */
export const usageFeatureLabel = (feature: string): string =>
  Object.hasOwn(USAGE_FEATURE_LABELS, feature)
    ? USAGE_FEATURE_LABELS[feature as UsageEventFeature]
    : humanizeToolId(feature);
