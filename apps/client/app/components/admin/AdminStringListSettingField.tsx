import { useUpdateSettings } from '@client/app/hooks/data/settings';
import { getErrorMessage } from '@client/app/utils/error';
import type { SettingKey } from '@bike4mind/common';
import SaveIcon from '@mui/icons-material/Save';
import { Button, Card, FormControl, FormHelperText, FormLabel, Grid, Textarea, Tooltip } from '@mui/joy';
import { useState } from 'react';

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
  const stored = toStringList(storedValue);
  const [text, setText] = useState(stored.join('\n'));
  const updateSettings = useUpdateSettings();
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
    <Card
      variant="outlined"
      sx={{ width: '100%', mb: 1, bgcolor: index % 2 ? 'background.level1' : 'background.level2', p: 2 }}
    >
      <Grid container spacing={2}>
        <Grid xs={12} md={6}>
          <FormControl error={Boolean(saveError)} sx={{ width: '100%' }}>
            <FormLabel>{setting.name}</FormLabel>
            <Textarea
              minRows={2}
              slotProps={{ textarea: { 'data-testid': `admin-setting-${setting.key}-input` } }}
              value={text}
              onChange={e => setText(e.target.value)}
              disabled={updateSettings.isPending}
            />
            <FormHelperText data-testid={`admin-setting-${setting.key}-helper`}>
              {saveError ?? setting.description}
            </FormHelperText>
          </FormControl>
        </Grid>
        <Grid xs={12} md={6} sx={{ display: 'flex', alignItems: { xs: 'flex-start', md: 'center' } }}>
          <Tooltip title="Update Setting" placement="top">
            <Button
              data-testid={`admin-setting-${setting.key}-save-btn`}
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
      </Grid>
    </Card>
  );
};

export default AdminStringListSettingField;
