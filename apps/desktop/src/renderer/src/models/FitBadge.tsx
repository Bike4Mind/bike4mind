import Chip from '@mui/joy/Chip';
import Tooltip from '@mui/joy/Tooltip';
import type { FitLevel, ModelFit } from '@shared/models';

const LABELS: Record<FitLevel, string> = { fits: 'Fits', tight: 'Tight', 'too-large': 'Will not fit' };
const COLORS = { fits: 'success', tight: 'warning', 'too-large': 'danger' } as const;

/**
 * Fits, tight or will not fit on this computer, with the reason on hover or focus. `bare` drops the tooltip where
 * the reason is printed beside the badge, so screen readers do not hear it twice.
 */
export function FitBadge({ fit, bare = false }: { fit: ModelFit | null | undefined; bare?: boolean }) {
  if (!fit) return null;
  const chip = (
    <Chip
      size="sm"
      variant="soft"
      color={COLORS[fit.level]}
      tabIndex={bare ? undefined : 0}
      data-testid="models-fit-badge"
      data-level={fit.level}
      data-basis={fit.basis}
    >
      {LABELS[fit.level]}
    </Chip>
  );
  if (bare) return chip;
  return (
    <Tooltip title={fit.detail} size="sm" variant="outlined" placement="top" sx={{ maxWidth: 320 }} describeChild>
      {chip}
    </Tooltip>
  );
}
