import type { ReactNode } from 'react';
import { Box, Chip, Divider, Tooltip, Typography } from '@mui/joy';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import WarningIcon from '@mui/icons-material/Warning';
import ErrorIcon from '@mui/icons-material/Error';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import type { LakeHealthApiResponse, LakeHealthPredicate } from '@bike4mind/common';
import { useGetDataLakeHealth } from '@client/app/hooks/data/dataLakes';

/**
 * Three-state lake-health badge + reachable-content headline + affected-member drill-down (#1666).
 *
 * The API reports the four predicates as RAW results; the badge level is DERIVED here, so the
 * contract stays stable when this presentation changes. Report-only: it describes retrievability, it
 * never blocks anything.
 */

type BadgeLevel = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

/** Human labels for the four predicates - the drill-down names which each member fails. */
const PREDICATE_LABEL: Record<LakeHealthPredicate, string> = {
  chunkWithinPolicy: 'Oversized chunk',
  chunkCountConsistent: 'Under-chunked',
  fullyVectorized: 'Not fully vectorized',
  serveCapMeetsPolicy: 'Serve cap below policy',
};

/**
 * Derive the badge from the raw report. Pure and exported so the thresholds are testable and live in
 * ONE place. `unknown` (nothing measured yet - the char backfill has not reached this lake) is
 * deliberately distinct from a real low score, so a lake pending measurement never reads as broken. A
 * serve-cap-below-policy (P4) defect is structural and lake-wide, so it is never "healthy".
 */
export function deriveLakeHealthBadge(
  health: Pick<LakeHealthApiResponse, 'reachableShare' | 'predicates'>
): BadgeLevel {
  const { reachableShare, predicates } = health;
  if (reachableShare === null) return 'unknown';
  const anyPredicateFails =
    predicates.chunkWithinPolicy.fail > 0 ||
    predicates.chunkCountConsistent.fail > 0 ||
    predicates.fullyVectorized.fail > 0 ||
    predicates.serveCapMeetsPolicy === 'fail';
  if (reachableShare < 0.5 || predicates.serveCapMeetsPolicy === 'fail') return 'unhealthy';
  if (reachableShare < 0.95 || anyPredicateFails) return 'degraded';
  return 'healthy';
}

const LEVEL_COLOR: Record<BadgeLevel, 'success' | 'warning' | 'danger' | 'neutral'> = {
  healthy: 'success',
  degraded: 'warning',
  unhealthy: 'danger',
  unknown: 'neutral',
};
const LEVEL_ICON: Record<BadgeLevel, ReactNode> = {
  healthy: <CheckCircleIcon sx={{ fontSize: 12 }} />,
  degraded: <WarningIcon sx={{ fontSize: 12 }} />,
  unhealthy: <ErrorIcon sx={{ fontSize: 12 }} />,
  unknown: <HelpOutlineIcon sx={{ fontSize: 12 }} />,
};

const pct = (share: number) => `${Math.round(share * 100)}%`;

/** The chip label leads with the ONE headline metric: reachable content share (#1666). */
function badgeLabel(level: BadgeLevel, health: LakeHealthApiResponse): string {
  if (level === 'unknown') return 'Health: not measured';
  return `Reachable ${pct(health.reachableShare as number)}`;
}

const DRILLDOWN_ROWS = 8;

function HealthTooltip({ health }: { health: LakeHealthApiResponse }) {
  const { predicates, coverage, affectedMembers, affectedMemberCount } = health;
  const measuredGap = coverage.membersWithChunks - coverage.measuredMembers;
  return (
    <Box sx={{ p: 0.5, maxWidth: 340 }}>
      <Typography level="body-xs" sx={{ fontWeight: 'lg' }}>
        {health.reachableShare === null
          ? 'Not yet measured - run indexing to measure this lake.'
          : `${pct(health.reachableShare)} of chunked content is reachable by search.`}
      </Typography>
      {measuredGap > 0 && (
        <Typography level="body-xs" sx={{ mt: 0.25, color: 'text.tertiary' }}>
          Measured over {coverage.measuredMembers} of {coverage.membersWithChunks} files.
        </Typography>
      )}
      {health.scanTruncated && (
        <Typography level="body-xs" sx={{ mt: 0.25, color: 'warning.400' }}>
          Large lake: figures cover the first {coverage.membersWithChunks} files.
        </Typography>
      )}
      <Divider sx={{ my: 0.5 }} />
      <Typography level="body-xs">
        Oversized chunks: {predicates.chunkWithinPolicy.fail} &middot; Under-chunked:{' '}
        {predicates.chunkCountConsistent.fail} &middot; Unvectorized: {predicates.fullyVectorized.fail}
        {predicates.serveCapMeetsPolicy === 'fail' && ' · Serve cap below policy'}
      </Typography>
      {affectedMembers.length > 0 && (
        <>
          <Divider sx={{ my: 0.5 }} />
          <Typography level="body-xs" sx={{ fontWeight: 'lg', mb: 0.25 }}>
            Affected files
          </Typography>
          {affectedMembers.slice(0, DRILLDOWN_ROWS).map(m => (
            <Typography key={m.fabFileId} level="body-xs" sx={{ color: 'text.secondary' }} noWrap>
              {m.fileName ?? m.fabFileId}: {m.failed.map(f => PREDICATE_LABEL[f]).join(', ')}
            </Typography>
          ))}
          {affectedMemberCount > DRILLDOWN_ROWS && (
            <Typography level="body-xs" sx={{ color: 'text.tertiary', mt: 0.25 }}>
              +{affectedMemberCount - DRILLDOWN_ROWS} more affected
            </Typography>
          )}
        </>
      )}
    </Box>
  );
}

export default function LakeHealthBadge({ lakeId, enabled = true }: { lakeId: string; enabled?: boolean }) {
  const { data: health, isLoading } = useGetDataLakeHealth(lakeId, enabled);
  // No content to grade (empty lake) or the feature/endpoint declined: render nothing rather than a
  // misleading "unknown" chip. isLoading is silent for the same reason - the badge is advisory.
  if (isLoading || !health || health.coverage.membersWithChunks === 0) return null;

  const level = deriveLakeHealthBadge(health);
  return (
    <Tooltip title={<HealthTooltip health={health} />} size="sm" variant="outlined" arrow>
      <Chip
        size="sm"
        variant="soft"
        color={LEVEL_COLOR[level]}
        startDecorator={LEVEL_ICON[level]}
        sx={{ fontSize: '11px', cursor: 'default' }}
        data-testid={`datalake-health-badge-${lakeId}`}
      >
        {badgeLabel(level, health)}
      </Chip>
    </Tooltip>
  );
}
