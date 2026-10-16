import { MUSIC_PROMPT_MAX_LENGTH, type PublicMusicModel } from '@bike4mind/common';
import type { CapabilityControl, CapabilityField } from '@client/app/components/Studio/capabilityFields';
import { LYRIC_SECTION_TAGS, acceptsLyrics, lyricsProblem, type MusicFormState } from './musicForm';

type Update = (patch: Partial<MusicFormState>) => void;

const instrumentalField = (model: PublicMusicModel, form: MusicFormState, update: Update): CapabilityControl =>
  model.vocals === 'never'
    ? { kind: 'note', id: 'instrumental', label: 'This model makes instrumental music only.' }
    : {
        kind: 'switch',
        id: 'instrumental',
        label: 'Instrumental',
        checked: form.instrumental,
        onChange: instrumental => update({ instrumental }),
      };

const lyricsFields = (model: PublicMusicModel, form: MusicFormState, update: Update): CapabilityControl[] => {
  if (model.vocals === 'never') return [];
  if (!acceptsLyrics(model) || !model.lyrics) {
    return [{ kind: 'note', id: 'lyrics', label: 'This model writes its own lyrics.' }];
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

const durationField = (model: PublicMusicModel, form: MusicFormState, update: Update): CapabilityControl => {
  const { duration } = model;
  if (duration.control === 'fixed' || form.durationSeconds === null) {
    const seconds = duration.control === 'fixed' ? duration.seconds : duration.default;
    return { kind: 'note', id: 'duration', label: `Songs are ${seconds}s long.` };
  }
  // An approximate model steers the length through the prompt, so the song can run shorter or longer.
  const label =
    duration.control === 'approximate'
      ? `Duration: about ${form.durationSeconds}s`
      : `Duration: ${form.durationSeconds}s`;
  return {
    kind: 'range',
    id: 'duration',
    label,
    min: duration.min,
    max: duration.max,
    step: 1,
    value: form.durationSeconds,
    onChange: durationSeconds => update({ durationSeconds }),
  };
};

export const formatRenderTime = (seconds: number): string =>
  seconds < 90 ? `about ${Math.max(1, Math.round(seconds))} seconds` : `about ${Math.round(seconds / 60)} minutes`;

/** The music Studio controls for the selected model, in display order. */
export function musicCapabilityFields(
  model: PublicMusicModel,
  form: MusicFormState,
  update: Update
): CapabilityField[] {
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
    instrumentalField(model, form, update),
    ...lyricsFields(model, form, update),
    durationField(model, form, update),
    {
      kind: 'note',
      id: 'render-time',
      label: `Usually ready in ${formatRenderTime(model.typical_render_seconds)}.`,
    },
  ];
}
