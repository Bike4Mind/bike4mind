import { useFloorAboveMeasuredWarning, useUpdateSettings } from '@client/app/hooks/data/settings';
import { getErrorMessage } from '@client/app/utils/error';
import { isMaskedSensitiveSettingValue, settingsMap } from '@bike4mind/common';
import WarningIcon from '@mui/icons-material/Warning';
import {
  Divider,
  FormControl,
  FormHelperText,
  FormLabel,
  Grid,
  Input,
  Option,
  Select,
  Switch,
  Alert,
  Typography,
  Stack,
  Box,
} from '@mui/joy';
import { useState, type ReactNode } from 'react';
import { SettingFieldRow } from './shared/SettingFieldRow';
import { StatusChip } from './shared/StatusChip';
import ScopedSettingOverrides from './ScopedSettingOverrides';
import { moneyChangeWarning, rangeMessage } from './settingFieldHelpers';
import { useRequiredSettingsDraft } from './SettingsDraftProvider';

interface SubSetting {
  setting: (typeof settingsMap)[keyof typeof settingsMap];
  defaultValue: string | number | boolean | object | undefined;
}

/** Inline toggle row rendered inside a parent card - no card wrapper. */
const SubSettingToggle = ({ setting, defaultValue }: SubSetting) => {
  const initialValue = (() => {
    if (typeof defaultValue === 'boolean') return defaultValue;
    if (typeof defaultValue === 'number') return defaultValue === 1;
    if (typeof defaultValue === 'string') return defaultValue === 'true' || defaultValue === '1';
    return false;
  })();
  const updateSettings = useUpdateSettings();
  const draft = useRequiredSettingsDraft('AdminSettingInputField', setting.key, initialValue, {
    name: setting.name,
    save: value => updateSettings.mutateAsync({ key: setting.key, value }),
  });
  const { value, setValue } = draft;

  return (
    <Box data-admin-settings-editor tabIndex={0} aria-label={`${setting.name} settings editor`} sx={{ py: 0.75 }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="title-md" sx={{ fontSize: '13px' }}>
            {setting.name}
          </Typography>
          <Typography level="body-xs" sx={{ color: 'text.secondary', mt: 0.25 }}>
            {setting.description}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
          <Switch checked={value} disabled={draft.pending} onChange={e => setValue(e.target.checked)} />
        </Box>
      </Box>

      {/* A scope-capable setting can be an inline child rather than a card of its own (a boolean
          whose dependsOn points into its own group - see AdminSettingsTab.renderSettingGroup), so
          the override section has to render here as well or two of the nine scope-capable settings
          would have no write surface at all. */}
      {setting.scope && <ScopedSettingOverrides setting={setting} />}
    </Box>
  );
};

const AdminSettingInputField = ({
  setting,
  defaultValue,
  subSettings,
  lockedNote,
  valueHelper,
}: {
  setting: (typeof settingsMap)[keyof typeof settingsMap];
  // null is a clearDeletesRow setting whose platform row is absent: unset, not the declared default.
  defaultValue: string | number | boolean | object | undefined | null;
  index: number;
  subSettings?: SubSetting[];
  /** Locks the setting: its control and Save are disabled and this replaces the description. */
  lockedNote?: string;
  valueHelper?: ReactNode;
}) => {
  const updateSettings = useUpdateSettings();
  const draft = useRequiredSettingsDraft<string | number | boolean | null>(
    'AdminSettingInputField',
    setting.key,
    typeof defaultValue === 'object' ? null : (defaultValue ?? null),
    {
      name: setting.name,
      equals: (left, right) => (setting.clearDeletesRow && left === '' ? null : left) === right,
      save: async next => {
        if (next === null) throw new Error('Enter a setting value before saving.');
        return updateSettings.mutateAsync({
          key: setting.key,
          value: next,
          ...(setting.isSensitive && next === '' ? { confirmClear: true } : {}),
          ...(floorWarning ? { confirmAboveMeasuredFloor: true } : {}),
        });
      },
      blocked: next =>
        lockedNote ??
        (setting.type === 'number' && next !== '' && next !== null
          ? rangeMessage(Number(next), setting.min, setting.max)
          : undefined),
      // The SaveBar commits every edit, so the price and embedding confirmations are the warnings it batches.
      warning: next =>
        setting.key === 'defaultEmbeddingModel'
          ? [
              'Changing the embedding model affects new files. Existing files may need reprocessing to restore search accuracy.',
            ]
          : setting.changesCustomerPrice
            ? [moneyChangeWarning(setting.key, setting.name, defaultValue, next)]
            : [],
    }
  );
  const { value, setValue } = draft;
  // Focus only hides the stored mask; the draft changes when the admin types, so a focused,
  // untouched secret stages nothing and an emptied one is a deliberate clear.
  const [secretFocused, setSecretFocused] = useState(false);
  const showsStoredSecretMask = setting.isSensitive === true && isMaskedSensitiveSettingValue(value);
  const isEmbeddingModelSetting = setting.key === 'defaultEmbeddingModel';
  const changesCustomerPrice = setting.changesCustomerPrice === true;

  // Only number settings declare bounds, and only some of those, so they are read through
  // the type discriminant rather than off the union.
  const bounds: { min?: number; max?: number } = setting.type === 'number' ? setting : {};
  // An emptied field is "unset", not a zero: Number('') is 0, which would report a bogus
  // below-minimum error on a bounded setting and block the save that resets it to its default.
  const rangeError =
    setting.type === 'number' && value !== null && value !== ''
      ? rangeMessage(typeof value === 'number' ? value : Number(value), bounds.min, bounds.max)
      : undefined;
  // The field names a rejected write next to the value as well as in the SaveBar.
  const saveError = updateSettings.error ? getErrorMessage(updateSettings.error) : undefined;
  const fieldError = rangeError ?? saveError;
  const floorWarning = useFloorAboveMeasuredWarning(setting.key, value);

  return (
    <SettingFieldRow
      data-admin-settings-editor
      data-testid={`admin-setting-${setting.key}-row`}
      tabIndex={0}
      aria-label={`${setting.name} settings editor`}
    >
      <Grid container spacing={2}>
        <Grid xs={12} md={6}>
          <FormControl error={Boolean(fieldError)} sx={{ width: '100%' }}>
            <FormLabel>
              {setting.name}
              {changesCustomerPrice && (
                <Box component="span" sx={{ ml: 1 }}>
                  <StatusChip
                    tone="warn"
                    label="Changes customer price"
                    data-testid={`admin-setting-${setting.key}-money-badge`}
                  />
                </Box>
              )}
            </FormLabel>

            {setting.type === 'boolean' ? (
              <Switch
                sx={{ alignSelf: 'baseline' }}
                checked={typeof value === 'string' ? value === 'true' : (value as boolean)}
                onChange={e => setValue(e.target.checked)}
                disabled={Boolean(lockedNote) || draft.pending}
                slotProps={{ input: { 'data-testid': `admin-setting-${setting.key}-switch` } }}
              />
            ) : setting.type === 'number' ? (
              <Input
                // The schema's own bounds, so the browser offers the same range the server
                // will accept rather than leaving the field unbounded.
                slotProps={{
                  input: {
                    'data-testid': `admin-setting-${setting.key}-input`,
                    min: bounds.min,
                    max: bounds.max,
                  },
                }}
                type="number"
                // clearDeletesRow with no row: the blank field is the "unset" state, not a missing
                // value. Name what it resolves to so an admin can tell it from a stored default.
                placeholder={setting.clearDeletesRow ? setting.unsetLabel : undefined}
                // A cleared field is kept as '' rather than coerced: Number('') is 0, which
                // the server would store as a real zero instead of letting makeNumberSetting's
                // empty-string preprocess fall back to the setting's own default.
                value={typeof value === 'number' ? value : value === null || value === '' ? '' : Number(value)}
                onChange={e => setValue(e.target.value === '' ? '' : Number(e.target.value))}
                // Locked during the save round-trip: the refetched setting resets this field to the
                // server's resolved value, so an edit typed mid-flight would be silently overwritten.
                disabled={Boolean(lockedNote) || updateSettings.isPending || draft.pending}
              />
            ) : setting.type === 'string' ? (
              setting.options ? (
                <Select
                  disabled={Boolean(lockedNote) || draft.pending}
                  value={(value as string) || ''}
                  onChange={(e, v) => setValue(v)}
                >
                  {Array.from(new Set(setting.options)).map((option, i) => (
                    <Option key={`setting-${setting.key}-option-${option}-${i}`} value={option}>
                      {option}
                    </Option>
                  ))}
                </Select>
              ) : (
                <Input
                  slotProps={{ input: { 'data-testid': `admin-setting-${setting.key}-input` } }}
                  // Once the admin has typed, the field holds real plaintext. main used to
                  // re-hide it on blur; keep that property by switching to a password field
                  // rather than leaving a pasted key rendered until the page is left. The
                  // server mask stays plain text so its last-4 tail is readable.
                  type={setting.isSensitive && draft.dirty ? 'password' : 'text'}
                  value={secretFocused && showsStoredSecretMask ? '' : (value as string) || ''}
                  disabled={Boolean(lockedNote) || draft.pending}
                  placeholder={setting.isSensitive ? 'Enter a new value to replace the stored secret' : undefined}
                  onChange={e => setValue(e.target.value)}
                  // A sensitive setting arrives already masked from the server, so there is
                  // nothing to reveal. Hide the mask while focused so the admin types a fresh
                  // value; an untouched blur shows it again without staging anything.
                  onFocus={() => setSecretFocused(true)}
                  onBlur={() => setSecretFocused(false)}
                />
              )
            ) : null}

            <FormHelperText data-testid={`admin-setting-${setting.key}-helper`}>
              {/* The floor warning outranks a stale save error: the draft's save sends the confirm flag
                  whenever `floorWarning` is truthy, so the warning must be the line the admin sees
                  before that save, not one hidden behind a previous failure's message. */}
              {rangeError ?? floorWarning ?? saveError ?? lockedNote ?? setting.description}
            </FormHelperText>
            {valueHelper && (
              <FormHelperText sx={{ display: 'block', color: 'admin.inkMuted' }}>{valueHelper}</FormHelperText>
            )}
          </FormControl>
        </Grid>
      </Grid>

      {/* Warning alert for embedding model changes */}
      {isEmbeddingModelSetting && draft.dirty && (
        <Alert color="warning" variant="soft" startDecorator={<WarningIcon />} sx={{ mt: 1 }}>
          <Typography level="body-sm">
            <strong>Warning:</strong> Changing the embedding model will require reprocessing all existing files for
            optimal search and analysis results. Files with mismatched embedding models will show a warning and can be
            reprocessed individually.
          </Typography>
        </Alert>
      )}

      {/* Inline sub-settings (e.g. "On by default" toggles) */}
      {subSettings && subSettings.length > 0 && (
        <>
          <Divider sx={{ my: 1 }} />
          <Stack spacing={0}>
            {subSettings.map((sub, i) => (
              <SubSettingToggle key={`${sub.setting.key}-${i}`} setting={sub.setting} defaultValue={sub.defaultValue} />
            ))}
          </Stack>
        </>
      )}

      {/* Only a setting that opts into scoping gets a write surface for the narrower rungs. */}
      {setting.scope && (
        <>
          <Divider sx={{ my: 1 }} />
          <ScopedSettingOverrides setting={setting} />
        </>
      )}
    </SettingFieldRow>
  );
};

export default AdminSettingInputField;
