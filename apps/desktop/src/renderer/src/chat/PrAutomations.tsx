import { useState } from 'react';
import Checkbox from '@mui/joy/Checkbox';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { PrActionResult, PrBarState, PrOption } from '@shared/pullRequest';

/** One line under the auto-merge box saying who merges and what it is waiting for. */
export function autoMergeDescription(state: PrBarState): string {
  const who =
    state.autoMerge.mode === 'desktop'
      ? 'This app merges once it is approved, every check has passed and there are no conflicts, while the app is running.'
      : 'Armed on GitHub, which merges once branch protection is satisfied.';
  return state.autoMerge.note ? `${who} ${state.autoMerge.note}` : who;
}

/** One line under the auto-fix box: what it is doing now, and how many attempts are left. */
export function autoFixDescription(state: PrBarState): string {
  const { status, attempts, max, note } = state.autoFix;
  if (note) return note;
  if (status === 'exhausted') return `Gave up after ${max} attempts. Re-check the box to allow more.`;
  return `Watching for failed checks and new review comments. ${attempts} of ${max} attempts used.`;
}

/**
 * The automation checkboxes under the popover's divider. Each one is consent for this PR only,
 * and each change is confirmed by main before the box moves: the box shows what main holds.
 */
export function PrAutomations({
  state,
  onSetOption,
}: {
  state: PrBarState;
  onSetOption: (option: PrOption, enabled: boolean) => Promise<PrActionResult>;
}) {
  const [busy, setBusy] = useState<PrOption | null>(null);
  const [error, setError] = useState<string | null>(null);
  const binding = state.binding;
  if (!binding) return null;

  const toggle = (option: PrOption, enabled: boolean) => {
    setBusy(option);
    setError(null);
    void onSetOption(option, enabled)
      .then(result => setError(result.ok ? null : result.error))
      .finally(() => setBusy(null));
  };

  const snapshot = state.snapshot;
  const noMethod = !!snapshot && snapshot.repoSettings.allowedMethods.length === 0;

  return (
    <Stack spacing={0.75} data-testid="pr-ci-automations">
      <Checkbox
        size="sm"
        label="Auto-fix CI & address comments"
        checked={binding.autoFix === true}
        disabled={busy !== null}
        onChange={event => toggle('autoFix', event.target.checked)}
        slotProps={{ input: { 'data-testid': 'pr-ci-autofix-checkbox' } }}
      />
      {binding.autoFix && (
        <Typography
          level="body-xs"
          textColor={state.autoFix.status === 'exhausted' ? 'warning.plainColor' : 'text.tertiary'}
          sx={{ pl: 3.5 }}
          data-testid="pr-ci-autofix-note"
        >
          {autoFixDescription(state)}
        </Typography>
      )}
      <Checkbox
        size="sm"
        label="Auto-merge when ready"
        checked={binding.autoMerge === true}
        disabled={busy !== null || noMethod}
        onChange={event => toggle('autoMerge', event.target.checked)}
        slotProps={{ input: { 'data-testid': 'pr-ci-automerge-checkbox' } }}
      />
      {binding.autoMerge && (
        <Typography level="body-xs" textColor="text.tertiary" sx={{ pl: 3.5 }} data-testid="pr-ci-automerge-note">
          {autoMergeDescription(state)}
        </Typography>
      )}
      <Checkbox
        size="sm"
        label="Auto-archive on merge or close"
        checked={binding.autoArchive === true}
        disabled={busy !== null}
        onChange={event => toggle('autoArchive', event.target.checked)}
        slotProps={{ input: { 'data-testid': 'pr-ci-autoarchive-checkbox' } }}
      />
      {error && (
        <Typography level="body-xs" textColor="danger.plainColor" data-testid="pr-ci-option-error">
          {error}
        </Typography>
      )}
    </Stack>
  );
}
