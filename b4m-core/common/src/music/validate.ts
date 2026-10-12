import type { MusicGenerationRequest, ValidatedMusicRequest } from './request';
import type { MusicDurationCapability, MusicModelCapabilities } from './types';

export const MUSIC_VALIDATION_ERROR_CODES = [
  'lyrics_not_supported',
  'lyrics_with_instrumental',
  'lyrics_too_long',
  'vocals_not_supported',
  'duration_out_of_range',
] as const;
export type MusicValidationErrorCode = (typeof MUSIC_VALIDATION_ERROR_CODES)[number];

export type MusicValidationResult =
  { ok: true; request: ValidatedMusicRequest } | { ok: false; code: MusicValidationErrorCode; message: string };

const fail = (code: MusicValidationErrorCode, message: string): MusicValidationResult => ({ ok: false, code, message });

/** The length to request, or null when the caller asked for one the model cannot produce. */
const resolveDuration = (requested: number | undefined, duration: MusicDurationCapability): number | null => {
  if (duration.control === 'fixed')
    return requested === undefined || requested === duration.seconds ? duration.seconds : null;
  const seconds = requested ?? duration.default;
  return seconds >= duration.min && seconds <= duration.max ? seconds : null;
};

const describeDuration = (duration: MusicDurationCapability): string =>
  duration.control === 'fixed' ? `fixed at ${duration.seconds}s` : `allowed: ${duration.min}-${duration.max}s`;

// Never rounds or clamps: a request the model cannot honour fails with a code the caller can surface.
export const validateMusicRequest = (
  request: MusicGenerationRequest,
  caps: MusicModelCapabilities
): MusicValidationResult => {
  const instrumental = request.instrumental ?? caps.vocals === 'never';
  if (!instrumental && caps.vocals === 'never') {
    return fail('vocals_not_supported', `${caps.displayName} generates instrumental music only`);
  }
  if (request.lyrics !== undefined) {
    if (instrumental) return fail('lyrics_with_instrumental', 'lyrics cannot be combined with instrumental');
    if (!caps.lyrics) return fail('lyrics_not_supported', `${caps.displayName} does not accept custom lyrics`);
    if (request.lyrics.length > caps.lyrics.maxChars) {
      return fail(
        'lyrics_too_long',
        `lyrics are ${request.lyrics.length} characters; ${caps.displayName} accepts at most ${caps.lyrics.maxChars}`
      );
    }
    const { maxLineChars } = caps.lyrics;
    if (maxLineChars !== undefined && request.lyrics.split('\n').some(line => line.length > maxLineChars)) {
      return fail('lyrics_too_long', `${caps.displayName} accepts at most ${maxLineChars} characters per lyric line`);
    }
  }
  const durationSeconds = resolveDuration(request.durationSeconds, caps.duration);
  if (durationSeconds === null) {
    return fail(
      'duration_out_of_range',
      `duration ${request.durationSeconds}s is not supported by ${caps.displayName} (${describeDuration(caps.duration)})`
    );
  }
  return { ok: true, request: { ...request, instrumental, durationSeconds } as ValidatedMusicRequest };
};
