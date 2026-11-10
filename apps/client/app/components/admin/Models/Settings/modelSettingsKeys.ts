import type { SettingKey } from '@bike4mind/common';

/** The setting keys the Models > Settings section edits, in display order, grouped as it renders them. */
export const MODEL_SETTINGS_GROUP_KEYS = {
  discovery: [
    'enableModelDiscovery',
    'modelDiscoveryMode',
    'modelDiscoveryAutoEnable',
    'modelDiscoveryAllowEgress',
    'modelDiscoveryPriceBandPct',
    'modelDiscoveryAutoRemap',
    'modelDiscoveryProbeNewModels',
  ],
  defaults: ['DefaultAPIModel', 'recommendedModelIds'],
  freeTier: ['freeTierModelGateEnabled', 'freeTierModelGateScope', 'freeTierAllowedModels'],
  generation: ['videoGeneration', 'musicGeneration'],
} as const satisfies Record<string, readonly SettingKey[]>;

/**
 * Edited only in Models > Settings; Admin Settings hides them and links there. The operations, image and speech
 * models have no setting key (they use /api/admin/operations-model).
 */
export const MODEL_SETTINGS_ONLY_KEYS: ReadonlySet<SettingKey> = new Set<SettingKey>(
  Object.values(MODEL_SETTINGS_GROUP_KEYS).flat()
);

export type ChoiceOption = { value: string; label: string };

/** Plain wording for the enum-valued model settings (docs/admin-models-spec.md sections 5.3 and 5.8). */
export const MODEL_SETTING_CHOICES = {
  modelDiscoveryMode: [
    { value: 'report', label: 'Report only' },
    { value: 'write', label: 'Writes changes' },
  ],
  modelDiscoveryAutoEnable: [
    { value: 'priced', label: 'New models listed when priced' },
    { value: 'manual', label: 'New models wait for approval' },
    { value: 'all', label: 'New models listed automatically' },
  ],
  modelDiscoveryAutoRemap: [
    { value: 'suggest', label: 'Suggest a replacement' },
    { value: 'apply', label: 'Apply the replacement' },
  ],
  freeTierModelGateScope: [
    { value: 'all', label: 'All models' },
    { value: 'media', label: 'Media models only' },
  ],
} as const satisfies Partial<Record<SettingKey, readonly ChoiceOption[]>>;

export type ChoiceSettingKey = keyof typeof MODEL_SETTING_CHOICES;

export const MODEL_SETTING_CHOICE_COPY: Record<ChoiceSettingKey, { label: string; description: string }> = {
  modelDiscoveryMode: {
    label: 'Discovery mode',
    description:
      'Report only runs the full check and saves nothing but the run report. Writes changes applies what it finds to the model catalog.',
  },
  modelDiscoveryAutoEnable: {
    label: 'New-model policy',
    description:
      'When a newly found model becomes available to users. A model with no dispatch profile is never listed, whatever the policy.',
  },
  modelDiscoveryAutoRemap: {
    label: 'Replacement for retired models',
    description:
      'What discovery does with the successor it picks for a model it retires. Applying one needs the replacement to be active, on the same backend, and no more expensive.',
  },
  freeTierModelGateScope: {
    label: 'Gate scope',
    description:
      'All models: anything outside the allowed list is paid-only. Media models only: text models stay open to free accounts and only media models need the list or a paid plan.',
  },
};
