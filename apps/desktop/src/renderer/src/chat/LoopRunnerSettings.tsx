import { useEffect, useState } from 'react';
import Button from '@mui/joy/Button';
import Option from '@mui/joy/Option';
import Select from '@mui/joy/Select';
import Stack from '@mui/joy/Stack';
import Switch from '@mui/joy/Switch';
import Typography from '@mui/joy/Typography';
import type { LoopApprovalMode, LoopRunnerSettings as Settings, LoopRunnerState } from '@shared/loopRunner';

const LANE_CHOICES = [1, 2, 3, 4];

export function loopRunnerSummary(state: LoopRunnerState | null): string {
  if (!state) return 'Run tickets of loop stages set to run on this computer.';
  if (!state.settings.enabled) return 'Off. Loop stages set to run on this computer wait for it.';
  if (state.tickets.length > 0)
    return `Working on ${state.tickets.length} ticket${state.tickets.length === 1 ? '' : 's'}.`;
  return state.waitingReason ? `Waiting: ${state.waitingReason}.` : 'On, waiting for tickets.';
}

export function useLoopRunnerState() {
  const [state, setState] = useState<LoopRunnerState | null>(null);
  useEffect(() => {
    // Optional: builds and tests without the runner have no loopRunner surface.
    const api = window.b4m?.loopRunner;
    if (!api) return;
    let live = true;
    void api.getState().then(next => live && setState(next));
    const off = api.onStateChanged(next => setState(next));
    return () => {
      live = false;
      off();
    };
  }, []);
  return [state, setState] as const;
}

export function LoopRunnerSettings({
  state,
  onState,
}: {
  state: LoopRunnerState | null;
  onState: (state: LoopRunnerState) => void;
}) {
  const [modes, setModes] = useState<Record<string, LoopApprovalMode>>({});
  const [error, setError] = useState<string | null>(null);
  if (!state) return null;
  const api = window.b4m.loopRunner;

  const set = (patch: Partial<Settings>) => void api.setSettings(patch).then(onState);
  const approve = async (loop: LoopRunnerState['pendingApprovals'][number]) => {
    setError(null);
    const result = await api.approve({ ...loop, approvalMode: modes[loop.loopId] ?? 'auto' });
    if (result.ok) onState(result.state);
    else setError(result.error);
  };

  return (
    <Stack spacing={1.5} data-testid="loop-runner-settings">
      <Switch
        size="sm"
        checked={state.settings.enabled}
        disabled={!state.signedIn}
        onChange={event => set({ enabled: event.target.checked })}
        endDecorator="Run loop tickets on this computer"
        sx={{ alignSelf: 'flex-start' }}
        slotProps={{ input: { 'data-testid': 'loop-runner-enabled-switch' } }}
      />
      {!state.signedIn && <Typography level="body-xs">Sign in to run loop tickets.</Typography>}
      {state.server && (
        <Typography level="body-xs" data-testid="loop-runner-server">
          Server: {state.server}
        </Typography>
      )}
      {state.settings.enabled && (
        <Typography level="body-xs" data-testid="loop-runner-lanes">
          {state.lanes.busy} of {state.lanes.cap} lanes busy
          {state.waitingReason ? ` - waiting: ${state.waitingReason}` : ''}
        </Typography>
      )}
      {state.error && (
        <Typography level="body-xs" color="danger" role="alert" data-testid="loop-runner-error">
          {state.error}
        </Typography>
      )}

      {state.tickets.map(ticket => (
        <Stack key={ticket.runId} direction="row" spacing={1} alignItems="center" data-testid="loop-runner-ticket">
          <Typography level="body-sm" sx={{ flex: 1 }}>
            {ticket.loopName}: {ticket.title} ({ticket.stage})
          </Typography>
          <Button
            size="sm"
            variant="plain"
            disabled={!state.server}
            onClick={() =>
              void window.b4m.shell.openExternal(
                `${state.server}/loops/${encodeURIComponent(ticket.loopId)}?run=${encodeURIComponent(ticket.runId)}`
              )
            }
            data-testid="loop-runner-open-run-btn"
          >
            Open run in web
          </Button>
        </Stack>
      ))}

      {state.pendingApprovals.map(loop => (
        <Stack key={loop.loopId} direction="row" spacing={1} alignItems="center" data-testid="loop-runner-pending">
          <Typography level="body-sm" sx={{ flex: 1 }}>
            {loop.loopName}
            {loop.repoHint ? ` (${loop.repoHint})` : ''} has work for this computer
          </Typography>
          <Select
            size="sm"
            value={modes[loop.loopId] ?? 'auto'}
            onChange={(_event, value) => value && setModes(current => ({ ...current, [loop.loopId]: value }))}
            slotProps={{ button: { 'aria-label': `Approval mode for ${loop.loopName}` } }}
          >
            <Option value="auto">Auto</Option>
            <Option value="full">Full</Option>
          </Select>
          <Button size="sm" onClick={() => void approve(loop)} data-testid="loop-runner-approve-btn">
            Approve and pick folder
          </Button>
        </Stack>
      ))}
      {error && (
        <Typography level="body-xs" color="danger" role="alert" data-testid="loop-runner-approve-error">
          {error}
        </Typography>
      )}

      {state.policies.map(policy => (
        <Stack key={policy.loopId} direction="row" spacing={1} alignItems="center" data-testid="loop-runner-policy">
          <Typography level="body-sm" sx={{ flex: 1 }}>
            {policy.loopName} in {policy.directory} ({policy.approvalMode})
          </Typography>
          <Button
            size="sm"
            variant="soft"
            color="danger"
            onClick={() => void api.revoke(policy.loopId).then(onState)}
            data-testid="loop-runner-revoke-btn"
          >
            Revoke
          </Button>
        </Stack>
      ))}

      <Switch
        size="sm"
        checked={state.settings.runOnBattery}
        onChange={event => set({ runOnBattery: event.target.checked })}
        endDecorator="Run on battery"
        sx={{ alignSelf: 'flex-start' }}
        slotProps={{ input: { 'data-testid': 'loop-runner-battery-switch' } }}
      />
      <Switch
        size="sm"
        checked={state.openAtLogin}
        onChange={event => void api.setOpenAtLogin(event.target.checked).then(onState)}
        endDecorator="Open at login"
        sx={{ alignSelf: 'flex-start' }}
        slotProps={{ input: { 'data-testid': 'loop-runner-login-switch' } }}
      />
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography level="body-sm">At most</Typography>
        <Select
          size="sm"
          value={state.settings.laneCap ?? 0}
          onChange={(_event, value) => value !== null && set({ laneCap: value || undefined })}
          slotProps={{ button: { 'aria-label': 'Lane cap', 'data-testid': 'loop-runner-lane-cap' } }}
        >
          <Option value={0}>As many as the machine allows</Option>
          {LANE_CHOICES.map(count => (
            <Option key={count} value={count}>
              {count} at a time
            </Option>
          ))}
        </Select>
      </Stack>
    </Stack>
  );
}
