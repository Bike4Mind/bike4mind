import React from 'react';
import { Box, Typography } from '@mui/joy';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AdminCreditSummary } from '@bike4mind/common';
import { formatCredits } from '../../actions/creditAdjustment';
import { formatSpendDay, type SpendBar } from './creditLedgerModel';

type SpendPoint = AdminCreditSummary['daily'][number];

// recharts paints SVG attributes, so colors come from the admin CSS variables rather than sx tokens;
// they follow the light/dark scheme without a re-render.
const ACCENT = 'var(--joy-palette-admin-accent)';
const BORDER = 'var(--joy-palette-admin-border)';
const INK_MUTED = 'var(--joy-palette-admin-inkMuted)';
const AXIS_TICK = { fontSize: 12, fill: INK_MUTED };

const TooltipCard: React.FC<{ title: string; credits: number }> = ({ title, credits }) => (
  <Box
    data-testid="user-credits-chart-tooltip"
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
      {title}
    </Typography>
    <Typography level="body-sm" sx={{ color: 'admin.ink', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
      {formatCredits(credits)} credits
    </Typography>
  </Box>
);

const SpendTooltip: React.FC<{ active?: boolean; payload?: Array<{ payload: SpendPoint }> }> = ({
  active,
  payload,
}) => {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return <TooltipCard title={formatSpendDay(point.date)} credits={point.credits} />;
};

const BarTooltip: React.FC<{ active?: boolean; payload?: Array<{ payload: SpendBar }> }> = ({ active, payload }) => {
  const bar = payload?.[0]?.payload;
  if (!active || !bar) return null;
  return <TooltipCard title={bar.label} credits={bar.credits} />;
};

/** Daily AI spend as accent bars. The caller handles loading, error and the all-zero empty state. */
export const SpendChart: React.FC<{ points: readonly SpendPoint[] }> = ({ points }) => (
  <Box data-testid="user-credits-chart" sx={{ height: 200, minWidth: 0 }}>
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={[...points]} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke={BORDER} />
        <XAxis
          dataKey="date"
          tickFormatter={formatSpendDay}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: BORDER }}
          minTickGap={24}
        />
        <YAxis
          tickFormatter={(value: number) => formatCredits(value)}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          width={56}
          allowDecimals={false}
        />
        <Tooltip content={<SpendTooltip />} cursor={{ fill: 'var(--joy-palette-admin-hover)' }} />
        <Bar dataKey="credits" fill={ACCENT} radius={[3, 3, 0, 0]} maxBarSize={28} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  </Box>
);

const BAR_ROW_HEIGHT = 32;

/** Spend per model or source as horizontal accent bars, largest first. The caller handles empty states. */
export const SpendBreakdownChart: React.FC<{ bars: readonly SpendBar[] }> = ({ bars }) => (
  <Box data-testid="user-credits-breakdown-chart" sx={{ height: bars.length * BAR_ROW_HEIGHT + 32, minWidth: 0 }}>
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={[...bars]} layout="vertical" margin={{ top: 0, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid horizontal={false} stroke={BORDER} />
        <XAxis
          type="number"
          tickFormatter={(value: number) => formatCredits(value)}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: BORDER }}
          allowDecimals={false}
        />
        <YAxis type="category" dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} width={160} />
        <Tooltip content={<BarTooltip />} cursor={{ fill: 'var(--joy-palette-admin-hover)' }} />
        <Bar dataKey="credits" fill={ACCENT} radius={[0, 3, 3, 0]} maxBarSize={20} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  </Box>
);
