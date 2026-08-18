import { useUpdateSettings } from '@client/app/hooks/data/settings';
import { getErrorMessage } from '@client/app/utils/error';
import { isMaskedSensitiveSettingValue, settingsMap } from '@bike4mind/common';
import SaveIcon from '@mui/icons-material/Save';
import WarningIcon from '@mui/icons-material/Warning';
import {
  Button,
  Card,
  Divider,
  FormControl,
  FormHelperText,
  FormLabel,
  Grid,
  Input,
  Option,
  Select,
  Switch,
  Tooltip,
  Alert,
  Modal,
  ModalDialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Typography,
  Stack,
  Box,
} from '@mui/joy';
import { useState } from 'react';

interface SubSetting {
  setting: (typeof settingsMap)[keyof typeof settingsMap];
  defaultValue: string | number | boolean | object | undefined;
}

/** Inline toggle row rendered inside a parent card - no card wrapper. */
const SubSettingToggle = ({ setting, defaultValue }: SubSetting) => {
  const [value, setValue] = useState<boolean>(() => {
    if (typeof defaultValue === 'boolean') return defaultValue;
    if (typeof defaultValue === 'number') return defaultValue === 1;
    if (typeof defaultValue === 'string') return defaultValue === 'true' || defaultValue === '1';
    return false;
  });
  const updateSettings = useUpdateSettings();
  const resolvedDefault =
    typeof defaultValue === 'boolean'
      ? defaultValue
      : typeof defaultValue === 'number'
        ? defaultValue === 1
        : defaultValue === 'true' || defaultValue === '1';
  const isDirty = value !== resolvedDefault;

  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2, py: 0.75 }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography level="title-md" sx={{ fontSize: '13px' }}>
          {setting.name}
        </Typography>
        <Typography level="body-xs" sx={{ color: 'text.secondary', mt: 0.25 }}>
          {setting.description}
        </Typography>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
        <Switch checked={value} onChange={e => setValue(e.target.checked)} />
        {isDirty && (
          <Tooltip title="Save" placement="top">
            <Button
              color="success"
              size="sm"
              loading={updateSettings.isPending}
              onClick={() => updateSettings.mutate({ key: setting.key, value })}
            >
              <SaveIcon sx={{ fontSize: '16px' }} />
            </Button>
          </Tooltip>
        )}
      </Box>
    </Box>
  );
};

/**
 * Why the server would refuse this number, in the words the field shows. The setting's own
 * schema carries the same bounds (makeNumberSetting in @bike4mind/common), and the update
 * route parses with it directly, so an out-of-range value comes back as an untranslated
 * ZodError: without this the admin sees Save do nothing and is told nothing.
 */
const rangeMessage = (value: number, min?: number, max?: number): string | undefined => {
  const inRange = (min === undefined || value >= min) && (max === undefined || value <= max);
  if (!Number.isNaN(value) && inRange) return undefined;
  if (min !== undefined && max !== undefined) return `Enter a number between ${min} and ${max}.`;
  if (min !== undefined) return `Enter a number of ${min} or more.`;
  if (max !== undefined) return `Enter a number of ${max} or less.`;
  return 'Enter a number.';
};

const AdminSettingInputField = ({
  setting,
  index,
  defaultValue,
  subSettings,
}: {
  setting: (typeof settingsMap)[keyof typeof settingsMap];
  defaultValue: string | number | boolean | object | undefined;
  index: number;
  subSettings?: SubSetting[];
}) => {
  const [value, setValue] = useState<string | number | boolean | null>(() => {
    if (typeof defaultValue === 'object') return null;
    return defaultValue ?? null;
  });
  const updateSettings = useUpdateSettings();
  const [showEmbeddingWarning, setShowEmbeddingWarning] = useState(false);
  // Whether the admin actually typed into a sensitive field, as opposed to the field
  // being emptied by focus clearing the mask. Distinguishes a deliberate "unset this
  // key" from an accidental empty write - see the guard in saveValue.
  const [secretEdited, setSecretEdited] = useState(false);

  // A sensitive field sitting empty purely because focus cleared its mask is not an edit,
  // so Save stays disabled. Without this the field reads as dirty the moment it is focused
  // and an empty write becomes one click away (saveValue guards the write itself as well).
  const isUntouchedClearedSecret = setting.isSensitive === true && value === '' && !secretEdited;
  const isDirty = value !== defaultValue && !isUntouchedClearedSecret;
  const showsStoredSecretMask = setting.isSensitive === true && isMaskedSensitiveSettingValue(value);
  const isEmbeddingModelSetting = setting.key === 'defaultEmbeddingModel';

  // Only number settings declare bounds, and only some of those, so they are read through
  // the type discriminant rather than off the union.
  const bounds: { min?: number; max?: number } = setting.type === 'number' ? setting : {};
  const rangeError =
    setting.type === 'number' && value !== null
      ? rangeMessage(typeof value === 'number' ? value : Number(value), bounds.min, bounds.max)
      : undefined;
  // A rejected write is otherwise silent: the mutation surfaces nothing of its own and the
  // Save button simply stops spinning.
  const saveError = updateSettings.error ? getErrorMessage(updateSettings.error) : undefined;
  const fieldError = rangeError ?? saveError;

  const saveValue = (next: string | number | boolean) => {
    // Backstop, intentionally unreachable while isDirty excludes the untouched-empty state
    // above. Kept because it does not depend on event ordering: the dirty check protects the
    // button, this protects the write, so loosening one cannot silently expose ''.
    // Do not delete as redundant. The original rationale cited macOS Safari and Firefox not
    // blurring the input before a save click; that was measured and is wrong - both do blur
    // on the button's mousedown and restore the mask. No browser is known to skip the blur,
    // but nothing in the DOM contract guarantees it either.
    if (setting.isSensitive && next === '' && !secretEdited) return;

    updateSettings.mutate(
      // An empty value on a sensitive setting destroys a live credential, so the server
      // requires the intent to be explicit rather than inferred from an absent value.
      { key: setting.key, value: next, ...(setting.isSensitive && next === '' ? { confirmClear: true } : {}) },
      {
        // Drop the typed plaintext as soon as it is stored: the server answers a sensitive
        // write with the mask, which is all this field should ever hold afterwards.
        onSuccess: (data: { settingValue?: unknown } | undefined) => {
          setSecretEdited(false);
          if (setting.isSensitive && typeof data?.settingValue === 'string') setValue(data.settingValue);
        },
      }
    );
  };

  const handleSaveSetting = () => {
    if (value === null || rangeError) return;

    // Show warning for embedding model changes
    if (isEmbeddingModelSetting && isDirty) {
      setShowEmbeddingWarning(true);
      return;
    }

    // Save directly for other settings
    saveValue(value);
  };

  const confirmEmbeddingModelChange = () => {
    if (value === null) return;
    saveValue(value);
    setShowEmbeddingWarning(false);
  };

  return (
    <>
      <Card
        variant="outlined"
        sx={{ width: '100%', mb: 1, bgcolor: index % 2 ? 'background.level1' : 'background.level2', p: 2 }}
      >
        <Grid container spacing={2}>
          <Grid xs={12} md={6}>
            <FormControl error={Boolean(fieldError)} sx={{ width: '100%' }}>
              <FormLabel>{setting.name}</FormLabel>

              {setting.type === 'boolean' ? (
                <Switch
                  sx={{ alignSelf: 'baseline' }}
                  checked={typeof value === 'string' ? value === 'true' : (value as boolean)}
                  onChange={e => setValue(e.target.checked)}
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
                  value={typeof value === 'number' ? value : Number(value)}
                  onChange={e => setValue(Number(e.target.value))}
                />
              ) : setting.type === 'string' ? (
                setting.options ? (
                  <Select value={(value as string) || ''} onChange={(e, v) => setValue(v)}>
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
                    type={setting.isSensitive && secretEdited ? 'password' : 'text'}
                    value={(value as string) || ''}
                    placeholder={setting.isSensitive ? 'Enter a new value to replace the stored secret' : undefined}
                    onChange={e => {
                      setValue(e.target.value);
                      if (setting.isSensitive) setSecretEdited(true);
                    }}
                    // A sensitive setting arrives already masked from the server, so there is
                    // nothing to reveal. Clear the mask on focus so the admin types a fresh
                    // value, and restore it on an untouched blur so the field stays non-dirty.
                    // A field the admin deliberately emptied is left alone - that is a clear.
                    onFocus={() => {
                      if (showsStoredSecretMask) setValue('');
                    }}
                    onBlur={() => {
                      if (setting.isSensitive && value === '' && !secretEdited) {
                        setValue((defaultValue as string) ?? '');
                      }
                    }}
                  />
                )
              ) : null}

              <FormHelperText data-testid={`admin-setting-${setting.key}-helper`}>
                {fieldError ?? setting.description}
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
                onClick={handleSaveSetting}
                disabled={!isDirty || Boolean(rangeError)}
              >
                <SaveIcon sx={{ marginX: 1 }} />
              </Button>
            </Tooltip>
          </Grid>
        </Grid>

        {/* Warning alert for embedding model changes */}
        {isEmbeddingModelSetting && isDirty && (
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
                <SubSettingToggle
                  key={`${sub.setting.key}-${i}`}
                  setting={sub.setting}
                  defaultValue={sub.defaultValue}
                />
              ))}
            </Stack>
          </>
        )}
      </Card>

      {/* Confirmation Modal for Embedding Model Changes */}
      <Modal open={showEmbeddingWarning} onClose={() => setShowEmbeddingWarning(false)}>
        <ModalDialog variant="outlined" role="alertdialog">
          <DialogTitle>
            <WarningIcon color="warning" sx={{ mr: 1 }} />
            Confirm Embedding Model Change
          </DialogTitle>
          <DialogContent>
            <Stack spacing={2}>
              <Typography level="body-md">
                You are about to change the default embedding model from{' '}
                <strong>{typeof defaultValue === 'object' ? 'N/A' : String(defaultValue)}</strong> to{' '}
                <strong>{value}</strong>.
              </Typography>
              <Alert color="warning" variant="soft">
                <Typography level="body-sm">
                  <strong>Important:</strong> This change will affect how new files are processed. Existing files that
                  were processed with a different embedding model may show reduced search accuracy until they are
                  reprocessed with the new model.
                </Typography>
              </Alert>
              <Typography level="body-sm">
                Files with mismatched embedding models will display a warning icon and can be reprocessed individually
                through the session interface.
              </Typography>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              variant="solid"
              color="warning"
              onClick={confirmEmbeddingModelChange}
              loading={updateSettings.isPending}
            >
              Change Embedding Model
            </Button>
            <Button
              variant="plain"
              color="neutral"
              onClick={() => setShowEmbeddingWarning(false)}
              disabled={updateSettings.isPending}
            >
              Cancel
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </>
  );
};

export default AdminSettingInputField;
