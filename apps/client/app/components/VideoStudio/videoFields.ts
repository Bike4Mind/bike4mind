import { VIDEO_PROMPT_MAX_LENGTH, type VideoModel } from '@bike4mind/common';
import type { CapabilityControl, CapabilityField } from '@client/app/components/Studio/capabilityFields';
import { MODE_LABELS, type VideoFormState } from './videoForm';

export type VideoFieldActions = {
  update: (patch: Partial<VideoFormState>) => void;
  pickImage: () => void;
};

const durationField = (model: VideoModel, form: VideoFormState, { update }: VideoFieldActions): CapabilityControl => {
  const label = `Duration: ${form.durationSeconds}s`;
  const { duration } = model;
  if (duration.kind === 'range') {
    return {
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
    kind: 'segmented',
    id: 'duration',
    label,
    value: String(form.durationSeconds),
    options: duration.values.map(seconds => ({ value: String(seconds), label: `${seconds}s` })),
    onChange: value => {
      const seconds = Number(value);
      if (duration.values.includes(seconds)) update({ durationSeconds: seconds });
    },
  };
};

const audioField = (model: VideoModel, form: VideoFormState, { update }: VideoFieldActions): CapabilityControl => {
  if (model.audio === 'optional' && form.audio !== null) {
    return { kind: 'switch', id: 'audio', label: 'Audio', checked: form.audio, onChange: audio => update({ audio }) };
  }
  const label = model.audio === 'always' ? 'Audio is included.' : 'This model generates video without audio.';
  return { kind: 'note', id: 'audio', label };
};

/** The video Studio controls for the selected model, in display order. */
export function videoCapabilityFields(
  model: VideoModel,
  form: VideoFormState,
  actions: VideoFieldActions
): CapabilityField[] {
  const { update } = actions;
  return [
    {
      kind: 'segmented',
      id: 'mode',
      label: 'Mode',
      value: form.mode,
      options: model.modes.map(mode => ({ value: mode, label: MODE_LABELS[mode] })),
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
    durationField(model, form, actions),
    {
      kind: 'group',
      id: 'output',
      fields: [
        {
          kind: 'select',
          id: 'aspect',
          label: 'Aspect ratio',
          value: form.aspectRatio,
          options: model.aspect_ratios.map(ratio => ({ value: ratio, label: ratio })),
          onChange: value => {
            const aspectRatio = model.aspect_ratios.find(candidate => candidate === value);
            if (aspectRatio) update({ aspectRatio });
          },
        },
        {
          kind: 'select',
          id: 'resolution',
          label: 'Resolution',
          value: form.resolution,
          options: model.resolutions.map(resolution => ({ value: resolution, label: resolution })),
          onChange: value => {
            const resolution = model.resolutions.find(candidate => candidate === value);
            if (resolution) update({ resolution });
          },
        },
      ],
    },
    audioField(model, form, actions),
  ];
}
