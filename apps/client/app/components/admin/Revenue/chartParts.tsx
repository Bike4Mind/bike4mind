import React from 'react';
import { Box, Stack, Typography } from '@mui/joy';

// recharts paints SVG attributes, so colors come from the admin CSS variables rather than sx tokens, the
// same as the profile SpendChart. Series colors are checked for 3:1 on `surface` in contrast.test.ts.
export const ACCENT = 'var(--joy-palette-admin-accent)';
export const BORDER = 'var(--joy-palette-admin-border)';
export const INK = 'var(--joy-palette-admin-ink)';
export const INK_MUTED = 'var(--joy-palette-admin-inkMuted)';
export const GOOD = 'var(--joy-palette-admin-status-good-foreground)';
export const BAD = 'var(--joy-palette-admin-status-bad-foreground)';
export const WARN = 'var(--joy-palette-admin-status-warn-foreground)';
/** DESIGN_GUIDE "Data visualization": comparisons are inkMuted at 40%. */
export const COMPARISON_OPACITY = 0.4;
export const AXIS_TICK = { fontSize: 12, fill: INK_MUTED };

export const xAxisProps = {
  tick: AXIS_TICK,
  tickLine: false,
  axisLine: { stroke: BORDER },
  minTickGap: 24,
} as const;

export const yAxisProps = { tick: AXIS_TICK, tickLine: false, axisLine: false } as const;

export type ChartTooltipLine = { label: string; value: string; color?: string; opacity?: number };

export const ChartSwatch: React.FC<{ color: string; opacity?: number; dashed?: boolean }> = ({
  color,
  opacity = 1,
  dashed = false,
}) => (
  <Box
    component="span"
    aria-hidden
    sx={{
      width: 10,
      height: dashed ? 0 : 10,
      borderRadius: dashed ? 0 : '2px',
      flexShrink: 0,
      ...(dashed ? { borderTop: `2px dashed ${color}` } : { bgcolor: color }),
      opacity,
    }}
  />
);

/** Exact values, labeled, so no series is told apart by color alone. */
export const ChartTooltipBox: React.FC<{ title: string; lines: readonly ChartTooltipLine[] }> = ({ title, lines }) => (
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
      {title}
    </Typography>
    {lines.map(line => (
      <Stack key={line.label} direction="row" alignItems="center" gap={0.75}>
        {line.color && <ChartSwatch color={line.color} opacity={line.opacity} />}
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          {line.label}
        </Typography>
        <Typography
          level="body-xs"
          sx={{ color: 'admin.ink', fontWeight: 600, fontVariantNumeric: 'tabular-nums', ml: 'auto', pl: 1.5 }}
        >
          {line.value}
        </Typography>
      </Stack>
    ))}
  </Box>
);

export type ChartLegendItem = { label: string; color: string; opacity?: number; dashed?: boolean };

export const ChartLegend: React.FC<{ items: readonly ChartLegendItem[] }> = ({ items }) => (
  <Stack direction="row" flexWrap="wrap" columnGap={2} rowGap={0.5} data-testid="admin-revenue-chart-legend">
    {items.map(item => (
      <Stack key={item.label} direction="row" alignItems="center" gap={0.75}>
        <ChartSwatch color={item.color} opacity={item.opacity} dashed={item.dashed} />
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          {item.label}
        </Typography>
      </Stack>
    ))}
  </Stack>
);
