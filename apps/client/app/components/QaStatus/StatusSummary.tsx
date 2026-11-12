import { FC } from 'react';
import { Alert, Box, Card, Chip, Divider, Stack, Typography } from '@mui/joy';
import type { QaE2eStats, QaLatencyStats, QaSummary, QaSummaryRow } from '@client/app/hooks/data/qaStatus';

/** 0.98765 -> "98.8%"; null -> "-". */
export function formatPercent(rate: number | null): string {
  return rate === null ? '-' : `${(rate * 100).toFixed(1)}%`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const e2eLine = (s: QaE2eStats) => `${s.cleanRuns} of ${plural(s.runs, 'run')} with no failures`;
const latencyLine = (s: QaLatencyStats) => `${s.passedRuns} of ${plural(s.runs, 'run')} passed`;

const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

const Figure: FC<{ label: string; value: string; detail: string; testId: string }> = ({
  label,
  value,
  detail,
  testId,
}) => (
  <Box data-testid={testId} sx={{ minWidth: 0 }}>
    <Typography level="body-xs" textTransform="uppercase" fontWeight="lg">
      {label}
    </Typography>
    <Typography level="h3">{value}</Typography>
    <Typography level="body-sm">{detail}</Typography>
  </Box>
);

const Row: FC<{ row: QaSummaryRow }> = ({ row }) => (
  <Stack
    data-testid="qa-summary-row"
    direction="row"
    flexWrap="wrap"
    alignItems="center"
    useFlexGap
    columnGap={1}
    rowGap={0.25}
  >
    <Typography level="body-sm" fontWeight="md">
      {row.suite}
    </Typography>
    <Chip size="sm" variant="soft" color={row.trigger === 'scheduled' ? 'primary' : 'neutral'}>
      {row.triggerLabel}
    </Chip>
    <Typography level="body-sm" sx={{ ml: 'auto', textAlign: 'right' }}>
      {row.kind === 'e2e'
        ? `${formatPercent(row.stats.passRate)} . ${e2eLine(row.stats)}`
        : `${formatPercent(row.stats.checkRate)} within limit . ${latencyLine(row.stats)}`}
    </Typography>
  </Stack>
);

/**
 * Ops summary over the selected range: one card per product with every suite and trigger
 * (scheduled, manual dispatch, after deploy), split per suite and trigger below the totals.
 * Definitions live in server/qa/summary.ts.
 */
const StatusSummary: FC<{ summary: QaSummary; rangeDays: number; branch: string; env?: string }> = ({
  summary,
  rangeDays,
  branch,
  env,
}) => (
  <Stack spacing={1.5} data-testid="qa-summary">
    <Box>
      <Typography level="title-md">Summary</Typography>
      <Typography level="body-sm">
        Last {rangeDays} days ({shortDate(summary.from)} - {shortDate(summary.to)}) . branch {branch} .{' '}
        {env ?? 'all envs'} . all products and triggers
      </Typography>
    </Box>
    {summary.truncated && (
      <Alert color="warning" size="sm">
        Too many runs in this range; the oldest were left out.
      </Alert>
    )}
    {summary.products.length === 0 ? (
      <Typography data-testid="qa-summary-empty" level="body-sm">
        No runs in this range.
      </Typography>
    ) : (
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: {
            xs: 'minmax(0, 1fr)',
            md: 'repeat(2, minmax(0, 1fr))',
            xl: 'repeat(3, minmax(0, 1fr))',
          },
          gap: 1.5,
        }}
      >
        {summary.products.map(p => (
          <Card key={p.product} variant="outlined" data-testid="qa-summary-card">
            <Typography level="title-lg">{p.product}</Typography>
            <Stack direction="row" flexWrap="wrap" useFlexGap columnGap={4} rowGap={1.5}>
              {p.e2e && (
                <Figure
                  testId="qa-summary-e2e"
                  label="E2E"
                  value={formatPercent(p.e2e.passRate)}
                  detail={e2eLine(p.e2e)}
                />
              )}
              {p.latency && (
                <Figure
                  testId="qa-summary-latency"
                  label="Latency"
                  value={formatPercent(p.latency.checkRate)}
                  detail={latencyLine(p.latency)}
                />
              )}
            </Stack>
            <Divider />
            <Stack spacing={0.75}>
              {p.rows.map(row => (
                <Row key={`${row.suite}|${row.triggerLabel}`} row={row} />
              ))}
            </Stack>
          </Card>
        ))}
      </Box>
    )}
    <Typography level="body-xs">
      E2E: passed tests out of all tests, not-started included. A run with no failures has no failed or not-started
      tests. Latency: model checks within their time limit.
    </Typography>
  </Stack>
);

export default StatusSummary;
