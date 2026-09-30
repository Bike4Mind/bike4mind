import { useState } from 'react';
import Alert from '@mui/joy/Alert';
import Button from '@mui/joy/Button';
import FormControl from '@mui/joy/FormControl';
import FormHelperText from '@mui/joy/FormHelperText';
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

/** What the apply button switches to, phrased to match the option the Select is showing. */
const TARGET_NAMES: Record<EnvironmentPresetId, string> = {
  hosted: 'Production',
  local: 'Local Dev',
  custom: 'this URL',
};

/**
 * Endpoint picker mirroring the CLI's resolution order. Tokens are cached per normalized API
 * URL in the main process, so switching back to a backend the user already signed in to
 * restores that session rather than starting another device flow.
 *
 * The Select holds a pending choice while `state.environment` is the live one, so whenever the
 * apply button is enabled those two name different servers. The live one is therefore captioned
 * and kept on the Select rather than sitting unlabelled beside the control that replaces it.
 */
export function EnvironmentPicker({ state, disabled }: EnvironmentPickerProps) {
  const [preset, setPreset] = useState<EnvironmentPresetId>(state.environment.preset);
  const [customUrl, setCustomUrl] = useState(state.environment.preset === 'custom' ? state.environment.url : '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const unchanged = preset === state.environment.preset && (preset !== 'custom' || customUrl === state.environment.url);
  // `unconfigured` reports a preset with an empty url, which `unchanged` reads as "nothing to
  // do" - true, but it is not the same as being on that server, and must not be captioned so.
  const active = state.environment.url ? state.environment : null;

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
        <FormHelperText data-testid="environment-active-text">
          {active ? (
            <span>
              Now using {active.label} -{' '}
              <Typography component="span" fontFamily="monospace" fontSize="inherit" textColor="inherit">
                {active.url}
              </Typography>
            </span>
          ) : (
            'No server is set yet. Pick one and apply it.'
          )}
        </FormHelperText>
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

      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Button
          size="sm"
          variant="soft"
          loading={saving}
          disabled={disabled || unchanged}
          onClick={() => void apply()}
          data-testid="environment-apply-btn"
        >
          Switch to {TARGET_NAMES[preset]}
        </Button>
        {unchanged && active && (
          <Typography level="body-xs" textColor="text.tertiary" data-testid="environment-unchanged-text">
            Already the server in use.
          </Typography>
        )}
      </Stack>
    </Stack>
  );
}
