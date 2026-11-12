/**
 * Create v2's music rules on top of musicForm: a model switch keeps every value, so each one the model does not take
 * is reported here with its why-not reason (musicFailureReason, the same text the server refuses with) and the value
 * the user can move to in one click. The model cards read the same problems to grey out the models that do not fit.
 */
import {
  MUSIC_MODEL_STRENGTHS,
  MUSIC_PROVIDER_IDS,
  MUSIC_PROVIDER_LABELS,
  MusicModelIdSchema,
  musicFailureReason,
  type MusicProviderId,
  type PublicMusicModel,
} from '@bike4mind/common';
import type { FieldProblem } from '@client/app/components/Studio/capabilityFields';
import type { StudioModelCard } from '@client/app/components/Studio/StudioModelCards';
import { clampDuration, estimateCredits, initialFormFor, type MusicFormState } from './musicForm';

export type MusicProblemField = 'instrumental' | 'lyrics' | 'duration';

export type MusicFieldProblem = FieldProblem<Partial<MusicFormState>>;

export type MusicFieldProblems = Partial<Record<MusicProblemField, MusicFieldProblem>>;

const toDetailDuration = (duration: PublicMusicModel['duration']) =>
  duration.control === 'fixed'
    ? ({ control: 'fixed', seconds: duration.seconds } as const)
    : ({ control: duration.control, min: duration.min, max: duration.max, default: duration.default } as const);

/** Every form value `model` does not take, keyed by the field that holds it. Empty when the model fits. */
export function musicFieldProblems(model: PublicMusicModel, form: MusicFormState): MusicFieldProblems {
  const name = model.display_name;
  const problems: MusicFieldProblems = {};

  if (model.vocals === 'never' && !form.instrumental) {
    problems.instrumental = {
      reason: musicFailureReason({ model: name, code: 'unsupported_vocals' }),
      fixLabel: 'Make it instrumental',
      fix: { instrumental: true },
    };
  }

  // Lyrics the model would not sing are a value it does not take, not one to drop quietly at submit.
  if (model.lyrics === null && model.vocals !== 'never' && !form.instrumental && form.lyrics.trim().length > 0) {
    problems.lyrics = {
      reason: musicFailureReason({ model: name, code: 'unsupported_lyrics' }),
      fixLabel: 'Clear lyrics',
      fix: { lyrics: '' },
    };
  }

  const clamped = clampDuration(form.durationSeconds, model.duration);
  // null is "the model's own length", which every model takes.
  if (form.durationSeconds !== null && clamped !== form.durationSeconds) {
    problems.duration = {
      reason: musicFailureReason({
        model: name,
        code: 'unsupported_duration',
        requested: form.durationSeconds,
        allowed: toDetailDuration(model.duration),
      }),
      fixLabel: `Use ${model.duration.control === 'fixed' ? model.duration.seconds : clamped}s`,
      fix: { durationSeconds: clamped },
    };
  }

  return problems;
}

const isMusicProvider = (provider: string): provider is MusicProviderId =>
  (MUSIC_PROVIDER_IDS as readonly string[]).includes(provider);

const strengthOf = (modelId: string): string => {
  const parsed = MusicModelIdSchema.safeParse(modelId);
  return parsed.success ? MUSIC_MODEL_STRENGTHS[parsed.data] : '';
};

const capabilitiesOf = (model: PublicMusicModel): string[] => [
  ...(model.vocals === 'never' ? [] : ['Vocals']),
  'Instrumental',
  ...(model.lyrics !== null && model.vocals !== 'never' ? ['Your lyrics'] : []),
];

/** A card per music model, each priced at its own default length and greyed with the first value it does not take. */
export const musicModelCards = (models: readonly PublicMusicModel[], form: MusicFormState): StudioModelCard[] =>
  models.map(model => {
    const [firstProblem] = Object.values(musicFieldProblems(model, form));
    return {
      id: model.id,
      name: model.display_name,
      provider: isMusicProvider(model.provider) ? MUSIC_PROVIDER_LABELS[model.provider] : model.provider,
      strength: strengthOf(model.id),
      creditsPerOutput: estimateCredits(initialFormFor(model)),
      outputNoun: 'song',
      modes: capabilitiesOf(model),
      unavailableReason: null,
      mismatchReason: firstProblem?.reason ?? null,
    };
  });
