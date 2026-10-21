import type { GenerationProviderJobHandle } from '../generation';

export const VIDEO_MODES = ['text_to_video', 'image_to_video'] as const;
export type VideoMode = (typeof VIDEO_MODES)[number];

export const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const RESOLUTION_TIERS = ['360p', '480p', '720p', '1080p', '4k'] as const;
export type ResolutionTier = (typeof RESOLUTION_TIERS)[number];

// Each provider adapter PR appends its id here.
export const VIDEO_PROVIDER_IDS = ['test', 'gemini-omni', 'xai', 'veo'] as const;
export type VideoProviderId = (typeof VIDEO_PROVIDER_IDS)[number];

export type ProviderJobHandle = GenerationProviderJobHandle<VideoProviderId>;

export type DurationCapability =
  { kind: 'range'; min: number; max: number; step: number } | { kind: 'discrete'; values: readonly number[] };

export type VideoPricing =
  | { unit: 'per_second'; usdByResolution: Partial<Record<ResolutionTier, number>> }
  | {
      unit: 'per_clip';
      clips: ReadonlyArray<{ durationSeconds: number; resolution: ResolutionTier; usd: number }>;
    };

export type VideoModelCapabilities = {
  provider: VideoProviderId;
  displayName: string;
  modes: readonly VideoMode[];
  duration: DurationCapability;
  aspectRatios: readonly AspectRatio[];
  resolutions: readonly ResolutionTier[];
  defaults: { durationSeconds: number; aspectRatio: AspectRatio; resolution: ResolutionTier };
  // Rough wall-clock render time, only used to set the agent's expectation. Not part of the public API.
  typicalRenderSeconds: number;
  audio: 'always' | 'optional' | 'none';
  pricing: VideoPricing;
  // Admin setting `videoGeneration.enabledModels[id]` overrides this.
  defaultEnabled: boolean;
  deprecationDate?: string;
};
