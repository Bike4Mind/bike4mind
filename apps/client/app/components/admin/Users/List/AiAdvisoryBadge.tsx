import { Box, Tooltip } from '@mui/joy';
import type { AiAbuseAdvisoryRow } from '@client/app/hooks/data/aiAdvisory';
import { adminFocus } from '../../shared/adminStyles';
import { StatusChip } from '../../shared/StatusChip';
import { DETECTOR_LABELS } from '../../shadowDetectorLabels';

export const AI_ADVISORY_MARK = '\u2726';

/** Hover text for an advisory: what the AI said, on which detection, and that no admin has reviewed it. */
export function aiAdvisoryTitle(advisory: AiAbuseAdvisoryRow): string {
  const probability = advisory.abuseProbability === null ? '' : ` (${Math.round(advisory.abuseProbability * 100)}%)`;
  return `AI advisory: likely abuse${probability} on an unreviewed ${DETECTOR_LABELS[advisory.detector]} detection. Advisory only; review before acting.`;
}

/** The Users list's mark for an account the AI advisory flags; see listAiAbuseAdvisories. */
export function AiAdvisoryBadge({ advisory }: { advisory: AiAbuseAdvisoryRow }) {
  const title = aiAdvisoryTitle(advisory);
  return (
    <Tooltip title={title} placement="top" enterTouchDelay={0}>
      <Box
        component="span"
        tabIndex={0}
        role="img"
        aria-label={title}
        onClick={event => event.stopPropagation()}
        sx={{ display: 'inline-flex', borderRadius: 'md', ...adminFocus }}
      >
        <StatusChip
          tone="bad"
          label={`${AI_ADVISORY_MARK} AI`}
          data-testid={`admin-users-ai-advisory-${advisory.userId}`}
        />
      </Box>
    </Tooltip>
  );
}
