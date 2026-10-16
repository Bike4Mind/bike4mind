import { useEffect, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import FormControl from '@mui/joy/FormControl';
import FormHelperText from '@mui/joy/FormHelperText';
import FormLabel from '@mui/joy/FormLabel';
import Input from '@mui/joy/Input';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Switch from '@mui/joy/Switch';
import Typography from '@mui/joy/Typography';
import type { FleetSendStatus, FleetState } from '@shared/fleet';

const STATUS_LABEL: Record<FleetSendStatus, string> = {
  'not-configured': 'Not connected',
  paused: 'Sharing off',
  active: 'Sharing',
  'reconnect-needed': 'Reconnect needed',
};

const STATUS_COLOR: Record<FleetSendStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  'not-configured': 'neutral',
  paused: 'neutral',
  active: 'success',
  'reconnect-needed': 'danger',
};

export function useFleetState(): FleetState | null {
  const [state, setState] = useState<FleetState | null>(null);
  useEffect(() => {
    let current = true;
    void window.b4m.fleet.getState().then(next => {
      if (current) setState(next);
    });
    const unsubscribe = window.b4m.fleet.onStateChanged(next => setState(next));
    return () => {
      current = false;
      unsubscribe();
    };
  }, []);
  return state;
}

/**
 * Connects this app to a Fleet and shares aggregate activity with it.
 *
 * Sharing is off until the user turns it on. What is shared is metadata only: reply and tool
 * durations, tool categories and the repository a project works in, never what was said or run.
 * The key field is write-only; the saved key is never shown again.
 */
export function FleetIntegrationCard() {
  const state = useFleetState();
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (state) setUrl(current => (current === '' ? state.url : current));
  }, [state]);

  if (!state) return null;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      const result = await window.b4m.fleet.save({ url, ...(key.trim() ? { key } : {}) });
      if (result.ok) setKey('');
      else setError(result.error);
    });

  const check = state.lastCheck;

  return (
    <Sheet variant="outlined" sx={{ borderRadius: 'sm', px: 2, py: 1.75, mb: 1.5 }} data-testid="fleet-card">
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <Typography level="title-sm" sx={{ flex: 1 }}>
          Fleet activity
        </Typography>
        <Chip size="sm" variant="soft" color={STATUS_COLOR[state.status]} data-testid="fleet-status-chip">
          {STATUS_LABEL[state.status]}
        </Chip>
      </Stack>
      <Typography level="body-xs" textColor="text.tertiary" sx={{ mb: 1.5 }}>
        Share aggregate activity with your team&apos;s Fleet: reply and tool durations, tool categories and the
        repository a project works in. Never messages, prompts, file contents, commands or paths.
      </Typography>

      <Stack spacing={1.25}>
        <FormControl size="sm">
          <FormLabel>Fleet URL</FormLabel>
          <Input
            value={url}
            onChange={event => setUrl(event.target.value)}
            placeholder={state.defaultUrl}
            slotProps={{ input: { 'data-testid': 'fleet-url-input' } }}
          />
        </FormControl>
        <FormControl size="sm">
          <FormLabel>Machine key</FormLabel>
          <Input
            type="password"
            value={key}
            onChange={event => setKey(event.target.value)}
            placeholder={state.keyConfigured ? 'Saved. Paste a new key to replace it.' : 'flmt_...'}
            autoComplete="off"
            slotProps={{ input: { 'data-testid': 'fleet-key-input' } }}
          />
          <FormHelperText>
            {state.keyStorage === 'unavailable'
              ? 'No system keychain is available, so the key is kept only until the app quits.'
              : 'Mint one in Fleet with only the bike4mind:activity:write scope. It is stored in the system keychain.'}
          </FormHelperText>
        </FormControl>

        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
          <Button size="sm" onClick={() => void save()} loading={busy} data-testid="fleet-save-btn">
            Save
          </Button>
          <Button
            size="sm"
            variant="soft"
            color="neutral"
            disabled={!state.keyConfigured || busy}
            onClick={() => void run(() => window.b4m.fleet.testConnection())}
            data-testid="fleet-test-btn"
          >
            Test connection
          </Button>
          {state.keyConfigured && (
            <Button
              size="sm"
              variant="plain"
              color="danger"
              disabled={busy}
              onClick={() => void run(() => window.b4m.fleet.forgetKey())}
              data-testid="fleet-forget-btn"
            >
              Remove key
            </Button>
          )}
        </Stack>

        {error && (
          <Alert size="sm" color="danger" variant="soft" data-testid="fleet-save-error">
            {error}
          </Alert>
        )}
        {check &&
          (check.ok ? (
            <Alert size="sm" color="success" variant="soft" data-testid="fleet-check-ok">
              Connected as {check.consumer} ({check.scopes.join(', ')})
              {check.capabilities.activityIngest ? '' : '. This Fleet does not accept activity yet.'}
            </Alert>
          ) : (
            <Alert size="sm" color="warning" variant="soft" data-testid="fleet-check-error">
              {check.error}
            </Alert>
          ))}

        <Switch
          checked={state.consent}
          disabled={busy}
          onChange={event => void run(() => window.b4m.fleet.setConsent(event.target.checked))}
          endDecorator="Share activity with Fleet"
          slotProps={{
            input: { 'aria-label': 'Share activity with Fleet', 'data-testid': 'fleet-consent-switch' } as never,
          }}
          sx={{ alignSelf: 'flex-start' }}
        />

        {state.consent && state.keyConfigured && (
          <Stack direction="row" spacing={1} alignItems="center" data-testid="fleet-queue">
            <Typography level="body-xs" textColor="text.tertiary" sx={{ flex: 1 }}>
              {state.pending} waiting to send
              {state.lastResult
                ? `. Last batch: ${state.lastResult.accepted} accepted, ${state.lastResult.duplicates} already sent`
                : ''}
              {state.lastError ? `. ${state.lastError}` : ''}
            </Typography>
            <Button
              size="sm"
              variant="soft"
              color="neutral"
              disabled={busy || state.pending === 0 || state.status !== 'active'}
              onClick={() => void run(() => window.b4m.fleet.sendNow())}
              data-testid="fleet-send-now-btn"
            >
              Send now
            </Button>
          </Stack>
        )}
      </Stack>
    </Sheet>
  );
}
