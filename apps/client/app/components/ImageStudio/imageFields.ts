import {
  IMAGE_JOB_PROMPT_MAX_CHARS,
  SCENE_PRESETS,
  SCENE_SWATCHES,
  appliedScenePreset,
  applyScenePreset,
  type ImageModels,
  type OpenAIImageQuality,
} from '@bike4mind/common';
import {
  withCurrentValue,
  type CapabilityControl,
  type CapabilityField,
  type CapabilityOption,
  type ChipsField,
} from '@client/app/components/Studio/capabilityFields';
import { STUDIO_IMAGE_COUNT_MAX } from '@client/app/hooks/data/studioImageJobs';
import {
  imageAspectRatioOptions,
  imageFieldProblems,
  imageQualityOptions,
  imageReferenceMax,
  imageSizeOptions,
  type ImageIntent,
} from './imageModelOptions';

export type ImageFormState = { prompt: string; count: number; intent: ImageIntent };

export type ImageFieldActions = {
  update: (patch: Partial<ImageFormState>) => void;
  updateIntent: (patch: Partial<ImageIntent>) => void;
  pickReference: () => void;
};

// The option value for "leave it to the model"; the intent then omits the setting.
const MODEL_DEFAULT = '';
const USE_MODEL_DEFAULT = 'Use the model default';

const QUALITY_LABELS: Record<OpenAIImageQuality, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  auto: 'Auto',
  standard: 'Standard',
  hd: 'HD',
};

const COUNT_OPTIONS: readonly CapabilityOption[] = Array.from({ length: STUDIO_IMAGE_COUNT_MAX }, (_, index) => ({
  value: String(index + 1),
  label: String(index + 1),
}));

const withDefault = (label: string, values: readonly string[], labelOf: (value: string) => string = value => value) => [
  { value: MODEL_DEFAULT, label },
  ...values.map(value => ({ value, label: labelOf(value) })),
];

/**
 * A setting's control: shown when the model offers the setting, or when the form holds a value for it that the model
 * does not take, so the value is marked with its reason rather than hidden or dropped.
 */
const shown = (offered: readonly unknown[], current: string | undefined, problem: string | undefined): boolean =>
  offered.length > 0 || (current !== undefined && problem !== undefined);

const isQuality = (model: ImageModels, value: string): value is OpenAIImageQuality =>
  imageQualityOptions(model).some(quality => quality === value);

const settingFields = (model: ImageModels, intent: ImageIntent, actions: ImageFieldActions): CapabilityControl[] => {
  const problems = imageFieldProblems(model, intent);
  const reset = (patch: Partial<ImageIntent>) => ({
    label: USE_MODEL_DEFAULT,
    apply: () => actions.updateIntent(patch),
  });
  const aspectRatios = imageAspectRatioOptions(model);
  const sizes = imageSizeOptions(model);
  const qualities = imageQualityOptions(model);
  const referenceMax = imageReferenceMax(model);
  const fields: CapabilityControl[] = [];

  if (shown(aspectRatios, intent.aspectRatio, problems.aspect)) {
    fields.push({
      kind: 'aspect',
      id: 'aspect',
      label: 'Aspect ratio',
      value: intent.aspectRatio ?? MODEL_DEFAULT,
      options: withCurrentValue(withDefault('Auto', aspectRatios), intent.aspectRatio ?? MODEL_DEFAULT),
      onChange: value => actions.updateIntent({ aspectRatio: value || undefined }),
      ...(problems.aspect && { invalidReason: problems.aspect, fix: reset({ aspectRatio: undefined }) }),
    });
  }

  if (shown(qualities, intent.quality, problems.quality)) {
    const current = intent.quality ?? MODEL_DEFAULT;
    fields.push({
      kind: 'segmented',
      id: 'quality',
      label: 'Quality',
      value: current,
      options: withCurrentValue(
        withDefault('Default', qualities, value => (isQuality(model, value) ? QUALITY_LABELS[value] : value)),
        current,
        intent.quality ? QUALITY_LABELS[intent.quality] : current
      ),
      onChange: value => actions.updateIntent({ quality: isQuality(model, value) ? value : undefined }),
      ...(problems.quality && { invalidReason: problems.quality, fix: reset({ quality: undefined }) }),
    });
  }

  if (shown(sizes, intent.size, problems.size)) {
    fields.push({
      kind: 'select',
      id: 'size',
      label: 'Size',
      value: intent.size ?? MODEL_DEFAULT,
      options: withCurrentValue(withDefault('Default', sizes), intent.size ?? MODEL_DEFAULT),
      onChange: value => actions.updateIntent({ size: value || undefined }),
      ...(problems.size && { invalidReason: problems.size, fix: reset({ size: undefined }) }),
    });
  }

  if (referenceMax > 0 || intent.references.length > 0) {
    const kept = intent.references.slice(0, referenceMax);
    fields.push({
      kind: 'references',
      id: 'references',
      label: 'Reference images',
      files: intent.references,
      max: Math.max(referenceMax, intent.references.length),
      onAdd: actions.pickReference,
      onRemove: fileId =>
        actions.updateIntent({ references: intent.references.filter(file => file.fileId !== fileId) }),
      ...(problems.references && {
        invalidReason: problems.references,
        fix: {
          label: kept.length === 0 ? 'Remove them' : `Keep the first ${kept.length}`,
          apply: () => actions.updateIntent({ references: kept }),
        },
      }),
    });
  }

  return fields;
};

/**
 * The scene presets as chips. The selected chip is read from the prompt itself, so editing a preset's words away
 * clears it; picking one adds its words to the user's own. A chip whose words would not fit in the prompt is disabled.
 */
const lookField = (prompt: string, actions: ImageFieldActions): ChipsField => {
  const promptWith = (presetId: string | null) =>
    applyScenePreset(
      prompt,
      SCENE_PRESETS.find(preset => preset.id === presetId)
    );
  const fits = (next: string) => next.length <= IMAGE_JOB_PROMPT_MAX_CHARS;
  const selected = appliedScenePreset(prompt)?.id ?? null;

  return {
    kind: 'chips',
    id: 'look',
    label: 'Look',
    value: selected,
    options: SCENE_PRESETS.map(preset => ({
      value: preset.id,
      label: preset.name,
      swatch: SCENE_SWATCHES[preset.swatch],
      disabled: preset.id !== selected && !fits(promptWith(preset.id)),
    })),
    onChange: presetId => {
      const next = promptWith(presetId);
      if (fits(next)) actions.update({ prompt: next });
    },
  };
};

/** The image Create controls for the selected model, in display order. */
export function imageCapabilityFields(
  model: ImageModels,
  form: ImageFormState,
  actions: ImageFieldActions
): CapabilityField[] {
  return [
    {
      kind: 'text',
      id: 'prompt',
      label: 'Prompt',
      value: form.prompt,
      placeholder: 'Describe the image you want',
      maxLength: IMAGE_JOB_PROMPT_MAX_CHARS,
      onChange: prompt => actions.update({ prompt }),
    },
    lookField(form.prompt, actions),
    ...settingFields(model, form.intent, actions),
    {
      kind: 'segmented',
      id: 'count',
      label: 'Images',
      value: String(form.count),
      options: COUNT_OPTIONS,
      onChange: value => actions.update({ count: Number(value) }),
    },
  ];
}
