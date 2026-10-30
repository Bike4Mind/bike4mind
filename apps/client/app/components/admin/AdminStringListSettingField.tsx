import { useUpdateSettings } from '@client/app/hooks/data/settings';
import { getErrorMessage } from '@client/app/utils/error';
import type { SettingKey } from '@bike4mind/common';
import SaveIcon from '@mui/icons-material/Save';
import { Button, FormControl, FormHelperText, FormLabel, Grid, Textarea, Tooltip } from '@mui/joy';
import { useSettingsDraft } from './SettingsDraftProvider';
import { SettingsSection } from './shared/SettingsSection';
import { useRef } from 'react';
import { useAdminSaveShortcut } from './shared/adminKeyboard';

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
 * save shows its message here.
 */
const AdminStringListSettingField = ({
  setting,
  storedValue,
  index,
}: {
  setting: { key: SettingKey; name: string; description: string };
  storedValue: unknown;
  index: number;
}) => {
  const saveRef = useRef<HTMLDivElement>(null);
  useAdminSaveShortcut(saveRef);
  const stored = toStringList(storedValue);
  const updateSettings = useUpdateSettings();
  const draft = useSettingsDraft(setting.key, stored.join('\n'), {
    name: setting.name,
    equals: (left, right) => JSON.stringify(fromText(left)) === JSON.stringify(fromText(right)),
    save: text => updateSettings.mutateAsync({ key: setting.key, value: fromText(text) }),
  });
  const { value: text, setValue: setText } = draft;
  const isDirty = fromText(text).join('\n') !== stored.join('\n');
  const saveError = updateSettings.error ? getErrorMessage(updateSettings.error) : undefined;

  const handleSave = () =>
    updateSettings.mutate(
      { key: setting.key, value: fromText(text) },
      {
        onSuccess: (data: { settingValue?: unknown } | undefined) =>
          setText(toStringList(data?.settingValue).join('\n')),
      }
    );

  return (
    <SettingsSection
      variant="outlined"
      sx={{ width: '100%', mb: 1, bgcolor: index % 2 ? 'background.level1' : 'background.level2', p: 2 }}
    >
      <Grid
        ref={draft.staged ? null : saveRef}
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
        {!draft.staged && (
          <Grid xs={12} md={6} sx={{ display: 'flex', alignItems: { xs: 'flex-start', md: 'center' } }}>
            <Tooltip title="Save setting (Cmd/Ctrl+S, including from inputs)" placement="top">
              <Button
                data-testid={`admin-setting-${setting.key}-save-btn`}
                data-admin-save
                aria-label={`Save ${setting.name} (Cmd/Ctrl+S)`}
                aria-keyshortcuts="Meta+s Control+s"
                color="success"
                size="sm"
                type="button"
                loading={updateSettings.isPending}
                onClick={handleSave}
                disabled={!isDirty}
              >
                <SaveIcon sx={{ marginX: 1 }} />
              </Button>
            </Tooltip>
          </Grid>
        )}
      </Grid>
    </SettingsSection>
  );
};

export default AdminStringListSettingField;
