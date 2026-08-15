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
  health: Pick<LakeHealthApiResponse, 'reachableShare' | 'predicates'>,
  /**
   * Files that failed before producing any chunk (`countFailedFilesByScope`). Health and this count
   * partition the lake on the SAME field in opposite directions - health takes `chunkCount > 0`, the
   * failed count takes `chunkCount <= 0` - so every file here is invisible to every predicate above.
   * Without this the two render side by side in one chip row and can contradict each other: a lake
   * with 12 files that failed at upload shows a green "Reachable 100%" next to a red "12 failed",
   * because the 100% is computed over the 88 that survived. Both numbers are individually true, which
   * is exactly what makes the pair misleading - and a green headline over unusable content is the
   * failure this feature exists to prevent. The count never makes the badge healthier.
   */
  failedFileCount = 0
): BadgeLevel {
  const { reachableShare, predicates } = health;
  const anyMemberPredicateFails =
    predicates.chunkWithinPolicy.fail > 0 ||
    predicates.chunkCountConsistent.fail > 0 ||
    predicates.fullyVectorized.fail > 0;
  // Known defects are graded BEFORE the null-share early return, so a real problem never hides behind
  // the neutral "not measured" chip (the mistake B4 caught for P4, generalized to every predicate):
  //  - P4 (serve cap below policy) is a lake-level POLICY fact needing no measurement - and since every
  //    lake reads unmeasured until the backfill runs, an org with an oversized DefaultChunkSize would
  //    otherwise hide the defect on every one of its lakes.
  //  - A failing per-file predicate (an oversized chunk on a still-indexing file, say) is a known fact
  //    too; with nothing measurable yet the share is unknown, but "degraded" beats "not measured".
  if (predicates.serveCapMeetsPolicy === 'fail') return 'unhealthy';
  if (reachableShare === null) return anyMemberPredicateFails || failedFileCount > 0 ? 'degraded' : 'unknown';
  if (reachableShare < 0.5) return 'unhealthy';
  if (reachableShare < 0.95 || anyMemberPredicateFails || failedFileCount > 0) return 'degraded';
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
  if (health.reachableShare === null) {
    // Nothing is measured, so never render a share ("Reachable 0%" - Math.round(null) - would misread
    // as "nothing is reachable"). The level still carries a known defect: P4 -> unhealthy, a failing
    // per-file predicate -> degraded; only a truly clean-but-unmeasured lake is "not measured".
    if (level === 'unhealthy') return 'Serve cap below policy';
    if (level === 'degraded') return 'Health: needs attention';
    return 'Health: not measured';
  }
  return `Reachable ${pct(health.reachableShare)}`;
}

const DRILLDOWN_ROWS = 8;

function HealthTooltip({ health, failedFileCount = 0 }: { health: LakeHealthApiResponse; failedFileCount?: number }) {
  const { predicates, coverage, affectedMembers, affectedMemberCount } = health;
  const measuredGap = coverage.membersWithChunks - coverage.measuredMembers;
  const anyMemberFails =
    predicates.chunkWithinPolicy.fail > 0 ||
    predicates.chunkCountConsistent.fail > 0 ||
    predicates.fullyVectorized.fail > 0;
  return (
    <Box sx={{ p: 0.5, maxWidth: 340 }}>
      <Typography level="body-xs" sx={{ fontWeight: 'lg' }}>
        {health.reachableShare !== null
          ? `${pct(health.reachableShare)} of chunked content is reachable by search.`
          : predicates.serveCapMeetsPolicy === 'fail'
            ? 'Serve cap is below the policy size - in-policy chunks are clipped before the model sees them.'
            : anyMemberFails
              ? 'Some files have retrievability issues; the reachable share is not measured yet.'
              : 'Not yet measured - run indexing to measure this lake.'}
      </Typography>
      {measuredGap > 0 && (
        <Typography level="body-xs" sx={{ mt: 0.25, color: 'text.tertiary' }}>
          Measured over {coverage.measuredMembers} of {coverage.membersWithChunks} files.
        </Typography>
      )}
      {failedFileCount > 0 && (
        <Typography level="body-xs" sx={{ mt: 0.25, color: 'danger.400' }}>
          {failedFileCount} file(s) failed before producing any chunk and are not counted in the share above.
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
        {/* JS string literal, not JSX text, so the middot is written as its unicode escape to stay
            ASCII-only per CLAUDE.md (an &middot; entity would not resolve inside a string). */}
        {predicates.serveCapMeetsPolicy === 'fail' && ' \u00B7 Serve cap below policy'}
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

export default function LakeHealthBadge({ lakeId, failedFileCount = 0 }: { lakeId: string; failedFileCount?: number }) {
  // The badge only mounts inside the lake detail view, so the query is already scoped to "open"; no
  // `enabled` gate is needed here.
  const { data: health, isLoading } = useGetDataLakeHealth(lakeId);
  // No content to grade (empty lake) or the feature/endpoint declined: render nothing rather than a
  // misleading "unknown" chip. isLoading is silent for the same reason - the badge is advisory.
  if (isLoading || !health || health.coverage.membersWithChunks === 0) return null;

  const level = deriveLakeHealthBadge(health, failedFileCount);
  return (
    <Tooltip title={<HealthTooltip health={health} failedFileCount={failedFileCount} />} size="sm" variant="outlined" arrow>
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
