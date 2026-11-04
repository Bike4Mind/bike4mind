import { describe, expect, it } from 'vitest';
import { COMPARISON_OPACITY, INK_MUTED } from './chartParts';
import { planColor } from './RevenueCharts';
import { OTHER_PLANS_KEY, type PlanSeries } from './revenueChartData';

const named = (count: number): PlanSeries[] =>
  Array.from({ length: count }, (_, index) => ({ key: `plan-${index}`, label: `Plan ${index}` }));

describe('planColor', () => {
  it('gives each of five named plans its own opacity, stepping down', () => {
    const series = named(5);
    const opacities = series.map(entry => planColor(series, entry.key).opacity);
    expect(new Set(opacities).size).toBe(5);
    expect(opacities).toEqual([...opacities].sort((a, b) => b - a));
  });

  it('draws the folded Other plans in the comparison grey', () => {
    const series = [...named(4), { key: OTHER_PLANS_KEY, label: 'Other plans' }];
    expect(planColor(series, OTHER_PLANS_KEY)).toEqual({ color: INK_MUTED, opacity: COMPARISON_OPACITY });
  });
});
