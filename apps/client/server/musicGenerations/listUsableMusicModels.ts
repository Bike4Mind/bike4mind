import {
  isMusicModelEnabled,
  usdToCredits,
  MUSIC_MODEL_CATALOG,
  MUSIC_MODEL_IDS,
  type MusicModelCapabilities,
  type MusicModelId,
  type MusicProviderId,
  type PublicMusicModel,
} from '@bike4mind/common';
import type { MusicJobDeps } from '@bike4mind/services/musicJobs';

export type MusicModelAvailabilityDeps = Pick<MusicJobDeps, 'providers' | 'getSettings' | 'resolveApiKey'>;

const toPublicDuration = (duration: MusicModelCapabilities['duration']): PublicMusicModel['duration'] =>
  duration.control === 'fixed'
    ? { control: 'fixed', seconds: duration.seconds }
    : { control: duration.control, min: duration.min, max: duration.max, default: duration.default };

export const toPublicMusicModel = (id: MusicModelId): PublicMusicModel => {
  const caps = MUSIC_MODEL_CATALOG[id];
  return {
    id,
    object: 'music_model',
    display_name: caps.displayName,
    provider: caps.provider,
    vocals: caps.vocals,
    lyrics: caps.lyrics ? { max_chars: caps.lyrics.maxChars, max_line_chars: caps.lyrics.maxLineChars ?? null } : null,
    duration: toPublicDuration(caps.duration),
    output_formats: [...caps.outputFormats],
    typical_render_seconds: caps.typicalRenderSeconds,
    pricing: { unit: caps.pricing.unit, credits: usdToCredits(caps.pricing.usd) },
    preview: caps.preview,
    deprecation_date: caps.deprecationDate ?? null,
  };
};

/** Enabled by admin settings, registered in this deployment, and backed by a key this caller can use. */
export async function listUsableMusicModels(
  userId: string,
  deps: MusicModelAvailabilityDeps
): Promise<PublicMusicModel[]> {
  const settings = await deps.getSettings();
  const keys = new Map<MusicProviderId, Promise<boolean>>();
  const usable: PublicMusicModel[] = [];
  for (const id of MUSIC_MODEL_IDS) {
    const { provider } = MUSIC_MODEL_CATALOG[id];
    if (!isMusicModelEnabled(id, settings.musicGeneration) || !deps.providers.get(provider)) continue;
    if (!keys.has(provider)) keys.set(provider, deps.resolveApiKey(provider, userId).then(Boolean));
    if (await keys.get(provider)) usable.push(toPublicMusicModel(id));
  }
  return usable;
}
