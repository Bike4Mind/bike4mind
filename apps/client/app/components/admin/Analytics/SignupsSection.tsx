import { useMemo } from 'react';
import { Box, Button, Stack, Typography, useTheme } from '@mui/joy';
import { Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AnalyticsOverview, SignupBucket } from '@client/app/utils/analyticsOverview';
import { SIGNUP_SIGNAL_LABELS, type SignupSignal } from '@client/app/utils/signupSignals';
import { DataTable, InlineBar, type DataColumn } from '../shared';
import { SIGNUP_STATUS_COLORS } from '../Signups/SignupChart';
import { AnalyticsSection } from './AnalyticsSection';
import { formatCount, formatDayLabel } from './analyticsFormat';

const BUCKET_UNIT = { day: 'UTC days', week: 'ISO weeks (Monday, UTC)', month: 'UTC months' } as const;

type Props = {
  data: AnalyticsOverview | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onShowDefaultRange?: () => void;
  /** Opens the Users list for accounts created in [createdFrom, createdTo). */
  onSelectWindow: (window: { createdFrom: string; createdTo: string }) => void;
};

const signalLabel = (signal: string) => SIGNUP_SIGNAL_LABELS[signal as SignupSignal]?.label ?? signal;
const toWindow = (bucket: SignupBucket) => ({
  createdFrom: `${bucket.start}T00:00:00.000Z`,
  createdTo: `${bucket.end}T00:00:00.000Z`,
});

export function SignupsSection({ data, loading, error, onRetry, onShowDefaultRange, onSelectWindow }: Props) {
  const theme = useTheme();
  const admin = theme.palette.admin;
  const colors = SIGNUP_STATUS_COLORS[theme.palette.mode === 'dark' ? 'dark' : 'light'];
  const bucket = data?.window.bucket ?? 'day';
  const buckets = useMemo(() => data?.signups.buckets ?? [], [data]);
  const rows = useMemo(() => buckets.map(b => ({ ...b, label: formatDayLabel(b.start, bucket) })), [buckets, bucket]);
  const totals = data?.signups.totals ?? { legit: 0, suspected: 0, unclassified: 0 };
  const signals = data?.signups.bySignal ?? [];
  const maxSignal = Math.max(0, ...signals.map(row => row.count));
  const empty = totals.legit + totals.suspected + totals.unclassified === 0;

  const caption = `${formatCount(totals.legit)} likely legit, ${formatCount(totals.suspected)} suspected, ${formatCount(
    totals.unclassified
  )} not classified yet. Bars are ${BUCKET_UNIT[bucket]}; click one to list its accounts.`;
  const axisTick = { fontSize: 12, fill: admin.inkMuted };

  const partialCell = (entry: SignupBucket, fill: string) => (
    <Cell
      key={entry.start}
      fill={fill}
      fillOpacity={entry.partial ? 0.45 : 1}
      stroke={entry.partial ? fill : admin.surface}
      strokeDasharray={entry.partial ? '3 2' : undefined}
    />
  );

  const chart = (
    <Box
      role="img"
      aria-label={`Stacked bar chart of signups per bucket, likely legit versus suspected. ${caption}`}
      data-testid="analytics-signups-chart"
      sx={{ cursor: 'pointer' }}
    >
      <ResponsiveContainer width="100%" height={260}>
        <BarChart
          data={rows}
          margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          barCategoryGap={1}
          onClick={state => {
            // null outside the plot (legend, axis gutters); Number(null) would be 0 and pick the first bucket
            const raw = state?.activeTooltipIndex;
            if (raw == null) return;
            const picked = buckets[Number(raw)];
            if (picked) onSelectWindow(toWindow(picked));
          }}
        >
          <CartesianGrid vertical={false} stroke={admin.border} />
          <XAxis dataKey="label" tick={axisTick} minTickGap={24} tickLine={false} />
          <YAxis tick={axisTick} width={40} allowDecimals={false} axisLine={false} tickLine={false} />
          <Tooltip
            cursor={{ fill: admin.hover }}
            contentStyle={{
              background: admin.surface,
              border: `1px solid ${admin.border}`,
              borderRadius: 8,
              color: admin.ink,
              fontSize: 12,
            }}
            labelFormatter={label => `${label} (UTC)`}
            formatter={(value, name) => [formatCount(value == null ? null : Number(value)), name]}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: admin.inkSecondary }} />
          <Bar
            dataKey="legit"
            name="Likely legit"
            stackId="signups"
            fill={colors.likelyLegit}
            isAnimationActive={false}
          >
            {rows.map(entry => partialCell(entry, colors.likelyLegit))}
          </Bar>
          <Bar dataKey="suspected" name="Suspected" stackId="signups" fill={colors.suspected} isAnimationActive={false}>
            {rows.map(entry => partialCell(entry, colors.suspected))}
          </Bar>
          <Bar
            dataKey="unclassified"
            name="Not classified"
            stackId="signups"
            fill={admin.inkMuted}
            fillOpacity={0.4}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </Box>
  );

  const columns: DataColumn<SignupBucket>[] = [
    {
      id: 'start',
      label: bucket === 'day' ? 'Day (UTC)' : bucket === 'week' ? 'Week from (UTC)' : 'Month from (UTC)',
      render: row => (
        <Button
          size="sm"
          variant="plain"
          onClick={() => onSelectWindow(toWindow(row))}
          data-testid={`analytics-signups-row-${row.start}-btn`}
        >
          {`${row.start}${row.partial ? ' (partial)' : ''}`}
        </Button>
      ),
    },
    { id: 'legit', label: 'Likely legit', numeric: true, render: row => formatCount(row.legit) },
    { id: 'suspected', label: 'Suspected', numeric: true, render: row => formatCount(row.suspected) },
    { id: 'unclassified', label: 'Not classified', numeric: true, render: row => formatCount(row.unclassified) },
  ];
  const table = (
    <DataTable
      rows={buckets}
      columns={columns}
      getRowId={row => row.start}
      label="Signups per bucket"
      onRetry={onRetry}
      pagination={false}
      maxHeight="320px"
      testId="analytics-signups-table"
    />
  );

  const footer =
    signals.length > 0 ? (
      <Stack gap={1} sx={{ mt: 2 }} data-testid="analytics-signup-signals">
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          Signals in this range (an account can carry several)
        </Typography>
        {signals.map(row => (
          <Stack key={row.signal} direction="row" alignItems="center" gap={1.5}>
            <Typography level="body-sm" sx={{ color: 'admin.ink', flex: 1, minWidth: 0 }} noWrap>
              {signalLabel(row.signal)}
            </Typography>
            <InlineBar value={row.count} max={maxSignal} />
            <Typography
              level="body-sm"
              sx={{ color: 'admin.ink', minWidth: 48, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
            >
              {formatCount(row.count)}
            </Typography>
          </Stack>
        ))}
      </Stack>
    ) : null;

  return (
    <AnalyticsSection
      title="Signups: real vs suspected"
      caption={caption}
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={empty}
      onShowDefaultRange={onShowDefaultRange}
      chart={chart}
      table={table}
      footer={footer}
      testId="analytics-signups"
    />
  );
}
