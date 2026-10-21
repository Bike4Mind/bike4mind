import React from 'react';
import { Box, Chip, Stack, Typography } from '@mui/joy';
import { Timer, Warning } from '@mui/icons-material';
import HistoryIcon from '@mui/icons-material/History';
import type { ITurnTiming } from '@bike4mind/common';
import { TURN_RETRY_REASON_LABELS, formatDurationMs } from './turnTimingFormat';

/** The Answer diagnosis "Turn timing" block: where the turn's wall-clock time went. */
export function TurnTimingDetails({ timing }: { timing: ITurnTiming | undefined }) {
  return (
    <Box sx={{ mt: 2 }} data-testid="turn-timing-details">
      <Typography level="body-sm" startDecorator={<HistoryIcon />}>
        Turn timing
      </Typography>
      {timing ? (
        <Stack spacing={1}>
          <Chip size="sm" variant="soft" color="warning" startDecorator={<Timer />}>
            Total: {timing.totalMs !== undefined ? formatDurationMs(timing.totalMs) : 'still running'}
          </Chip>
          <Chip size="sm" variant="soft" color="neutral" startDecorator={<Timer />}>
            Queue: {formatDurationMs(timing.queueMs)}
          </Chip>
          <Chip size="sm" variant="soft" color="neutral" startDecorator={<Timer />}>
            Context build: {timing.contextBuildMs !== undefined ? formatDurationMs(timing.contextBuildMs) : 'N/A'}
          </Chip>
          <Chip size="sm" variant="soft" color="neutral" startDecorator={<Timer />}>
            Concurrency slot wait: {formatDurationMs(timing.semaphoreWaitMs)}
          </Chip>
          <Chip size="sm" variant="soft" color={timing.fallbackHops > 0 ? 'danger' : 'neutral'}>
            Fallback hops: {timing.fallbackHops}
          </Chip>
          {timing.retries.map((retry, index) => (
            <Chip
              key={`${retry.reason}-${index}`}
              size="sm"
              variant="soft"
              color="danger"
              startDecorator={<Warning />}
              data-testid="turn-timing-retry"
              sx={{ whiteSpace: 'normal', height: 'auto', py: 0.5 }}
            >
              {TURN_RETRY_REASON_LABELS[retry.reason] ?? retry.reason} on {retry.model}, waited{' '}
              {formatDurationMs(retry.delayMs)}
              {retry.status !== undefined && ` - HTTP ${retry.status}`}
              {retry.requestId && ` - ${retry.requestId}`}
            </Chip>
          ))}
        </Stack>
      ) : (
        <Typography level="body-xs">Not recorded for this reply.</Typography>
      )}
    </Box>
  );
}
