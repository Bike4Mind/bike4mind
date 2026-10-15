import { PublicMusicModelSchema, type PublicMusicModel } from '@bike4mind/common';

/** `/api/v1/music-models`, read model by model so one this build cannot parse does not hide the rest. */
export function parseMusicModels(body: unknown): PublicMusicModel[] {
  const raw = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(model => {
    const parsed = PublicMusicModelSchema.safeParse(model);
    return parsed.success ? [parsed.data] : [];
  });
}

export interface MusicSettings {
  durationSeconds?: number;
  instrumental?: boolean;
}

export interface MusicPlan {
  model: PublicMusicModel;
  /** The length the song will be asked for: the request, else what the model produces by default. */
  effectiveSeconds: number;
  estimatedCredits: number;
}

/**
 * Check a request against the chosen model and price it.
 *
 * Never clamps, matching planVideoRequest: a length the model cannot make is refused with the
 * allowed range, not quietly billed as something else.
 */
export function planMusicRequest(model: PublicMusicModel, settings: MusicSettings): MusicPlan {
  const { duration } = model;
  const requested = settings.durationSeconds;

  if (duration.control === 'fixed') {
    if (requested !== undefined && requested !== duration.seconds) {
      throw new Error(
        `${model.display_name} always makes ${duration.seconds}s songs, so ${requested}s cannot be requested. ` +
          'Omit durationSeconds or use that length.'
      );
    }
  } else if (requested !== undefined && (requested < duration.min || requested > duration.max)) {
    throw new Error(
      `${requested}s is outside what ${model.display_name} makes: ${duration.min}-${duration.max}s. ` +
        'Pick a length in that range or omit durationSeconds.'
    );
  }

  if (settings.instrumental === false && model.vocals === 'never') {
    throw new Error(`${model.display_name} only makes instrumental music, so it cannot add vocals.`);
  }

  const effectiveSeconds = requested ?? (duration.control === 'fixed' ? duration.seconds : duration.default);
  const { unit, credits } = model.pricing;
  return {
    model,
    effectiveSeconds,
    estimatedCredits: unit === 'per_song' ? credits : Math.ceil(credits * effectiveSeconds),
  };
}
