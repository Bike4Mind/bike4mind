import { MUSIC_PROMPT_MAX_LENGTH, type PublicMusicModel } from '@bike4mind/common';
import type { CapabilityControl, CapabilityField } from '@client/app/components/Studio/capabilityFields';
import { musicFieldProblems, type MusicFieldProblem, type MusicFieldProblems } from './musicCreateV2';
import { LYRIC_SECTION_TAGS, acceptsLyrics, lyricsProblem, type MusicFormState } from './musicForm';

type Update = (patch: Partial<MusicFormState>) => void;

// `legacy`: the Studio tabs, where a model switch has already moved every value onto the model. `createV2`: a
// switch keeps the values, so one the model does not take is shown marked, with its reason and a fix.
export type MusicFieldsLayout = 'legacy' | 'createV2';

const flagged = (problem: MusicFieldProblem | undefined, update: Update) =>
  problem ? { invalidReason: problem.reason, fix: { label: problem.fixLabel, apply: () => update(problem.fix) } } : {};

const instrumentalField = (
  model: PublicMusicModel,
  form: MusicFormState,
  update: Update,
  problems: MusicFieldProblems
): CapabilityControl =>
  model.vocals === 'never'
    ? {
        ...flagged(problems.instrumental, update),
        kind: 'note',
        id: 'instrumental',
        label: 'This model makes instrumental music only.',
      }
    : {
        kind: 'switch',
        id: 'instrumental',
        label: 'Instrumental',
        checked: form.instrumental,
        onChange: instrumental => update({ instrumental }),
      };

const lyricsFields = (
  model: PublicMusicModel,
  form: MusicFormState,
  update: Update,
  problems: MusicFieldProblems
): CapabilityControl[] => {
  if (model.vocals === 'never') return [];
  if (!acceptsLyrics(model) || !model.lyrics) {
    return [
      { ...flagged(problems.lyrics, update), kind: 'note', id: 'lyrics', label: 'This model writes its own lyrics.' },
    ];
  }
  const problem = lyricsProblem(form, model);
  return [
    {
      kind: 'text',
      id: 'lyrics',
      label: 'Lyrics',
      value: form.lyrics,
      placeholder: form.instrumental
        ? 'Turn off Instrumental to add lyrics.'
        : 'Optional. Leave empty and the model writes the lyrics.',
      maxLength: model.lyrics.max_chars,
      minRows: 6,
      snippets: LYRIC_SECTION_TAGS,
      disabled: form.instrumental,
      onChange: lyrics => update({ lyrics }),
    },
    ...(problem ? [{ kind: 'note' as const, id: 'lyrics-problem', label: problem }] : []),
  ];
};

const durationField = (
  model: PublicMusicModel,
  form: MusicFormState,
  update: Update,
  problems: MusicFieldProblems
): CapabilityControl => {
  const { duration } = model;
  if (duration.control === 'fixed') {
    return {
      ...flagged(problems.duration, update),
      kind: 'note',
      id: 'duration',
      label: `Songs are ${duration.seconds}s long.`,
    };
  }
  // null only after a fixed-length model in Create v2, which keeps values across a switch; the slider starts at the
  // model's default and the request leaves the length to the model until the user moves it.
  const seconds = form.durationSeconds ?? duration.default;
  // An approximate model steers the length through the prompt, so the song can run shorter or longer.
  const label = duration.control === 'approximate' ? `Duration: about ${seconds}s` : `Duration: ${seconds}s`;
  return {
    ...flagged(problems.duration, update),
    kind: 'range',
    id: 'duration',
    label,
    min: duration.min,
    max: duration.max,
    step: 1,
    value: seconds,
    onChange: durationSeconds => update({ durationSeconds }),
  };
};

export const formatRenderTime = (seconds: number): string =>
  seconds < 90 ? `about ${Math.max(1, Math.round(seconds))} seconds` : `about ${Math.round(seconds / 60)} minutes`;

/** The music Studio controls for the selected model, in display order. */
export function musicCapabilityFields(
  model: PublicMusicModel,
  form: MusicFormState,
  update: Update,
  layout: MusicFieldsLayout = 'legacy'
): CapabilityField[] {
  // A legacy form never holds a value the model does not take: its model switch clamps.
  const problems = layout === 'createV2' ? musicFieldProblems(model, form) : {};
  return [
    {
      kind: 'text',
      id: 'prompt',
      label: 'Prompt',
      value: form.prompt,
      placeholder: 'Describe the song: genre, mood, instruments, tempo',
      maxLength: MUSIC_PROMPT_MAX_LENGTH,
      onChange: prompt => update({ prompt }),
    },
    instrumentalField(model, form, update, problems),
    ...lyricsFields(model, form, update, problems),
    durationField(model, form, update, problems),
    {
      kind: 'note',
      id: 'render-time',
      label: `Usually ready in ${formatRenderTime(model.typical_render_seconds)}.`,
    },
  ];
}
