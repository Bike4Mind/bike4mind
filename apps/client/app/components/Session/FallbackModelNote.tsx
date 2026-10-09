import { FC } from 'react';
import { Box, Chip, Tooltip } from '@mui/joy';
import SwapHorizRoundedIcon from '@mui/icons-material/SwapHorizRounded';
import type { FallbackInfo } from '@bike4mind/common';
import { formatFallbackTooltip } from './fallbackProviderLabel';

/**
 * Per-turn record that another model answered, read off the persisted quest so it survives a
 * reload and a different device - unlike FallbackModelBadge, which lives in browser storage and
 * only ever shows the session's most recent fallback.
 */
export const FallbackModelNote: FC<{ fallbackInfo?: FallbackInfo }> = ({ fallbackInfo }) => {
  if (!fallbackInfo) return null;

  const summary = formatFallbackTooltip(fallbackInfo);
  const title = fallbackInfo.reason ? `${summary}. Reason: ${fallbackInfo.reason}` : summary;

  return (
    <Box data-testid="fallback-model-note" sx={{ mb: 1 }}>
      <Tooltip title={title} placement="bottom-start">
        <Chip
          data-testid="fallback-model-note-chip"
          size="sm"
          variant="soft"
          color="warning"
          startDecorator={<SwapHorizRoundedIcon sx={{ fontSize: 14 }} />}
          sx={{ fontWeight: 400 }}
        >
          {`Answered by ${fallbackInfo.fallbackModelName} - ${fallbackInfo.primaryModelName} was unavailable`}
        </Chip>
      </Tooltip>
    </Box>
  );
};

export default FallbackModelNote;
