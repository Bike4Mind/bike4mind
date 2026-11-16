import { FC, ReactNode } from 'react';
import { Alert, Box, Card, Stack, Typography } from '@mui/joy';
import { useTheme } from '@mui/joy/styles';
import type { QaSummary } from '@client/app/hooks/data/qaStatus';
import { parseIsoDay, spanDays, type DayRange } from './dateRange';
import { seriesColor } from './qaSeriesColors';

/** 0.98765 -> "98.8%"; null -> "-". */
export function formatPercent(rate: number | null): string {
  return rate === null ? '-' : `${(rate * 100).toFixed(1)}%`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Product slugs are lowercase; the card title only raises the first letter. */
export const productTitle = (product: string) => product.charAt(0).toUpperCase() + product.slice(1);

const shortDay = (day: string) =>
  (parseIsoDay(day) as Date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** "7 days (Nov 10 - Nov 16)"; one day names it once. */
function rangeLine(range: DayRange): string {
  const days = range.from === range.to ? shortDay(range.from) : `${shortDay(range.from)} - ${shortDay(range.to)}`;
  return `${plural(spanDays(range), 'day')} (${days})`;
}

/** "<b>7</b> of <b>13</b> runs with no failures" */
const runsLine = (count: number, runs: number, tail: string): ReactNode => (
  <>
    <b>{count}</b> of <b>{runs}</b> {runs === 1 ? 'run' : 'runs'} {tail}
  </>
);

const Figure: FC<{ label: string; value: string; detail: ReactNode; testId: string }> = ({
  label,
  value,
  detail,
  testId,
}) => (
  <Box data-testid={testId} sx={{ minWidth: 0 }}>
    <Typography level="body-sm" textColor="text.tertiary">
      {label}
    </Typography>
    <Typography level="h2" fontWeight="md" sx={{ my: 0.5 }}>
      {value}
    </Typography>
    <Typography level="body-sm" textColor="text.tertiary" sx={{ '& b': { color: 'text.primary' } }}>
      {detail}
    </Typography>
  </Box>
);

/**
 * Ops summary of scheduled runs over the selected range: one card per product with its E2E and
 * latency figures. Definitions live in server/qa/summary.ts. `colorOrder` (every known product)
 * keeps a product's square the same color whichever products are in range.
 */
const StatusSummary: FC<{
  summary: QaSummary;
  range: DayRange;
  branch: string;
  env?: string;
  colorOrder?: string[];
}> = ({ summary, range, branch, env, colorOrder = [] }) => {
  const theme = useTheme();
  const mode = theme.palette.mode === 'dark' ? 'dark' : 'light';
  const colorFor = (product: string, i: number) => {
    const known = colorOrder.indexOf(product);
    return seriesColor(known >= 0 ? known : i, mode);
  };
  return (
    <Stack spacing={1.5} data-testid="qa-summary">
      <Box>
        <Typography level="title-md">Summary</Typography>
        <Typography level="body-sm">
          {rangeLine(range)} . branch {branch} . {env ?? 'all envs'} . all products, scheduled runs
        </Typography>
      </Box>
      {summary.truncated && (
        <Alert color="warning" size="sm">
          Too many runs in this range; the oldest were left out.
        </Alert>
      )}
      {summary.products.length === 0 ? (
        <Typography data-testid="qa-summary-empty" level="body-sm">
          No scheduled runs in this range.
        </Typography>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: {
              xs: 'minmax(0, 1fr)',
              md: 'repeat(2, minmax(0, 1fr))',
            },
            gap: 1.5,
          }}
        >
          {summary.products.map((p, i) => (
            <Card key={p.product} variant="outlined" data-testid="qa-summary-card" sx={{ gap: 2 }}>
              <Stack direction="row" alignItems="center" spacing={1.25}>
                <Box
                  data-testid="qa-summary-swatch"
                  aria-hidden
                  sx={{ width: 14, height: 14, borderRadius: '3px', flexShrink: 0, bgcolor: colorFor(p.product, i) }}
                />
                <Typography level="title-lg">{productTitle(p.product)}</Typography>
              </Stack>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                  '& > * + *': { borderLeft: '1px solid', borderColor: 'divider', pl: { xs: 1.5, sm: 3 } },
                  columnGap: { xs: 1.5, sm: 3 },
                }}
              >
                {p.e2e && (
                  <Figure
                    testId="qa-summary-e2e"
                    label="E2E"
                    value={formatPercent(p.e2e.passRate)}
                    detail={runsLine(p.e2e.cleanRuns, p.e2e.runs, 'with no failures')}
                  />
                )}
                {p.latency && (
                  <Figure
                    testId="qa-summary-latency"
                    label="Latency"
                    value={formatPercent(p.latency.checkRate)}
                    detail={runsLine(p.latency.passedRuns, p.latency.runs, 'passed')}
                  />
                )}
              </Box>
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
};

export default StatusSummary;
