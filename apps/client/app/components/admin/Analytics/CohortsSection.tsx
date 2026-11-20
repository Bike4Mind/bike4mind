import { Box, Skeleton, Typography } from '@mui/joy';
import {
  COHORT_WEEK_OFFSETS,
  type AnalyticsCohorts,
  type CohortCell,
  type CohortRow,
} from '@client/app/utils/analyticsCohorts';
import type { AnalyticsSignupsMode } from '@client/app/utils/analyticsOverview';
import { DataTable, EmptyState, ErrorState, SectionCard, type DataColumn } from '../shared';
import { formatCount, formatDayLabel, formatPercent } from './analyticsFormat';
import { useAnalyticsCohorts } from './useAnalyticsCohorts';

// Five opacity steps of the one accent hue, capped at 50% so the printed number keeps 4.5:1 on both schemes.
const RAMP_ALPHA = [0.08, 0.18, 0.28, 0.38, 0.5] as const;
export const rampStep = (percent: number) =>
  Math.min(RAMP_ALPHA.length - 1, Math.max(0, Math.floor(percent / (100 / RAMP_ALPHA.length))));

function CellValue({ cell, size, offset }: { cell: CohortCell | null; size: number | null; offset: number }) {
  // A gap stays blank: the week is not over, a rollup day is missing, or the cohort is empty.
  if (!cell) return null;
  const step = rampStep(cell.percent);
  return (
    <Box
      component="span"
      title={`${formatCount(cell.active)} of ${formatCount(size)} users active in week ${offset}`}
      data-testid="analytics-cohort-cell"
      data-step={step}
      sx={{
        display: 'block',
        px: 1,
        py: 0.5,
        borderRadius: 'sm',
        textAlign: 'right',
        color: 'admin.ink',
        fontVariantNumeric: 'tabular-nums',
        bgcolor: `color-mix(in srgb, var(--joy-palette-admin-accent) ${Math.round(RAMP_ALPHA[step] * 100)}%, transparent)`,
      }}
    >
      {formatPercent(cell.percent)}
    </Box>
  );
}

const columns: DataColumn<CohortRow>[] = [
  { id: 'week', label: 'Signup week (UTC)', render: row => `${formatDayLabel(row.week)} (Mon)`, width: '9rem' },
  { id: 'size', label: 'Cohort size', numeric: true, render: row => formatCount(row.size), width: '6rem' },
  ...Array.from({ length: COHORT_WEEK_OFFSETS }, (_, offset): DataColumn<CohortRow> => ({
    id: `week${offset}`,
    label: `Week ${offset}`,
    numeric: true,
    render: row => <CellValue cell={row.cells[offset] ?? null} size={row.size} offset={offset} />,
  })),
];

function describe(data: AnalyticsCohorts): string {
  const who = data.signupsMode === 'legit' ? 'signups that are not suspected' : 'all signups';
  return `Share of each signup week's ${who} who were active in week N after signing up. Weeks start on Monday (UTC); a blank cell is a week that is not over yet or that has no rollup.`;
}

/** Weekly retention cohorts (spec 4.6) over the rollups, honoring the page's Signups toggle. */
export function CohortsSection({ signups }: { signups: AnalyticsSignupsMode }) {
  const { data, isPending, isError, refetch } = useAnalyticsCohorts(signups);
  const loading = isPending && !isError;
  const onRetry = () => void refetch();
  const hasCohorts = !!data && data.cohorts.some(row => row.size !== null && row.size > 0);

  let body;
  if (loading) {
    body = (
      <Skeleton
        variant="rectangular"
        height={240}
        data-testid="analytics-cohorts-skeleton"
        sx={{ borderRadius: 'md' }}
      />
    );
  } else if (isError || !data) {
    body = <ErrorState message="Could not load retention cohorts." onRetry={onRetry} />;
  } else if (!hasCohorts) {
    body = (
      <EmptyState
        title="No cohorts yet"
        description="Cohorts appear once the nightly rollup has covered a full signup week."
        action={null}
      />
    );
  } else {
    body = (
      <>
        <DataTable
          rows={data.cohorts}
          columns={columns}
          getRowId={row => row.week}
          label="Weekly retention cohorts"
          onRetry={onRetry}
          pagination={false}
          minWidth="56rem"
          maxHeight="none"
          testId="analytics-cohorts-table"
          rowTestId={row => `analytics-cohort-row-${row.week}`}
        />
        {data.missingDays.length > 0 && (
          <Typography level="body-xs" sx={{ color: 'admin.inkMuted', mt: 1 }} data-testid="analytics-cohorts-missing">
            {`Rollup is missing for ${data.missingDays.length} ${data.missingDays.length === 1 ? 'day' : 'days'}; the cells that depend on ${data.missingDays.length === 1 ? 'it are' : 'them are'} blank.`}
          </Typography>
        )}
      </>
    );
  }

  return (
    <SectionCard title="Retention cohorts" body="custom" data-testid="analytics-cohorts">
      <Box sx={{ px: 2, py: 1.75, minWidth: 0 }}>
        {data && hasCohorts && (
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted', mb: 1.5 }} data-testid="analytics-cohorts-caption">
            {describe(data)}
          </Typography>
        )}
        {body}
      </Box>
    </SectionCard>
  );
}
