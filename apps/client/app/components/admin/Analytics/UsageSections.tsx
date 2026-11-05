import { useMemo } from 'react';
import { Box, Button, Stack, Typography, useTheme } from '@mui/joy';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ANALYTICS_OTHER_FEATURE, type AnalyticsOverview, type UsageDay } from '@client/app/utils/analyticsOverview';
import { DataTable, InlineBar, type DataColumn } from '../shared';
import { SIGNAL_COLORS } from '../Signups/SignupChart';
import { AnalyticsSection } from './AnalyticsSection';
import { featureLabel, formatCount, formatDayLabel, formatShare } from './analyticsFormat';
import { isIsolatedPoint } from './isolatedPoint';

const PARTIAL_DASH = '4 4';

type Props = {
  data: AnalyticsOverview | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onShowDefaultRange?: () => void;
};

function useChartStyle() {
  const theme = useTheme();
  const admin = theme.palette.admin;
  return {
    admin,
    scheme: theme.palette.mode === 'dark' ? ('dark' as const) : ('light' as const),
    axisTick: { fontSize: 12, fill: admin.inkMuted },
    tooltipStyle: {
      background: admin.surface,
      border: `1px solid ${admin.border}`,
      borderRadius: 8,
      color: admin.ink,
      fontSize: 12,
    },
  };
}

const tooltipCount = (value: unknown, name: unknown) =>
  [formatCount(value == null ? null : Number(value)), String(name)] as [string, string];
const dayLabel = (day: UsageDay) => `${day.day}${day.partial ? ' (partial)' : ''}`;
const summaryPeriod = ({ window, usage }: AnalyticsOverview) => {
  if (window.completeDays === 0) return 'today so far';
  const days = (count: number) => `${count} complete UTC ${count === 1 ? 'day' : 'days'}`;
  // A complete day can still be waiting for its nightly rollup; it is not in the totals until then.
  return usage.summaryDays === window.completeDays
    ? `the ${days(window.completeDays)}`
    : `${usage.summaryDays} of the ${days(window.completeDays)} (the rest have no rollup yet)`;
};

export function FeatureUsageSection({ data, loading, error, onRetry, onShowDefaultRange }: Props) {
  const { admin, scheme, axisTick, tooltipStyle } = useChartStyle();
  const usage = data?.usage;
  const features = useMemo(() => usage?.features ?? [], [usage]);
  const days = useMemo(() => usage?.days ?? [], [usage]);
  const rows = useMemo(
    () =>
      days.map(day => ({
        label: formatDayLabel(day.day),
        day: day.day,
        partial: day.partial,
        ...Object.fromEntries(features.map(feature => [feature, day.byFeature ? (day.byFeature[feature] ?? 0) : null])),
      })),
    [days, features]
  );
  // Slot order is the ranking, so the busiest feature always takes the first palette color.
  const color = (feature: string) =>
    feature === ANALYTICS_OTHER_FEATURE
      ? admin.inkMuted
      : SIGNAL_COLORS[scheme][features.indexOf(feature) % SIGNAL_COLORS[scheme].length];

  const total = usage?.totals.requests ?? 0;
  const top = features[0];
  const caption =
    data && top
      ? `${formatCount(total)} AI requests over ${summaryPeriod(data)}; ${featureLabel(top)} leads. Bars are UTC days; today is partial.`
      : 'AI requests per UTC day by feature.';

  const chart = (
    <Box
      role="img"
      aria-label={`Stacked bar chart of AI requests per UTC day by feature. ${caption}`}
      data-testid="analytics-usage-features-chart"
    >
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap={1}>
          <CartesianGrid vertical={false} stroke={admin.border} />
          <XAxis dataKey="label" tick={axisTick} minTickGap={24} tickLine={false} />
          <YAxis tick={axisTick} width={44} allowDecimals={false} axisLine={false} tickLine={false} />
          <Tooltip
            cursor={{ fill: admin.hover }}
            contentStyle={tooltipStyle}
            labelFormatter={label => `${label} (UTC)`}
            formatter={tooltipCount}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: admin.inkSecondary }} />
          {features.map(feature => (
            <Bar
              key={feature}
              dataKey={feature}
              name={featureLabel(feature)}
              stackId="features"
              fill={color(feature)}
              isAnimationActive={false}
            >
              {rows.map(row => (
                <Cell
                  key={row.day}
                  fill={color(feature)}
                  fillOpacity={row.partial ? 0.45 : 1}
                  stroke={row.partial ? color(feature) : admin.surface}
                  strokeDasharray={row.partial ? '3 2' : undefined}
                />
              ))}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </Box>
  );

  const columns: DataColumn<UsageDay>[] = [
    { id: 'day', label: 'Day (UTC)', render: dayLabel },
    ...features.map(feature => ({
      id: feature,
      label: `${featureLabel(feature)} (requests)`,
      numeric: true,
      render: (row: UsageDay) => formatCount(row.byFeature ? (row.byFeature[feature] ?? 0) : null),
    })),
  ];

  return (
    <AnalyticsSection
      title="Usage by feature"
      caption={caption}
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={!days.some(day => Object.values(day.byFeature ?? {}).some(count => count > 0))}
      onShowDefaultRange={onShowDefaultRange}
      chart={chart}
      table={
        <DataTable
          rows={days}
          columns={columns}
          getRowId={row => row.day}
          label="AI requests per UTC day by feature"
          onRetry={onRetry}
          pagination={false}
          maxHeight="320px"
          testId="analytics-usage-features-table"
        />
      }
      testId="analytics-usage-features"
    />
  );
}

type ModelRow = AnalyticsOverview['usage']['models'][number];

export function ModelUsageSection({
  data,
  loading,
  error,
  onRetry,
  onShowDefaultRange,
  onOpenModels,
}: Props & { onOpenModels: () => void }) {
  const { admin, axisTick, tooltipStyle } = useChartStyle();
  const models = useMemo(() => data?.usage.models ?? [], [data]);
  const other = data?.usage.otherModelRequests ?? 0;
  const maxShare = Math.max(0, ...models.map(model => model.share));
  const caption =
    data && models[0]
      ? `Top ${models.length} models over ${summaryPeriod(data)}; ${models[0].model} takes ${formatShare(models[0].share)} of requests.${
          other > 0 ? ` ${formatCount(other)} requests on other models.` : ''
        }`
      : 'AI requests by model.';

  const chart = (
    <Box
      role="img"
      aria-label={`Horizontal bar chart of AI requests by model. ${caption}`}
      data-testid="analytics-usage-models-chart"
    >
      <ResponsiveContainer width="100%" height={Math.max(160, models.length * 28 + 24)}>
        <BarChart data={models} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid horizontal={false} stroke={admin.border} />
          <XAxis type="number" tick={axisTick} allowDecimals={false} tickLine={false} />
          <YAxis
            type="category"
            dataKey="model"
            tick={axisTick}
            width={140}
            axisLine={false}
            tickLine={false}
            interval={0}
          />
          <Tooltip
            cursor={{ fill: admin.hover }}
            contentStyle={tooltipStyle}
            formatter={(value, _name, entry) => [
              `${formatCount(Number(value))} (${formatShare((entry.payload as ModelRow).share)})`,
              'Requests',
            ]}
          />
          <Bar dataKey="requests" name="Requests" fill={admin.accent} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </Box>
  );

  const columns: DataColumn<ModelRow>[] = [
    { id: 'model', label: 'Model', render: row => row.model },
    { id: 'requests', label: 'Requests', numeric: true, render: row => formatCount(row.requests) },
    {
      id: 'share',
      label: 'Share',
      numeric: true,
      render: row => (
        <Stack direction="row" alignItems="center" justifyContent="flex-end" gap={1}>
          <InlineBar value={row.share} max={maxShare} />
          <Typography level="body-sm">{formatShare(row.share)}</Typography>
        </Stack>
      ),
    },
  ];

  return (
    <AnalyticsSection
      title="Requests by model"
      caption={caption}
      action={
        <Button size="sm" variant="plain" onClick={onOpenModels} data-testid="analytics-usage-models-open-btn">
          Open in Models
        </Button>
      }
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={models.length === 0}
      onShowDefaultRange={onShowDefaultRange}
      chart={chart}
      table={
        <DataTable
          rows={models}
          columns={columns}
          getRowId={row => row.model}
          label="AI requests by model"
          onRetry={onRetry}
          pagination={false}
          testId="analytics-usage-models-table"
        />
      }
      testId="analytics-usage-models"
    />
  );
}

export function CreditsSection({
  data,
  loading,
  error,
  onRetry,
  onShowDefaultRange,
  onOpenCredits,
}: Props & { onOpenCredits: () => void }) {
  const { admin, axisTick, tooltipStyle } = useChartStyle();
  const days = useMemo(() => data?.usage.days ?? [], [data]);
  // As on Active users: today gets its own dashed series, joined to the last complete day.
  const rows = useMemo(
    () =>
      days.map((day, index) => ({
        label: formatDayLabel(day.day),
        day: day.day,
        credits: day.partial ? null : day.credits,
        creditsPartial: day.partial || days[index + 1]?.partial ? day.credits : null,
      })),
    [days]
  );
  const caption = data
    ? `${formatCount(data.usage.totals.credits)} credits consumed over ${summaryPeriod(data)}. UTC days; today is partial and dashed.`
    : 'Credits consumed per UTC day.';
  const dot = (key: 'credits' | 'creditsPartial') => {
    const renderDot = ({ index, cx, cy }: { index: number; cx?: number; cy?: number }) =>
      isIsolatedPoint(rows, index, key) && cx != null && cy != null ? (
        <circle key={`${key}-${index}`} cx={cx} cy={cy} r={3} fill={admin.accent} />
      ) : (
        <g key={`${key}-${index}`} />
      );
    return renderDot;
  };

  const chart = (
    <Box
      role="img"
      aria-label={`Line chart of credits consumed per UTC day. ${caption}`}
      data-testid="analytics-credits-chart"
    >
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke={admin.border} />
          <XAxis dataKey="label" tick={axisTick} minTickGap={24} tickLine={false} />
          <YAxis tick={axisTick} width={56} allowDecimals={false} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={tooltipStyle} labelFormatter={label => `${label} (UTC)`} formatter={tooltipCount} />
          <Line
            dataKey="credits"
            name="Credits"
            stroke={admin.accent}
            strokeWidth={2}
            dot={dot('credits')}
            isAnimationActive={false}
          />
          <Line
            dataKey="creditsPartial"
            name="Credits (today, partial)"
            legendType="none"
            stroke={admin.accent}
            strokeDasharray={PARTIAL_DASH}
            strokeWidth={2}
            dot={dot('creditsPartial')}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </Box>
  );

  const columns: DataColumn<UsageDay>[] = [
    { id: 'day', label: 'Day (UTC)', render: dayLabel },
    { id: 'credits', label: 'Credits consumed', numeric: true, render: row => formatCount(row.credits) },
  ];

  return (
    <AnalyticsSection
      title="Credits consumed"
      caption={caption}
      action={
        <Button size="sm" variant="plain" onClick={onOpenCredits} data-testid="analytics-credits-open-btn">
          Open in Credits
        </Button>
      }
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={!days.some(day => (day.credits ?? 0) > 0)}
      onShowDefaultRange={onShowDefaultRange}
      chart={chart}
      table={
        <DataTable
          rows={days}
          columns={columns}
          getRowId={row => row.day}
          label="Credits consumed per UTC day"
          onRetry={onRetry}
          pagination={false}
          maxHeight="320px"
          testId="analytics-credits-table"
        />
      }
      testId="analytics-credits"
    />
  );
}
