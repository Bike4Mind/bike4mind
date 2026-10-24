import React from 'react';
import { IconButton, Stack, Tooltip, Typography } from '@mui/joy';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import type { ITurnTiming } from '@bike4mind/common';
import { copyTextWithToast } from '@client/app/utils/copyToClipboard';
import { isNotableTurn, summarizeTurnTiming } from './turnTimingFormat';

/**
 * Footnote under a reply that retried, fell back or ran slow, with a copyable turn ID (the quest
 * id) so a "this was slow" report maps straight to the quest's turnTiming record.
 */
export function TurnTimingNotice({
  questId,
  timing,
}: {
  questId: string | undefined;
  timing: ITurnTiming | undefined;
}) {
  if (!questId || !isNotableTurn(timing)) return null;

  return (
    <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mt: 0.5 }} data-testid="turn-timing-notice">
      <Typography level="body-xs" textColor="text.secondary">
        {summarizeTurnTiming(timing)}
      </Typography>
      <Tooltip title="Copy turn ID for support" size="sm">
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label="Copy turn ID"
          data-testid="turn-timing-copy-id-btn"
          onClick={() => copyTextWithToast(questId, 'Turn ID copied')}
          sx={{ '--IconButton-size': '22px' }}
        >
          <ContentCopyIcon sx={{ fontSize: 14 }} />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}
