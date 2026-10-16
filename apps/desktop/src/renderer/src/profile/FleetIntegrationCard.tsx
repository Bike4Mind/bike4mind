import { useEffect, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
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
    void window.b4m.fleet.refresh().then(next => {
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

/** What the card says about the installer file, when it is not simply connected. */
function connectionNote(state: FleetState): string | null {
  switch (state.connection) {
    case 'not-installed':
      return `Run your team's Fleet installer on this machine to connect it. Your install command is on your Fleet's /otel/setup page; it writes ${state.configPath}.`;
    case 'insecure':
      return `${state.configPath} is readable by other users, so it is ignored. Run the Fleet installer again to rewrite it.`;
    case 'invalid':
      return `${state.configPath} is not a Fleet connection this app can use. Run the Fleet installer again to rewrite it.`;
    case 'no-email':
      return `${state.configPath} does not say whose activity this is, so Fleet could not count it. Run the Fleet installer again and give your work email.`;
    default:
      return null;
  }
}

/**
 * Shares aggregate activity with your team's Fleet, through the connection Fleet's installer
 * sets up. Sharing is off until the user turns it on. What is shared is metadata only: reply and
 * tool durations, tool categories, the repository a project works in, and the model and credits
 * each reply used.
 */
export function FleetIntegrationCard() {
  const state = useFleetState();
  const [busy, setBusy] = useState(false);

  if (!state) return null;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const note = connectionNote(state);
  const connected = state.connection === 'connected';

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
        Share aggregate activity with your team&apos;s Fleet: reply and tool durations, tool categories, the repository
        a project works in, and the model, tokens and credits each reply used. Never messages, prompts, file contents,
        commands or paths.
      </Typography>

      <Stack spacing={1.25}>
        {connected ? (
          <Alert size="sm" color="success" variant="soft" data-testid="fleet-connection-ok">
            Connected via the Fleet installer as {state.email}
            {state.fleetUrl ? ` (${state.fleetUrl})` : ''}
          </Alert>
        ) : (
          <Alert
            size="sm"
            color={state.connection === 'not-installed' ? 'neutral' : 'warning'}
            variant="soft"
            data-testid="fleet-connection-note"
          >
            {note}
          </Alert>
        )}

        <Stack direction="row" spacing={1} alignItems="center">
          <Switch
            checked={state.consent}
            disabled={busy || !connected}
            onChange={event => void run(() => window.b4m.fleet.setConsent(event.target.checked))}
            endDecorator="Share activity with Fleet"
            slotProps={{
              input: { 'aria-label': 'Share activity with Fleet', 'data-testid': 'fleet-consent-switch' } as never,
            }}
            sx={{ flex: 1 }}
          />
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            disabled={busy}
            onClick={() => void run(() => window.b4m.fleet.refresh())}
            data-testid="fleet-refresh-btn"
          >
            Check again
          </Button>
        </Stack>

        {state.consent && connected && (
          <Stack direction="row" spacing={1} alignItems="center" data-testid="fleet-queue">
            <Typography level="body-xs" textColor="text.tertiary" sx={{ flex: 1 }}>
              {state.pending} waiting to send
              {state.lastResult ? `. Last batch: ${state.lastResult.sent} sent` : ''}
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
