import type { MusicGenerationRequest, ValidatedMusicRequest } from './request';
import { musicFailureReason, type MusicFailureDetail } from './reasons';
import type { MusicDurationCapability, MusicModelCapabilities } from './types';

// Public 422 errorCode values once the music routes ship; named like VIDEO_VALIDATION_ERROR_CODES.
export const MUSIC_VALIDATION_ERROR_CODES = [
  'unsupported_duration',
  'unsupported_lyrics',
  'unsupported_vocals',
  'lyrics_with_instrumental',
  'lyrics_too_long',
] as const;
export type MusicValidationErrorCode = (typeof MUSIC_VALIDATION_ERROR_CODES)[number];

// `message` is the diagnostic for logs and API errors; `reason` is the short user-facing "why not" built from `detail`.
export type MusicValidationResult =
  | { ok: true; request: ValidatedMusicRequest }
  | { ok: false; code: MusicValidationErrorCode; message: string; reason: string; detail: MusicFailureDetail };

const fail = (detail: MusicFailureDetail, message: string): MusicValidationResult => ({
  ok: false,
  code: detail.code,
  message,
  reason: musicFailureReason(detail),
  detail,
});

/** The length to request, or null when the caller asked for one the model cannot produce. */
const resolveDuration = (requested: number | undefined, duration: MusicDurationCapability): number | null => {
  const seconds = requested ?? defaultDuration(duration);
  if (duration.control === 'fixed') return seconds === duration.seconds ? seconds : null;
  return seconds >= duration.min && seconds <= duration.max ? seconds : null;
};

const defaultDuration = (duration: MusicDurationCapability): number =>
  duration.control === 'fixed' ? duration.seconds : duration.default;

const longestLineLength = (lyrics: string): number => Math.max(...lyrics.split(/\r?\n/).map(line => line.length));

const describeDuration = (duration: MusicDurationCapability): string =>
  duration.control === 'fixed' ? `fixed at ${duration.seconds}s` : `allowed: ${duration.min}-${duration.max}s`;

// Never rounds or clamps: a request the model cannot honour fails with a code the caller can surface.
export const validateMusicRequest = (
  request: MusicGenerationRequest,
  caps: MusicModelCapabilities
): MusicValidationResult => {
  const model = caps.displayName;
  const instrumental = request.instrumental ?? caps.vocals === 'never';
  if (!instrumental && caps.vocals === 'never') {
    return fail({ model, code: 'unsupported_vocals' }, `${caps.displayName} generates instrumental music only`);
  }
  if (request.lyrics !== undefined) {
    // An instrumental-only model rejects lyrics as unsupported, not as a combination the caller never asked for.
    if (!caps.lyrics || caps.vocals === 'never') {
      return fail({ model, code: 'unsupported_lyrics' }, `${caps.displayName} does not accept custom lyrics`);
    }
    if (instrumental) {
      return fail({ model, code: 'lyrics_with_instrumental' }, 'lyrics cannot be combined with instrumental');
    }
    if (request.lyrics.length > caps.lyrics.maxChars) {
      return fail(
        { model, code: 'lyrics_too_long', limit: 'total', max: caps.lyrics.maxChars, requested: request.lyrics.length },
        `lyrics are ${request.lyrics.length} characters; ${caps.displayName} accepts at most ${caps.lyrics.maxChars}`
      );
    }
    const { maxLineChars } = caps.lyrics;
    const longestLine = maxLineChars === undefined ? 0 : longestLineLength(request.lyrics);
    if (maxLineChars !== undefined && longestLine > maxLineChars) {
      return fail(
        { model, code: 'lyrics_too_long', limit: 'line', max: maxLineChars, requested: longestLine },
        `${caps.displayName} accepts at most ${maxLineChars} characters per lyric line`
      );
    }
  }
  const durationSeconds = resolveDuration(request.durationSeconds, caps.duration);
  if (durationSeconds === null) {
    return fail(
      {
        model,
        code: 'unsupported_duration',
        requested: request.durationSeconds ?? defaultDuration(caps.duration),
        allowed: caps.duration,
      },
      `duration ${request.durationSeconds}s is not supported by ${caps.displayName} (${describeDuration(caps.duration)})`
    );
  }
  return { ok: true, request: { ...request, instrumental, durationSeconds } as ValidatedMusicRequest };
};
