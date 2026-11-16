import { FormControl, FormHelperText, FormLabel } from '@mui/joy';
import { settingsMap } from '@bike4mind/common';
import { useSettingsDraft } from '../../SettingsDraftProvider';
import { SegmentedControl } from '../../shared';
import { useUpdateSettings } from '@client/app/hooks/data/settings';
import { MODEL_SETTING_CHOICES, MODEL_SETTING_CHOICE_COPY, type ChoiceSettingKey } from './modelSettingsKeys';

/** One enum-valued setting as a segmented control with plain labels; the stored value stays the enum value. */
export function ModelSettingChoiceField({ settingKey, stored }: { settingKey: ChoiceSettingKey; stored: unknown }) {
  const updateSettings = useUpdateSettings();
  const { label, description } = MODEL_SETTING_CHOICE_COPY[settingKey];
  const baseline = typeof stored === 'string' ? stored : String(settingsMap[settingKey].defaultValue);
  const draft = useSettingsDraft(settingKey, baseline, {
    name: label,
    save: value => updateSettings.mutateAsync({ key: settingKey, value }),
  });
  const testId = `models-settings-${settingKey}`;

  return (
    <FormControl data-testid={`${testId}-field`} sx={{ gap: 0.5 }}>
      <FormLabel id={`${testId}-label`}>{label}</FormLabel>
      <SegmentedControl
        options={MODEL_SETTING_CHOICES[settingKey]}
        value={draft.value}
        onChange={draft.setValue}
        aria-label={label}
        data-testid={testId}
      />
      <FormHelperText>{description}</FormHelperText>
    </FormControl>
  );
}
