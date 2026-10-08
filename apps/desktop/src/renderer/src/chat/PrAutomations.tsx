import { useState } from 'react';
import Checkbox from '@mui/joy/Checkbox';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { PrActionResult, PrBarState, PrOption } from '@shared/pullRequest';

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

  return (
    <Stack spacing={0.75} data-testid="pr-ci-automations">
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
