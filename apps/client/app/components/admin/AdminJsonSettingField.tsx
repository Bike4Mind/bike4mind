import { useUpdateSettings } from '@client/app/hooks/data/settings';
import { getErrorMessage } from '@client/app/utils/error';
import type { SettingKey } from '@bike4mind/common';
import SaveIcon from '@mui/icons-material/Save';
import { Button, FormControl, FormHelperText, FormLabel, Grid, Textarea, Tooltip } from '@mui/joy';
import { useSettingsDraft } from './SettingsDraftProvider';
import { SettingsSection } from './shared/SettingsSection';
import { useRef } from 'react';
import { useAdminSaveShortcut } from './shared/adminKeyboard';

type SettingValue = Parameters<ReturnType<typeof useUpdateSettings>['mutateAsync']>[0]['value'];
// Typed as the hook's value only for transport: the server parses it with the setting's schema.
type Parsed = { ok: true; value: SettingValue } | { ok: false };

const parse = (text: string): Parsed => {
  try {
    return { ok: true, value: JSON.parse(text) as SettingValue };
  } catch {
    return { ok: false };
  }
};

/** The stored value, which arrives as an object or as its JSON string, as indented JSON text. */
export function toJsonText(stored: unknown): string {
  const parsed: { ok: true; value: unknown } | { ok: false } =
    typeof stored === 'string' ? parse(stored) : { ok: true, value: stored };
  return JSON.stringify(parsed.ok ? (parsed.value ?? {}) : {}, null, 2);
}

const canonical = (text: string) => {
  const parsed = parse(text);
  return parsed.ok ? JSON.stringify(parsed.value) : text;
};

const INVALID_JSON = 'Enter valid JSON before saving.';

/**
 * Editor for a structured object setting (an operator config such as abuseAssessmentConfig): the
 * value as JSON text. The server parses it with the setting's schema and fills defaults, so a
 * refused save shows its message here and a saved one comes back normalized.
 */
const AdminJsonSettingField = ({
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
  const stored = toJsonText(storedValue);
  const updateSettings = useUpdateSettings();
  const draft = useSettingsDraft(setting.key, stored, {
    name: setting.name,
    equals: (left, right) => canonical(left) === canonical(right),
    save: text => {
      const parsed = parse(text);
      if (!parsed.ok) throw new Error(INVALID_JSON);
      return updateSettings.mutateAsync({ key: setting.key, value: parsed.value });
    },
    blocked: text => (parse(text).ok ? undefined : INVALID_JSON),
  });
  const { value: text, setValue: setText } = draft;
  const parsed = parse(text);
  const isDirty = canonical(text) !== canonical(stored);
  const error = parsed.ok ? (updateSettings.error ? getErrorMessage(updateSettings.error) : undefined) : INVALID_JSON;

  const handleSave = () => {
    if (!parsed.ok) return;
    updateSettings.mutate(
      { key: setting.key, value: parsed.value },
      { onSuccess: (data: { settingValue?: unknown } | undefined) => setText(toJsonText(data?.settingValue)) }
    );
  };

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
          <FormControl error={Boolean(error)} sx={{ width: '100%' }}>
            <FormLabel>{setting.name}</FormLabel>
            <Textarea
              minRows={4}
              sx={{ fontFamily: 'code' }}
              slotProps={{ textarea: { 'data-testid': `admin-setting-${setting.key}-input`, spellCheck: false } }}
              value={text}
              onChange={e => setText(e.target.value)}
              disabled={updateSettings.isPending || draft.pending}
            />
            <FormHelperText data-testid={`admin-setting-${setting.key}-helper`}>
              {error ?? setting.description}
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
                disabled={!isDirty || !parsed.ok}
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

export default AdminJsonSettingField;
