import type { GenerationProviderJobHandle } from '../generation';
import type { VideoModelId } from './catalog';

export const VIDEO_MODES = ['text_to_video', 'image_to_video'] as const;
export type VideoMode = (typeof VIDEO_MODES)[number];

// What an input image is for. snake_case to share names with the FabFile lineage roles (derivedFrom), so a saved
// clip can record each input under its role.
export const VIDEO_INPUT_ROLES = ['first_frame', 'last_frame', 'reference', 'style'] as const;
export type VideoInputRole = (typeof VIDEO_INPUT_ROLES)[number];

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
  // The input roles this model accepts and how many of each. A first_frame entry is what image_to_video needs.
  inputs: Partial<Record<VideoInputRole, { max: number }>>;
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
  // Set once the provider stops serving the model. The id stays in VIDEO_MODEL_IDS so stored jobs and usage still
  // parse, but a retired model is never listed or accepted for a new job, whatever the admin override says.
  retired?: { date: string; replacement: VideoModelId };
};
