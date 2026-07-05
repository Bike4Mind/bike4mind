import { useUpdateSettings } from '@client/app/hooks/data/settings';
import { settingsMap } from '@bike4mind/common';
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
  const [focused, setFocused] = useState(false);
  const [showEmbeddingWarning, setShowEmbeddingWarning] = useState(false);

  const isDirty = value !== defaultValue;
  const isEmbeddingModelSetting = setting.key === 'defaultEmbeddingModel';

  const handleSaveSetting = () => {
    if (value === null) return;

    // Show warning for embedding model changes
    if (isEmbeddingModelSetting && isDirty) {
      setShowEmbeddingWarning(true);
      return;
    }

    // Save directly for other settings
    updateSettings.mutate({ key: setting.key, value });
  };

  const confirmEmbeddingModelChange = () => {
    if (value === null) return;
    updateSettings.mutate({ key: setting.key, value });
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
            <FormControl sx={{ width: '100%' }}>
              <FormLabel>{setting.name}</FormLabel>

              {setting.type === 'boolean' ? (
                <Switch
                  sx={{ alignSelf: 'baseline' }}
                  checked={typeof value === 'string' ? value === 'true' : (value as boolean)}
                  onChange={e => setValue(e.target.checked)}
                />
              ) : setting.type === 'number' ? (
                <Input
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
                    value={
                      setting.isSensitive && !focused && value
                        ? '••••••••••••••••••••••••••••••••••••••'
                        : (value as string) || ''
                    }
                    onChange={e => setValue(e.target.value)}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                  />
                )
              ) : null}

              <FormHelperText>{setting.description}</FormHelperText>
            </FormControl>
          </Grid>

          <Grid xs={12} md={6} sx={{ display: 'flex', alignItems: { xs: 'flex-start', md: 'center' } }}>
            <Tooltip title="Update Setting" placement="top">
              <Button
                color="success"
                size="sm"
                type="button"
                loading={updateSettings.isPending}
                onClick={handleSaveSetting}
                disabled={!isDirty}
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
