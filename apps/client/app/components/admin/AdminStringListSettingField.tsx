import { useUpdateSettings } from '@client/app/hooks/data/settings';
import { getErrorMessage } from '@client/app/utils/error';
import type { SettingKey } from '@bike4mind/common';
import { FormControl, FormHelperText, FormLabel, Grid, Textarea } from '@mui/joy';
import { useRequiredSettingsDraft } from './SettingsDraftProvider';
import { SettingFieldRow } from './shared/SettingFieldRow';

/** Parses the stored value, which arrives as an array or as its JSON string, into its string entries. */
export function toStringList(stored: unknown): string[] {
  let value = stored;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

const fromText = (text: string) =>
  text
    .split(/[\n,]/)
    .map(entry => entry.trim())
    .filter(Boolean);

/**
 * Editor for a string-list object setting: one entry per line. The generic AdminSettingInputField
 * renders no input for object settings. The server validates and normalizes the list, so a refused
 * save shows its message here. Saves through the page SaveBar, so it renders inside a SettingsDraftProvider.
 */
const AdminStringListSettingField = ({
  setting,
  storedValue,
}: {
  setting: { key: SettingKey; name: string; description: string };
  storedValue: unknown;
  index: number;
}) => {
  const stored = toStringList(storedValue);
  const updateSettings = useUpdateSettings();
  const draft = useRequiredSettingsDraft('AdminStringListSettingField', setting.key, stored.join('\n'), {
    name: setting.name,
    equals: (left, right) => JSON.stringify(fromText(left)) === JSON.stringify(fromText(right)),
    save: text => updateSettings.mutateAsync({ key: setting.key, value: fromText(text) }),
  });
  const { value: text, setValue: setText } = draft;
  const saveError = updateSettings.error ? getErrorMessage(updateSettings.error) : undefined;

  return (
    <SettingFieldRow data-testid={`admin-setting-${setting.key}-row`}>
      <Grid
        data-admin-settings-editor
        tabIndex={0}
        aria-label={`${setting.name} settings editor`}
        container
        spacing={2}
      >
        <Grid xs={12} md={6}>
          <FormControl error={Boolean(saveError)} sx={{ width: '100%' }}>
            <FormLabel>{setting.name}</FormLabel>
            <Textarea
              minRows={2}
              slotProps={{ textarea: { 'data-testid': `admin-setting-${setting.key}-input` } }}
              value={text}
              onChange={e => setText(e.target.value)}
              disabled={updateSettings.isPending || draft.pending}
            />
            <FormHelperText data-testid={`admin-setting-${setting.key}-helper`}>
              {saveError ?? setting.description}
            </FormHelperText>
          </FormControl>
        </Grid>
      </Grid>
    </SettingFieldRow>
  );
};

export default AdminStringListSettingField;
