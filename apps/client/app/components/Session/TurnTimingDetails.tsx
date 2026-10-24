import React from 'react';
import { Box, Chip, Stack, Typography } from '@mui/joy';
import Timer from '@mui/icons-material/Timer';
import Warning from '@mui/icons-material/Warning';
import HistoryIcon from '@mui/icons-material/History';
import type { ITurnTiming } from '@bike4mind/common';
import { TURN_RETRY_REASON_LABELS } from './turnTimingFormat';
import { formatDuration } from './formatDuration';

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
            Total: {timing.totalMs !== undefined ? formatDuration(timing.totalMs) : 'still running'}
          </Chip>
          <Chip size="sm" variant="soft" color="neutral" startDecorator={<Timer />}>
            Queue: {formatDuration(timing.queueMs)}
          </Chip>
          <Chip size="sm" variant="soft" color="neutral" startDecorator={<Timer />}>
            Context build: {timing.contextBuildMs !== undefined ? formatDuration(timing.contextBuildMs) : 'N/A'}
          </Chip>
          <Chip size="sm" variant="soft" color="neutral" startDecorator={<Timer />}>
            Concurrency slot wait: {formatDuration(timing.semaphoreWaitMs)}
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
              {formatDuration(retry.delayMs)}
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
