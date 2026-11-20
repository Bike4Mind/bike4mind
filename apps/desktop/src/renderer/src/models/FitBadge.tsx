import Box from '@mui/joy/Box';
import Chip from '@mui/joy/Chip';
import Tooltip from '@mui/joy/Tooltip';
import type { FitLevel, ModelFit } from '@shared/models';
import { WarningIcon } from '../chat/icons';

const LABELS: Record<FitLevel, string> = { fits: 'Fits', tight: 'Tight', 'too-large': 'Will not fit' };
const COLORS = { fits: 'success', tight: 'warning', 'too-large': 'danger' } as const;

/**
 * Fits, tight or will not fit on this computer, with the reason on hover or focus. `bare` drops the tooltip where
 * the reason is printed beside the badge, so screen readers do not hear it twice. A `warning` adds a flag and follows
 * the reason, so the verdict and its color stay as rated.
 */
export function FitBadge({ fit, bare = false }: { fit: ModelFit | null | undefined; bare?: boolean }) {
  if (!fit) return null;
  const flag = fit.warning ? (
    <Box
      component="span"
      role="img"
      aria-label="Warning"
      sx={{ display: 'inline-flex', color: 'warning.plainColor' }}
      data-testid="models-fit-warning-flag"
    >
      <WarningIcon />
    </Box>
  ) : undefined;
  const chip = (
    <Chip
      size="sm"
      variant="soft"
      color={COLORS[fit.level]}
      tabIndex={bare ? undefined : 0}
      endDecorator={flag}
      data-testid="models-fit-badge"
      data-level={fit.level}
      data-basis={fit.basis}
      data-warning={fit.warning ? 'true' : undefined}
    >
      {LABELS[fit.level]}
    </Chip>
  );
  if (bare) return chip;
  // A string title stays in the closed chip's title attribute, so the reason is read without opening it.
  const title = fit.warning ? `${fit.detail}\n${fit.warning}` : fit.detail;
  return (
    <Tooltip
      title={title}
      size="sm"
      variant="outlined"
      placement="top"
      sx={{ maxWidth: 320, whiteSpace: 'pre-line' }}
      describeChild
    >
      {chip}
    </Tooltip>
  );
}
