import { Stack, Typography } from '@mui/joy';
import { DLQ_MAX_REPLAY_ATTEMPTS, requiresDlqReplayReason } from '@bike4mind/common';
import type { DlqQueueInfo } from '@client/app/hooks/data/dlqManagement';

export const DlqReplaySummary = ({
  queue,
  count,
  batch = false,
}: {
  queue: DlqQueueInfo | null;
  count: number;
  batch?: boolean;
}) => (
  <Stack gap={1} data-testid="dlq-replay-summary">
    <Typography level="body-sm">
      Feature: {queue?.displayName ?? 'Unknown'}. Count: {batch ? 'up to ' : ''}
      {count}.
    </Typography>
    <Typography level="body-sm">
      Messages are sent to the source queue for reprocessing and removed from the dead-letter queue after a successful
      send.
    </Typography>
    <Typography level="body-sm">{queue?.description ?? 'Feature behavior is not recorded.'}</Typography>
    <Typography level="body-sm">
      {queue?.replayNote ?? 'Replay side effects are not recorded. Inspect the consumer before replaying.'}
    </Typography>
    {requiresDlqReplayReason(queue?.replay) && (
      <Typography level="body-sm">
        A reason is required because replay can have side effects or its safety is unknown.
      </Typography>
    )}
    <Typography level="body-xs">
      Messages with {DLQ_MAX_REPLAY_ATTEMPTS} or more recorded replay attempts are skipped. Replay cannot be undone.
    </Typography>
  </Stack>
);
