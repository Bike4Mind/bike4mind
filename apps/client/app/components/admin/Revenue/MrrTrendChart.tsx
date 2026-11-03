import React from 'react';
import { Box, Stack } from '@mui/joy';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { RevenueTrendPoint } from '@client/app/utils/adminRevenue';
import { MRR_CURRENCY } from '@client/app/utils/adminSubscriptionsFilter';
import { formatMoney } from '../shared/formatMoney';
import { ACCENT, AXIS_TICK, BORDER, COMPARISON_OPACITY, ChartLegend, ChartTooltipBox, INK_MUTED } from './chartParts';
import { formatTrendDay } from './revenueFormat';

const TrendTooltip: React.FC<{ active?: boolean; payload?: Array<{ payload: RevenueTrendPoint }> }> = ({
  active,
  payload,
}) => {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <ChartTooltipBox
      title={formatTrendDay(point.date)}
      lines={[
        { label: 'MRR', value: formatMoney(point.mrr, MRR_CURRENCY), color: ACCENT },
        {
          label: 'Paying',
          value: point.payingCount.toLocaleString(),
          color: INK_MUTED,
          opacity: COMPARISON_OPACITY,
        },
      ]}
    />
  );
};

const LEGEND = [
  { label: 'MRR', color: ACCENT },
  { label: 'Paying customers (right axis)', color: INK_MUTED, opacity: COMPARISON_OPACITY },
];

export const MrrTrendChart: React.FC<{ points: readonly RevenueTrendPoint[] }> = ({ points }) => (
  <Stack gap={1}>
    <Box data-testid="admin-revenue-chart" sx={{ height: 240, minWidth: 0 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={[...points]} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke={BORDER} />
          <XAxis
            dataKey="date"
            tickFormatter={formatTrendDay}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: BORDER }}
            minTickGap={24}
          />
          <YAxis
            yAxisId="mrr"
            tickFormatter={(value: number) => formatMoney(value, MRR_CURRENCY, { compact: true })}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={80}
          />
          <YAxis
            yAxisId="paying"
            orientation="right"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={40}
            allowDecimals={false}
          />
          <Tooltip content={<TrendTooltip />} cursor={{ stroke: BORDER }} />
          <Line
            yAxisId="paying"
            dataKey="payingCount"
            name="Paying customers"
            stroke={INK_MUTED}
            strokeOpacity={COMPARISON_OPACITY}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            yAxisId="mrr"
            dataKey="mrr"
            name="MRR"
            stroke={ACCENT}
            strokeWidth={2}
            dot={points.length === 1}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </Box>
    <ChartLegend items={LEGEND} />
  </Stack>
);
