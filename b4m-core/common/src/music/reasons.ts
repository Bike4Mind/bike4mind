import { outOfBoundsPhrase, reasonFor, type ReasonTable } from '../utils/capabilityReasons';
import type { MusicDurationCapability } from './types';
import type { MusicValidationErrorCode } from './validate';

/**
 * The context behind each music validation failure, keyed on its code. `model` is the display name, so the
 * reason can name it. Read by musicFailureReason.
 */
export type MusicFailureDetail = { model: string } & (
  | { code: 'unsupported_duration'; requested: number; allowed: MusicDurationCapability }
  | { code: 'unsupported_lyrics' }
  | { code: 'unsupported_vocals' }
  | { code: 'lyrics_with_instrumental' }
  // `requested` is the whole text's length for `total`, the longest line's for `line`.
  | { code: 'lyrics_too_long'; limit: 'total' | 'line'; max: number; requested: number }
);

function durationReason(model: string, requested: number, allowed: MusicDurationCapability): string {
  if (allowed.control === 'fixed') return `${model} makes ${allowed.seconds}s tracks only; you asked for ${requested}s`;
  const supported = outOfBoundsPhrase(requested, allowed.min, allowed.max, 's') ?? `${allowed.min}-${allowed.max}s`;
  return `${model} supports ${supported}; you asked for ${requested}s`;
}

const MUSIC_REASONS: ReasonTable<MusicValidationErrorCode, MusicFailureDetail> = {
  unsupported_duration: ({ model, requested, allowed }) => durationReason(model, requested, allowed),
  unsupported_lyrics: ({ model }) => `${model} does not take custom lyrics`,
  unsupported_vocals: ({ model }) => `${model} makes instrumental music only`,
  lyrics_with_instrumental: () => 'An instrumental track cannot have lyrics',
  lyrics_too_long: ({ model, limit, max, requested }) =>
    limit === 'total'
      ? `${model} takes up to ${max} characters of lyrics; yours have ${requested}`
      : `${model} takes up to ${max} characters per lyric line; your longest has ${requested}`,
};

/** A short, user-facing "why not" for one music validation failure, e.g. for a greyed-out model card. */
export const musicFailureReason = (detail: MusicFailureDetail): string => reasonFor(MUSIC_REASONS, detail);
