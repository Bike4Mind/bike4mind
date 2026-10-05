export const VIDEO_MODES = ['text_to_video', 'image_to_video'] as const;
export type VideoMode = (typeof VIDEO_MODES)[number];

export const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const RESOLUTION_TIERS = ['360p', '480p', '720p', '1080p', '4k'] as const;
export type ResolutionTier = (typeof RESOLUTION_TIERS)[number];

// Each provider adapter PR appends its id here (plan 2: 'gemini-omni', plan 3: 'veo', 'xai').
export const VIDEO_PROVIDER_IDS = ['test'] as const;
export type VideoProviderId = (typeof VIDEO_PROVIDER_IDS)[number];

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
  audio: 'always' | 'optional' | 'none';
  pricing: VideoPricing;
  // Admin setting `videoGeneration.enabledModels[id]` overrides this.
  defaultEnabled: boolean;
  deprecationDate?: string;
};
