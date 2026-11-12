import { VIDEO_PROMPT_MAX_LENGTH, type VideoModel } from '@bike4mind/common';
import {
  withCurrentValue,
  type CapabilityControl,
  type CapabilityField,
} from '@client/app/components/Studio/capabilityFields';
import { videoFieldProblems, type VideoFieldProblem, type VideoFieldProblems } from './videoCreateV2';
import { MODE_LABELS, type VideoFormState } from './videoForm';

export type VideoFieldActions = {
  update: (patch: Partial<VideoFormState>) => void;
  pickImage: () => void;
};

// `legacy`: the Studio tabs, where a model switch has already moved every value onto the model. `createV2`: a
// switch keeps the values, so one the model does not take is shown marked, with its reason and a fix.
export type VideoFieldsLayout = 'legacy' | 'createV2';

const flagged = (problem: VideoFieldProblem | undefined, update: VideoFieldActions['update']) =>
  problem ? { invalidReason: problem.reason, fix: { label: problem.fixLabel, apply: () => update(problem.fix) } } : {};

const durationField = (
  model: VideoModel,
  form: VideoFormState,
  { update }: VideoFieldActions,
  problems: VideoFieldProblems
): CapabilityControl => {
  const label = `Duration: ${form.durationSeconds}s`;
  const { duration } = model;
  if (duration.kind === 'range') {
    return {
      ...flagged(problems.duration, update),
      kind: 'range',
      id: 'duration',
      label,
      min: duration.min,
      max: duration.max,
      step: duration.step,
      value: form.durationSeconds,
      onChange: durationSeconds => update({ durationSeconds }),
    };
  }
  return {
    ...flagged(problems.duration, update),
    kind: 'segmented',
    id: 'duration',
    label,
    value: String(form.durationSeconds),
    options: withCurrentValue(
      duration.values.map(seconds => ({ value: String(seconds), label: `${seconds}s` })),
      String(form.durationSeconds),
      `${form.durationSeconds}s`
    ),
    onChange: value => {
      const seconds = Number(value);
      if (duration.values.includes(seconds)) update({ durationSeconds: seconds });
    },
  };
};

const audioField = (model: VideoModel, form: VideoFormState, { update }: VideoFieldActions): CapabilityControl => {
  if (model.audio === 'optional') {
    // null when the previous model had no audio choice (Create v2 keeps it across a switch); audio is then on.
    const checked = form.audio ?? true;
    return { kind: 'switch', id: 'audio', label: 'Audio', checked, onChange: audio => update({ audio }) };
  }
  const label = model.audio === 'always' ? 'Audio is included.' : 'This model generates video without audio.';
  return { kind: 'note', id: 'audio', label };
};

const outputFields = (
  model: VideoModel,
  form: VideoFormState,
  { update }: VideoFieldActions,
  problems: VideoFieldProblems,
  layout: VideoFieldsLayout
): CapabilityControl[] => {
  const aspectOptions = withCurrentValue(
    model.aspect_ratios.map(ratio => ({ value: ratio, label: ratio })),
    form.aspectRatio
  );
  const resolutionOptions = withCurrentValue(
    model.resolutions.map(resolution => ({ value: resolution, label: resolution })),
    form.resolution
  );
  const onAspect = (value: string) => {
    const aspectRatio = model.aspect_ratios.find(candidate => candidate === value);
    if (aspectRatio) update({ aspectRatio });
  };
  const onResolution = (value: string) => {
    const resolution = model.resolutions.find(candidate => candidate === value);
    if (resolution) update({ resolution });
  };
  const aspect = {
    ...flagged(problems.aspect, update),
    id: 'aspect',
    label: 'Aspect ratio',
    value: form.aspectRatio,
    options: aspectOptions,
    onChange: onAspect,
  };
  const resolution = {
    ...flagged(problems.resolution, update),
    id: 'resolution',
    label: 'Resolution',
    value: form.resolution,
    options: resolutionOptions,
    onChange: onResolution,
  };
  return layout === 'createV2'
    ? [
        { ...aspect, kind: 'aspect' },
        { ...resolution, kind: 'segmented' },
      ]
    : [
        { ...aspect, kind: 'select' },
        { ...resolution, kind: 'select' },
      ];
};

/** The video Studio controls for the selected model, in display order. */
export function videoCapabilityFields(
  model: VideoModel,
  form: VideoFormState,
  actions: VideoFieldActions,
  layout: VideoFieldsLayout = 'legacy'
): CapabilityField[] {
  const { update } = actions;
  // A legacy form never holds a value the model does not take: its model switch clamps.
  const problems = layout === 'createV2' ? videoFieldProblems(model, form) : {};
  const output = outputFields(model, form, actions, problems, layout);
  return [
    {
      ...flagged(problems.mode, update),
      kind: 'segmented',
      id: 'mode',
      label: 'Mode',
      value: form.mode,
      options: withCurrentValue(
        model.modes.map(mode => ({ value: mode, label: MODE_LABELS[mode] })),
        form.mode,
        MODE_LABELS[form.mode]
      ),
      onChange: value => {
        const mode = model.modes.find(candidate => candidate === value);
        if (mode) update({ mode, inputImage: mode === 'image_to_video' ? form.inputImage : null });
      },
    },
    {
      kind: 'text',
      id: 'prompt',
      label: 'Prompt',
      value: form.prompt,
      placeholder: 'Describe the video you want',
      maxLength: VIDEO_PROMPT_MAX_LENGTH,
      onChange: prompt => update({ prompt }),
    },
    ...(form.mode === 'image_to_video'
      ? [
          {
            kind: 'image' as const,
            id: 'image',
            label: 'Image',
            fileName: form.inputImage?.fileName ?? null,
            onPick: actions.pickImage,
          },
        ]
      : []),
    durationField(model, form, actions, problems),
    // Tiles need the full width; the legacy dropdowns sit side by side.
    ...(layout === 'createV2' ? output : [{ kind: 'group' as const, id: 'output', fields: output }]),
    audioField(model, form, actions),
  ];
}
