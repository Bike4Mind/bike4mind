import Box from '@mui/joy/Box';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { UsageBreakdownRow } from '@shared/usage';
import { barPercent, formatCount, formatCredits } from './usageView';

/** What a breakdown row is labelled by; the figures come from its BreakdownMetric. */
export interface BreakdownRowLabel {
  key: string;
  label: string;
  /** Secondary label, shown muted beside the first. */
  detail?: string;
}

/** How a breakdown sizes and states its rows. */
export interface BreakdownMetric<R> {
  /** Sizes the row's bar against the largest row. */
  value(row: R): number;
  /** The headline figure at the end of the row. */
  format(value: number): string;
  /** Muted figures shown before the headline one. */
  extras(row: R): string[];
}

/**
 * Credits, not provider cost: credits are the denomination the balance is in, so they are the
 * only figure here that answers "how much of mine did this take".
 */
const CREDIT_METRIC: BreakdownMetric<UsageBreakdownRow> = {
  value: row => row.creditsSpent,
  format: formatCredits,
  extras: row => [`${formatCount(row.requests)} req`],
};

/** One breakdown cut of the window's credits, biggest first. */
export function UsageBreakdown(props: { title: string; caption: string; rows: UsageBreakdownRow[]; testId: string }) {
  return <BreakdownCard {...props} metric={CREDIT_METRIC} />;
}

/** One breakdown cut, in the rows' own order, each sized by `metric`. */
export function BreakdownCard<R extends BreakdownRowLabel>({
  title,
  caption,
  rows,
  metric,
  testId,
}: {
  title: string;
  caption: string;
  rows: readonly R[];
  metric: BreakdownMetric<R>;
  testId: string;
}) {
  const max = rows.reduce((highest, row) => Math.max(highest, metric.value(row)), 0);

  return (
    <Sheet variant="outlined" sx={{ borderRadius: 'sm', px: 2, py: 1.5, mb: 1.5 }} data-testid={testId}>
      <Typography level="title-sm">{title}</Typography>
      <Typography level="body-xs" textColor="text.tertiary" sx={{ mb: 1 }}>
        {caption}
      </Typography>

      {rows.length === 0 ? (
        <Typography level="body-sm" textColor="text.tertiary" data-testid={`${testId}-empty`}>
          Nothing recorded in this window.
        </Typography>
      ) : (
        <Stack spacing={1}>
          {rows.map(row => (
            <Box key={row.key} data-testid={`${testId}-row`}>
              <Stack direction="row" alignItems="baseline" spacing={1}>
                <Typography level="body-sm" noWrap sx={{ minWidth: 0 }}>
                  {row.label}
                </Typography>
                {row.detail && (
                  <Typography level="body-xs" textColor="text.tertiary" noWrap sx={{ flex: 1, minWidth: 0 }}>
                    {row.detail}
                  </Typography>
                )}
                <Box sx={{ flex: row.detail ? 0 : 1 }} />
                {metric.extras(row).map(extra => (
                  <Typography key={extra} level="body-xs" textColor="text.tertiary">
                    {extra}
                  </Typography>
                ))}
                <Typography level="body-sm">{metric.format(metric.value(row))}</Typography>
              </Stack>
              <Box sx={{ height: 4, borderRadius: 'sm', bgcolor: 'neutral.softBg', mt: 0.5 }}>
                <Box
                  sx={{
                    height: '100%',
                    width: `${barPercent(metric.value(row), max)}%`,
                    borderRadius: 'sm',
                    bgcolor: 'primary.solidBg',
                  }}
                />
              </Box>
            </Box>
          ))}
        </Stack>
      )}
    </Sheet>
  );
}
