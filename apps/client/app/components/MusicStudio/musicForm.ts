/**
 * The music Studio form's rules, kept free of React: defaults per model, what changes when the user switches model,
 * the request body, and the credit estimate. The server never rounds a request (validateMusicRequest), so the form
 * is where values are moved onto what the model supports, and every move is reported to the user.
 */
import {
  estimateMusicCostCredits,
  MUSIC_MODEL_CATALOG,
  MUSIC_PROMPT_MAX_LENGTH,
  MusicModelIdSchema,
  type CreateMusicGenerationBody,
  type PublicMusicModel,
} from '@bike4mind/common';

export type MusicFormState = {
  modelId: string;
  prompt: string;
  // Kept while Instrumental is on or the model takes no lyrics, so a toggle or model switch never loses them; only
  // sent when the model accepts them and the song has vocals.
  lyrics: string;
  instrumental: boolean;
  // null for a fixed-length model; the request then omits duration_seconds.
  durationSeconds: number | null;
};

export const LYRIC_SECTION_TAGS = ['[Verse]', '[Chorus]', '[Bridge]'] as const;

type MusicDuration = PublicMusicModel['duration'];

export const acceptsLyrics = (model: PublicMusicModel): boolean => model.lyrics !== null && model.vocals !== 'never';

const sendsLyrics = (state: MusicFormState, model: PublicMusicModel): boolean =>
  acceptsLyrics(model) && !state.instrumental && state.lyrics.trim().length > 0;

export function initialFormFor(model: PublicMusicModel): MusicFormState {
  return {
    modelId: model.id,
    prompt: '',
    lyrics: '',
    instrumental: model.vocals === 'never',
    durationSeconds: model.duration.control === 'fixed' ? null : model.duration.default,
  };
}

/** Whole seconds within the model's range; a fixed-length model takes no duration. */
export function clampDuration(seconds: number | null, duration: MusicDuration): number | null {
  if (duration.control === 'fixed') return null;
  const requested = Math.round(seconds ?? duration.default);
  return Math.min(Math.max(requested, duration.min), duration.max);
}

/**
 * Why the lyrics cannot be sent to this model as they are, or null when they can (or will not be sent at all).
 * Mirrors the lyrics checks in validateMusicRequest so the form refuses before the server does.
 */
export function lyricsProblem(state: MusicFormState, model: PublicMusicModel): string | null {
  if (!sendsLyrics(state, model) || !model.lyrics) return null;
  const lyrics = state.lyrics.trim();
  const { max_chars: maxChars, max_line_chars: maxLineChars } = model.lyrics;
  if (lyrics.length > maxChars) {
    return `Lyrics are ${lyrics.length} characters; ${model.display_name} accepts at most ${maxChars}.`;
  }
  if (maxLineChars !== null && lyrics.split(/\r?\n/).some(line => line.length > maxLineChars)) {
    return `${model.display_name} accepts at most ${maxLineChars} characters per lyric line.`;
  }
  return null;
}

export function clampToModel(
  state: MusicFormState,
  model: PublicMusicModel
): { state: MusicFormState; changes: string[] } {
  const changes: string[] = [];
  const name = model.display_name;

  const durationSeconds = clampDuration(state.durationSeconds, model.duration);
  if (model.duration.control === 'fixed') {
    if (state.durationSeconds !== null) changes.push(`${name} always makes ${model.duration.seconds}s songs.`);
  } else if (state.durationSeconds !== null && durationSeconds !== state.durationSeconds) {
    changes.push(`Duration changed from ${state.durationSeconds}s to ${durationSeconds}s.`);
  }

  const instrumental = model.vocals === 'never' || state.instrumental;
  if (!state.instrumental && instrumental) changes.push(`${name} makes instrumental music only.`);

  const next: MusicFormState = { ...state, modelId: model.id, instrumental, durationSeconds };
  const hasLyrics = state.lyrics.trim().length > 0;
  if (hasLyrics && !instrumental && model.lyrics === null) {
    changes.push(`${name} writes its own lyrics; yours are kept but will not be sent.`);
  }
  const problem = lyricsProblem(next, model);
  if (problem) changes.push(`${problem} Shorten them to generate.`);

  return { state: next, changes };
}

export function toCreateBody(state: MusicFormState, model: PublicMusicModel): CreateMusicGenerationBody {
  return {
    model: state.modelId,
    prompt: state.prompt.trim(),
    instrumental: state.instrumental,
    ...(sendsLyrics(state, model) && { lyrics: state.lyrics.trim() }),
    ...(state.durationSeconds !== null && { duration_seconds: state.durationSeconds }),
  };
}

export function canSubmit(state: MusicFormState, model: PublicMusicModel): boolean {
  const prompt = state.prompt.trim();
  if (prompt.length === 0 || prompt.length > MUSIC_PROMPT_MAX_LENGTH) return false;
  return lyricsProblem(state, model) === null;
}

/** The same estimate the server holds credits with, or null for a model the catalog does not know. */
export function estimateCredits(state: MusicFormState): number | null {
  const modelId = MusicModelIdSchema.safeParse(state.modelId);
  if (!modelId.success) return null;
  const caps = MUSIC_MODEL_CATALOG[modelId.data];
  const durationSeconds =
    caps.duration.control === 'fixed' ? caps.duration.seconds : (state.durationSeconds ?? caps.duration.default);
  return estimateMusicCostCredits(caps, { durationSeconds });
}
