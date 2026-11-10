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
import {
  SIGNUP_SIGNAL_LABELS,
  SIGNUP_SIGNALS,
  type SignupTimeseries,
} from '@bike4mind/server-utils/app/utils/signupSignals';
import type { AdminPalette } from '@client/app/utils/themes/admin';
import { formatBucketLabel } from './useSignupTimeseries';

export type SignupChartMode = 'status' | 'signals';

/** Likely legit is the primary series (accent); suspected takes the warn status tone. */
export const signupStatusColors = (admin: AdminPalette) => ({
  likelyLegit: admin.accent,
  suspected: admin.status.warn.foreground,
});

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
  const admin = theme.palette.admin;
  const statusColors = signupStatusColors(admin);
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
                fill={statusColors.likelyLegit}
                stroke={admin.surface}
                strokeWidth={1}
                isAnimationActive={false}
              />
              <Bar
                dataKey="suspected"
                name="Suspected"
                stackId="signups"
                fill={statusColors.suspected}
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
                stroke={admin.chartSeries[index % admin.chartSeries.length]}
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
