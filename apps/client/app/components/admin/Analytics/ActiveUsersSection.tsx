import { useMemo, useState } from 'react';
import { Box, useTheme } from '@mui/joy';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { UNCLASSIFIED_SOURCE } from '@bike4mind/common';
import type { AnalyticsOverview } from '@client/app/utils/analyticsOverview';
import { DataTable, SegmentedControl, type DataColumn } from '../shared';
import { SIGNAL_COLORS } from '../Signups/SignupChart';
import { AnalyticsSection } from './AnalyticsSection';
import { comparisonLine, formatCount, formatDayLabel } from './analyticsFormat';

type ActiveUsersMode = 'users' | 'surface';
const MODE_OPTIONS = [
  { value: 'users', label: 'Active users' },
  { value: 'surface', label: 'By surface' },
] as const;

// Fixed order so a surface keeps its color whatever the range.
const SOURCE_ORDER = ['web', 'cli', 'desktop', 'api', 'agent', UNCLASSIFIED_SOURCE];
const SOURCE_LABELS: Record<string, string> = {
  web: 'Web',
  cli: 'CLI',
  desktop: 'Desktop',
  api: 'API',
  agent: 'Agent',
  [UNCLASSIFIED_SOURCE]: 'Unclassified',
};
const PARTIAL_DASH = '4 4';

type Props = {
  data: AnalyticsOverview | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onShowDefaultRange?: () => void;
};

export function ActiveUsersSection({ data, loading, error, onRetry, onShowDefaultRange }: Props) {
  const theme = useTheme();
  const admin = theme.palette.admin;
  const scheme = theme.palette.mode === 'dark' ? 'dark' : 'light';
  const [mode, setMode] = useState<ActiveUsersMode>('users');

  const days = useMemo(() => data?.activeUsers.days ?? [], [data]);
  const compare = !!data?.window.previous;
  const sources = useMemo(
    () =>
      [...(data?.activeUsers.sources ?? [])].sort(
        (a, b) =>
          (SOURCE_ORDER.indexOf(a) + 1 || SOURCE_ORDER.length + 1) -
            (SOURCE_ORDER.indexOf(b) + 1 || SOURCE_ORDER.length + 1) || a.localeCompare(b)
      ),
    [data]
  );

  // The partial day gets its own dashed series, joined to the last complete day so the line runs on.
  const lineRows = useMemo(
    () =>
      days.map((day, index) => {
        const next = days[index + 1];
        const joinsPartial = !day.partial && next?.partial;
        return {
          label: formatDayLabel(day.day),
          day: day.day,
          mau: day.partial ? null : day.mau,
          wau: day.partial ? null : day.wau,
          dau: day.partial ? null : day.dau,
          mauPartial: day.partial || joinsPartial ? day.mau : null,
          wauPartial: day.partial || joinsPartial ? day.wau : null,
          dauPartial: day.partial || joinsPartial ? day.dau : null,
          previousMau: day.previousMau ?? null,
        };
      }),
    [days]
  );
  const surfaceRows = useMemo(
    () =>
      (data?.activeUsers.bySource ?? []).map(day => ({
        label: formatDayLabel(day.day),
        day: day.day,
        partial: day.partial,
        ...Object.fromEntries(sources.map(source => [source, day.counts ? (day.counts[source] ?? 0) : null])),
      })),
    [data, sources]
  );

  const mau = data?.stats.mau;
  const caption =
    mau?.value != null
      ? `MAU ${formatCount(mau.value)} at range end${
          compare && data ? `, ${comparisonLine(mau.value, mau.previous, data.window.completeDays)}` : ''
        }. UTC days; today is partial and dashed.`
      : 'UTC days; today is partial and dashed.';
  const ariaLabel =
    mode === 'users'
      ? `Line chart of daily, weekly and monthly active users per UTC day. ${caption}`
      : 'Stacked area chart of AI requests per UTC day by surface.';
  const axisTick = { fontSize: 12, fill: admin.inkMuted };
  const tooltipStyle = {
    background: admin.surface,
    border: `1px solid ${admin.border}`,
    borderRadius: 8,
    color: admin.ink,
    fontSize: 12,
  };
  const sourceColor = (source: string) => {
    const slot = SOURCE_ORDER.indexOf(source);
    const palette = SIGNAL_COLORS[scheme];
    return palette[(slot === -1 ? SOURCE_ORDER.length + sources.indexOf(source) : slot) % palette.length];
  };

  const empty = !days.some(day => (day.dau ?? 0) > 0);

  const chart =
    mode === 'users' ? (
      <Box role="img" aria-label={ariaLabel} data-testid="analytics-active-users-chart">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={lineRows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={admin.border} />
            <XAxis dataKey="label" tick={axisTick} minTickGap={24} tickLine={false} />
            <YAxis tick={axisTick} width={44} allowDecimals={false} axisLine={false} tickLine={false} />
            <Tooltip
              contentStyle={tooltipStyle}
              labelFormatter={label => `${label} (UTC)`}
              formatter={(value, name) => [formatCount(value == null ? null : Number(value)), name]}
            />
            <Legend wrapperStyle={{ fontSize: 12, color: admin.inkSecondary }} />
            {compare && (
              <Line
                dataKey="previousMau"
                name="MAU, previous period"
                stroke={admin.inkMuted}
                strokeOpacity={0.4}
                strokeDasharray={PARTIAL_DASH}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            )}
            <Line
              dataKey="dau"
              name="DAU"
              stroke={admin.inkMuted}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              dataKey="wau"
              name="WAU"
              stroke={admin.inkSecondary}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              dataKey="mau"
              name="MAU"
              stroke={admin.accent}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            {(['dau', 'wau', 'mau'] as const).map(key => (
              <Line
                key={key}
                dataKey={`${key}Partial`}
                name={`${key.toUpperCase()} (today, partial)`}
                legendType="none"
                stroke={key === 'mau' ? admin.accent : key === 'wau' ? admin.inkSecondary : admin.inkMuted}
                strokeDasharray={PARTIAL_DASH}
                strokeWidth={key === 'mau' ? 2 : 1.5}
                dot={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </Box>
    ) : (
      <Box role="img" aria-label={ariaLabel} data-testid="analytics-surface-chart">
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={surfaceRows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={admin.border} />
            <XAxis dataKey="label" tick={axisTick} minTickGap={24} tickLine={false} />
            <YAxis tick={axisTick} width={44} allowDecimals={false} axisLine={false} tickLine={false} />
            <Tooltip
              contentStyle={tooltipStyle}
              labelFormatter={label => `${label} (UTC)`}
              formatter={(value, name) => [formatCount(value == null ? null : Number(value)), name]}
            />
            <Legend wrapperStyle={{ fontSize: 12, color: admin.inkSecondary }} />
            {sources.map(source => (
              <Area
                key={source}
                dataKey={source}
                name={SOURCE_LABELS[source] ?? source}
                stackId="sources"
                type="linear"
                stroke={sourceColor(source)}
                fill={sourceColor(source)}
                fillOpacity={0.5}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </Box>
    );

  type DayRow = (typeof days)[number];
  type SurfaceRow = (typeof surfaceRows)[number];
  const dayLabel = (day: string, partial: boolean) => `${day}${partial ? ' (partial)' : ''}`;
  const usersColumns: DataColumn<DayRow>[] = [
    { id: 'day', label: 'Day (UTC)', render: row => dayLabel(row.day, row.partial) },
    { id: 'dau', label: 'DAU', numeric: true, render: row => formatCount(row.dau) },
    { id: 'wau', label: 'WAU', numeric: true, render: row => formatCount(row.wau) },
    { id: 'mau', label: 'MAU', numeric: true, render: row => formatCount(row.mau) },
    ...(compare
      ? [
          {
            id: 'previousMau',
            label: 'MAU, previous',
            numeric: true,
            render: (row: DayRow) => formatCount(row.previousMau),
          },
        ]
      : []),
  ];
  const surfaceColumns: DataColumn<SurfaceRow>[] = [
    { id: 'day', label: 'Day (UTC)', render: row => dayLabel(row.day, row.partial) },
    ...sources.map(source => ({
      id: source,
      label: `${SOURCE_LABELS[source] ?? source} (requests)`,
      numeric: true,
      render: (row: SurfaceRow) => formatCount((row as Record<string, unknown>)[source] as number | null),
    })),
  ];
  const table =
    mode === 'users' ? (
      <DataTable
        rows={days}
        columns={usersColumns}
        getRowId={row => row.day}
        label="Active users per UTC day"
        onRetry={onRetry}
        pagination={false}
        maxHeight="320px"
        testId="analytics-active-users-table"
      />
    ) : (
      <DataTable
        rows={surfaceRows}
        columns={surfaceColumns}
        getRowId={row => row.day}
        label="AI requests per UTC day by surface"
        onRetry={onRetry}
        pagination={false}
        maxHeight="320px"
        testId="analytics-surface-table"
      />
    );

  return (
    <AnalyticsSection
      title="Active users"
      caption={mode === 'users' ? caption : 'AI requests per UTC day by surface; system traffic excluded.'}
      action={
        <SegmentedControl
          options={MODE_OPTIONS}
          value={mode}
          onChange={setMode}
          aria-label="Active users view"
          data-testid="analytics-active-users-mode"
        />
      }
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={empty}
      onShowDefaultRange={onShowDefaultRange}
      chart={chart}
      table={table}
      testId="analytics-active-users"
    />
  );
}
