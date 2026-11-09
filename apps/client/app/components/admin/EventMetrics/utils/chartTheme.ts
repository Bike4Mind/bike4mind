import { ACCENT, AXIS_TICK, BAD, BORDER, GOOD, INK, INK_MUTED } from '../../Revenue/chartParts';

// recharts paints SVG attributes and inline styles, so colors are the admin CSS variables (shared with
// Revenue/chartParts.tsx) rather than sx tokens. The presets below replace every recharts default that
// paints a hex color on these charts: grid, axes, tooltip, cursor, slice edges and line dots. (The
// legend's inactive color never shows: no series can be hidden.)
const SURFACE = 'var(--joy-palette-admin-surface)';
const HOVER = 'var(--joy-palette-admin-hover)';
/** The faintest categorical step, as a share of `accent`. */
const MIN_SERIES_OPACITY = 0.3;

export { ACCENT as CHART_ACCENT, BAD as CHART_BAD, GOOD as CHART_GOOD };

/** A category with no assigned color: `inkMuted` at 40%, the guide's comparison tone. */
export const CHART_MUTED = `color-mix(in srgb, ${INK_MUTED} 40%, transparent)`;

/**
 * Colors for `count` categories that are not statuses (DESIGN_GUIDE "Data visualization"): `accent`
 * first, then `accent` stepped down in opacity to 30% for the last.
 */
export function adminChartSeries(count: number): string[] {
  return Array.from({ length: Math.max(0, count) }, (_, index) => {
    if (index === 0) return ACCENT;
    const opacity = 1 - ((1 - MIN_SERIES_OPACITY) * index) / (count - 1);
    return `color-mix(in srgb, ${ACCENT} ${Math.round(opacity * 100)}%, transparent)`;
  });
}

export const chartGridProps = { stroke: BORDER, strokeDasharray: '3 3' };
export const chartAxisProps = { tick: AXIS_TICK, tickLine: false, axisLine: { stroke: BORDER } };
export const chartTooltipProps = {
  cursor: { fill: HOVER, stroke: HOVER },
  contentStyle: {
    backgroundColor: SURFACE,
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    color: INK,
    fontSize: 12,
  },
  labelStyle: { color: INK_MUTED },
  itemStyle: { color: INK },
};
export const chartLegendProps = { wrapperStyle: { fontSize: 12 }, labelStyle: { color: INK_MUTED } };
/** Slice edges in the card color, so slices part without a white outline in dark mode. */
export const chartPieProps = { stroke: SURFACE };
/** Line dots in the accent; the hovered dot's ring takes the card color instead of white. */
export const chartLineDotProps = { dot: { fill: ACCENT, stroke: ACCENT }, activeDot: { stroke: SURFACE } };
/** Pie slice labels in `inkMuted`, so a faint slice color never sets the text color. */
export const CHART_LABEL_FILL = INK_MUTED;
