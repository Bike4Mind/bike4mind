import { useMemo } from 'react';
import { Box, useTheme } from '@mui/joy';
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { SIGNUP_SIGNAL_LABELS, SIGNUP_SIGNALS, type SignupTimeseries } from '@client/app/utils/signupSignals';
import { formatBucketLabel } from './useSignupTimeseries';

export type SignupChartMode = 'status' | 'signals';

/**
 * Validated with the dataviz palette checker against the admin surfaces (light #FFFFFF, dark #1E1E22).
 * Likely legit takes the admin accent and suspected the warn tone; the dark steps are deeper than the
 * dark accent/warn tokens, which are text colors and fail the chart lightness band.
 */
export const SIGNUP_STATUS_COLORS = {
  light: { likelyLegit: '#4F46E5', suspected: '#8A4B00' },
  dark: { likelyLegit: '#7B83F2', suspected: '#D95926' },
} as const;

/**
 * Categorical slots in SIGNUP_SIGNALS order, so a signal keeps its color whatever the range. The
 * Analytics page's by-surface chart takes the same slots in its own fixed order.
 */
export const SIGNAL_COLORS = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#0f8c9e', '#9a6a3a', '#b03fc4'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#2aa9ba', '#b8875a', '#c869d6'],
} as const;

type SignupChartProps = {
  data: SignupTimeseries;
  mode?: SignupChartMode;
  showBaseline?: boolean;
  height?: number;
  compact?: boolean;
  onBucketClick?: (start: string) => void;
  testId?: string;
};

export function SignupChart({
  data,
  mode = 'status',
  showBaseline = false,
  height = 240,
  compact = false,
  onBucketClick,
  testId,
}: SignupChartProps) {
  const theme = useTheme();
  const scheme = theme.palette.mode === 'dark' ? 'dark' : 'light';
  const admin = theme.palette.admin;
  const rows = useMemo(
    () =>
      data.buckets.map(bucket => ({
        ...bucket,
        ...bucket.bySignal,
        label: formatBucketLabel(bucket.start, data.bucket),
        band: bucket.baseline ? [bucket.baseline.median, bucket.baseline.p90] : null,
      })),
    [data]
  );
  const axisTick = { fontSize: 12, fill: admin.inkMuted };

  return (
    <Box data-testid={testId} sx={{ cursor: onBucketClick ? 'pointer' : undefined }}>
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart
          data={rows}
          margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          barCategoryGap={1}
          onClick={state => {
            // null outside the plot (legend, axis gutters); Number(null) would be 0 and pick the oldest bucket
            const raw = state?.activeTooltipIndex;
            if (raw == null) return;
            const index = Number(raw);
            const bucket = Number.isInteger(index) ? data.buckets[index] : undefined;
            if (bucket && onBucketClick) onBucketClick(bucket.start);
          }}
        >
          <CartesianGrid vertical={false} stroke={admin.border} />
          <XAxis dataKey="label" tick={axisTick} minTickGap={24} hide={compact} tickLine={false} />
          <YAxis tick={axisTick} width={compact ? 0 : 40} allowDecimals={false} hide={compact} axisLine={false} />
          <Tooltip
            cursor={{ fill: admin.hover }}
            contentStyle={{
              background: admin.surface,
              border: `1px solid ${admin.border}`,
              borderRadius: 8,
              color: admin.ink,
              fontSize: 12,
            }}
            formatter={(value, name) =>
              name === 'Typical range' && Array.isArray(value)
                ? [`${Math.round(Number(value[0]))} - ${Math.round(Number(value[1]))}`, name]
                : [Number(value).toLocaleString(), name]
            }
          />
          {!compact && <Legend wrapperStyle={{ fontSize: 12, color: admin.inkSecondary }} />}
          {showBaseline && (
            <Area
              dataKey="band"
              name="Typical range"
              type="stepAfter"
              stroke="none"
              fill={admin.inkMuted}
              fillOpacity={0.15}
              isAnimationActive={false}
              connectNulls
            />
          )}
          {mode === 'status' ? (
            <>
              <Bar
                dataKey="likelyLegit"
                name="Likely legit"
                stackId="signups"
                fill={SIGNUP_STATUS_COLORS[scheme].likelyLegit}
                stroke={admin.surface}
                strokeWidth={1}
                isAnimationActive={false}
              />
              <Bar
                dataKey="suspected"
                name="Suspected"
                stackId="signups"
                fill={SIGNUP_STATUS_COLORS[scheme].suspected}
                stroke={admin.surface}
                strokeWidth={1}
                isAnimationActive={false}
              />
              {data.truncated && (
                <Bar
                  dataKey="unclassified"
                  name="Not classified"
                  stackId="signups"
                  fill={admin.inkMuted}
                  fillOpacity={0.4}
                  isAnimationActive={false}
                />
              )}
            </>
          ) : (
            SIGNUP_SIGNALS.map((signal, index) => (
              <Line
                key={signal}
                dataKey={signal}
                name={SIGNUP_SIGNAL_LABELS[signal].label}
                stroke={SIGNAL_COLORS[scheme][index]}
                strokeWidth={2}
                dot={false}
                type="monotone"
                isAnimationActive={false}
              />
            ))
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </Box>
  );
}
