import React from 'react';
import { Box } from '@mui/joy';
import { useTheme } from '@mui/joy/styles';

/** Categorical colors for slices and bars whose categories carry no meaning of their own. */
export const CATEGORY_COLORS = ['#e8c1a0', '#f47560', '#f1e15b', '#e8a838', '#61cdbb', '#97e3d5'] as const;

export const categoryColor = (index: number): string => CATEGORY_COLORS[index % CATEGORY_COLORS.length];

/** d3-color's `darker(k)`: each RGB channel times 0.7^k. Only `#rrggbb` is darkened; anything else is returned as is. */
export function darken(color: string, k: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return color;
  const rgb = parseInt(match[1], 16);
  const factor = Math.pow(0.7, k);
  const channel = (shift: number) =>
    Math.min(255, Math.round(((rgb >> shift) & 255) * factor))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

export interface ChartStyle {
  tick: { fill: string; fontSize: number };
  tickLine: false | { stroke: string };
  axisLabel: { fill: string; fontSize: number };
  gridStroke: string;
  gridDash?: string;
  surface: string;
  cursorStroke: string;
}

/** Axis, grid and label styles for the Joy-themed recharts charts. Admin charts pass `adminChartStyle` instead. */
export function useChartStyle({
  tickColor = 'tertiary',
  fontSize = 11,
}: { tickColor?: 'primary' | 'tertiary'; fontSize?: number } = {}): ChartStyle {
  const theme = useTheme();
  return {
    tick: { fill: theme.palette.text[tickColor], fontSize },
    tickLine: { stroke: '#777777' },
    axisLabel: { fill: theme.palette.text.primary, fontSize },
    gridStroke: theme.palette.divider,
    surface: theme.palette.background.surface,
    cursorStroke: theme.palette.text.tertiary,
  };
}

/** A recharts tooltip body: an optional color chip, then `label: value`. */
export const ChartTooltipCard: React.FC<{
  label: React.ReactNode;
  value?: React.ReactNode;
  color?: string;
  testId?: string;
}> = ({ label, value, color, testId }) => (
  <Box
    data-testid={testId}
    sx={{
      bgcolor: 'background.surface',
      color: 'text.primary',
      boxShadow: 'md',
      borderRadius: 'md',
      px: '9px',
      py: '5px',
      display: 'flex',
      alignItems: 'center',
      whiteSpace: 'pre',
    }}
  >
    {color && <Box component="span" sx={{ width: 12, height: 12, bgcolor: color, mr: '7px', flexShrink: 0 }} />}
    <span>
      {label}
      {value !== undefined && (
        <>
          : <strong>{value}</strong>
        </>
      )}
    </span>
  </Box>
);
