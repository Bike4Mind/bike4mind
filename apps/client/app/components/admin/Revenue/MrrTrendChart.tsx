import React from 'react';
import { Box, Typography } from '@mui/joy';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { RevenueTrendPoint } from '@client/app/utils/adminRevenue';
import { MRR_CURRENCY } from '@client/app/utils/adminSubscriptionsFilter';
import { formatMoney } from '../shared/formatMoney';
import { formatTrendDay } from './revenueFormat';

// recharts paints SVG attributes, so colors come from the admin CSS variables rather than sx tokens, the
// same as the profile SpendChart.
const ACCENT = 'var(--joy-palette-admin-accent)';
const BORDER = 'var(--joy-palette-admin-border)';
const INK_MUTED = 'var(--joy-palette-admin-inkMuted)';
const AXIS_TICK = { fontSize: 12, fill: INK_MUTED };

const TrendTooltip: React.FC<{ active?: boolean; payload?: Array<{ payload: RevenueTrendPoint }> }> = ({
  active,
  payload,
}) => {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <Box
      data-testid="admin-revenue-chart-tooltip"
      sx={{
        bgcolor: 'admin.surface',
        border: '1px solid',
        borderColor: 'admin.border',
        borderRadius: '8px',
        px: 1.25,
        py: 0.75,
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.08)',
      }}
    >
      <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
        {formatTrendDay(point.date)}
      </Typography>
      <Typography level="body-sm" sx={{ color: 'admin.ink', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
        {formatMoney(point.mrr, MRR_CURRENCY)} MRR
      </Typography>
      <Typography level="body-xs" sx={{ color: 'admin.inkMuted', fontVariantNumeric: 'tabular-nums' }}>
        {point.payingCount.toLocaleString()} paying
      </Typography>
    </Box>
  );
};

export const MrrTrendChart: React.FC<{ points: readonly RevenueTrendPoint[] }> = ({ points }) => (
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
          strokeOpacity={0.4}
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
);
