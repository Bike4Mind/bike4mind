import { useState } from 'react';
import Alert from '@mui/joy/Alert';
import Button from '@mui/joy/Button';
import FormControl from '@mui/joy/FormControl';
import FormLabel from '@mui/joy/FormLabel';
import Input from '@mui/joy/Input';
import Option from '@mui/joy/Option';
import Select from '@mui/joy/Select';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { AuthState, EnvironmentPresetId } from '@shared/auth';

interface EnvironmentPickerProps {
  state: AuthState;
  disabled?: boolean;
}

/**
 * Endpoint picker mirroring the CLI's resolution order. Tokens are cached per normalized API
 * URL in the main process, so switching back to a backend the user already signed in to
 * restores that session rather than starting another device flow.
 */
export function EnvironmentPicker({ state, disabled }: EnvironmentPickerProps) {
  const [preset, setPreset] = useState<EnvironmentPresetId>(state.environment.preset);
  const [customUrl, setCustomUrl] = useState(state.environment.preset === 'custom' ? state.environment.url : '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const unchanged = preset === state.environment.preset && (preset !== 'custom' || customUrl === state.environment.url);

  async function apply() {
    setSaving(true);
    setError(null);
    const result = await window.b4m.auth.setEnvironment({ preset, customUrl });
    if (!result.ok) setError(result.error);
    setSaving(false);
  }

  return (
    <Stack spacing={1.5}>
      <FormControl size="sm">
        <FormLabel>Server</FormLabel>
        <Select
          value={preset}
          disabled={disabled || saving}
          onChange={(_event, value) => value && setPreset(value)}
          slotProps={{ button: { 'data-testid': 'environment-select-btn' } }}
        >
          <Option value="hosted" disabled={!state.hostedAvailable}>
            Production{state.hostedAvailable ? '' : ' (not set in this build)'}
          </Option>
          <Option value="local">Local Dev</Option>
          <Option value="custom">Self-hosted URL</Option>
        </Select>
      </FormControl>

      {preset === 'custom' && (
        <FormControl size="sm">
          <FormLabel>URL</FormLabel>
          <Input
            value={customUrl}
            placeholder="https://b4m.example.com"
            disabled={disabled || saving}
            onChange={event => setCustomUrl(event.target.value)}
            data-testid="environment-url-input"
          />
        </FormControl>
      )}

      {error && (
        <Alert color="danger" variant="soft" size="sm" data-testid="environment-error-alert">
          {error}
        </Alert>
      )}

      <Stack direction="row" spacing={1} alignItems="center">
        <Button
          size="sm"
          variant="soft"
          loading={saving}
          disabled={disabled || unchanged}
          onClick={() => void apply()}
          data-testid="environment-apply-btn"
        >
          Use this server
        </Button>
        {state.environment.url && (
          <Typography level="body-xs" fontFamily="monospace" textColor="text.tertiary">
            {state.environment.label} - {state.environment.url}
          </Typography>
        )}
      </Stack>
    </Stack>
  );
}
