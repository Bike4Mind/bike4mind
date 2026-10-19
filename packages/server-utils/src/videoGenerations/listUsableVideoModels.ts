import {
  isVideoModelEnabled,
  usdToCredits,
  VIDEO_MODEL_CATALOG,
  VIDEO_MODEL_IDS,
  type VideoModel,
  type VideoModelId,
  type VideoProviderId,
} from '@bike4mind/common';
import type { VideoJobDeps } from '@bike4mind/services/videoJobs';

export type VideoModelAvailabilityDeps = Pick<VideoJobDeps, 'providers' | 'getSettings' | 'resolveApiKey'>;

export const hasUsableKey = async (
  providerId: VideoProviderId,
  userId: string,
  deps: Pick<VideoJobDeps, 'resolveApiKey'>
): Promise<boolean> => Boolean(await deps.resolveApiKey(providerId, userId));

export const toPublicVideoModel = (id: VideoModelId): VideoModel => {
  const caps = VIDEO_MODEL_CATALOG[id];
  const { duration, pricing } = caps;
  return {
    id,
    object: 'video_model',
    display_name: caps.displayName,
    provider: caps.provider,
    modes: [...caps.modes],
    duration:
      duration.kind === 'range'
        ? { kind: 'range', min: duration.min, max: duration.max, step: duration.step }
        : { kind: 'discrete', values: [...duration.values] },
    aspect_ratios: [...caps.aspectRatios],
    resolutions: [...caps.resolutions],
    defaults: {
      duration_seconds: caps.defaults.durationSeconds,
      aspect_ratio: caps.defaults.aspectRatio,
      resolution: caps.defaults.resolution,
    },
    audio: caps.audio,
    credits_per_second:
      pricing.unit === 'per_second'
        ? Object.fromEntries(
            Object.entries(pricing.usdByResolution).flatMap(([resolution, usd]) =>
              usd === undefined ? [] : [[resolution, usdToCredits(usd)]]
            )
          )
        : null,
    deprecation_date: caps.deprecationDate ?? null,
  };
};

/** Enabled by admin settings, registered in this deployment, and backed by a key this caller can use. */
export async function listUsableVideoModels(userId: string, deps: VideoModelAvailabilityDeps): Promise<VideoModel[]> {
  const settings = await deps.getSettings();
  const keys = new Map<VideoProviderId, Promise<boolean>>();
  const usable: VideoModel[] = [];
  for (const id of VIDEO_MODEL_IDS) {
    const { provider } = VIDEO_MODEL_CATALOG[id];
    if (!isVideoModelEnabled(id, settings.videoGeneration) || !deps.providers.get(provider)) continue;
    if (!keys.has(provider)) keys.set(provider, hasUsableKey(provider, userId, deps));
    if (await keys.get(provider)) usable.push(toPublicVideoModel(id));
  }
  return usable;
}
