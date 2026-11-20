import { describe, expect, it } from 'vitest';
import { CHART_ACCENT, CHART_MUTED, adminChartSeries } from './chartTheme';

const opacityOf = (color: string) =>
  color === CHART_ACCENT ? 100 : Number(/ (\d+)%, transparent\)$/.exec(color)?.[1]);

describe('adminChartSeries', () => {
  it('starts on the accent and steps it down in opacity to 30%', () => {
    expect(adminChartSeries(3)).toEqual([
      'var(--joy-palette-admin-accent)',
      'color-mix(in srgb, var(--joy-palette-admin-accent) 65%, transparent)',
      'color-mix(in srgb, var(--joy-palette-admin-accent) 30%, transparent)',
    ]);
  });

  it('gives each of many categories its own, strictly fainter step', () => {
    const series = adminChartSeries(8);
    expect(new Set(series).size).toBe(8);
    const opacities = series.map(opacityOf);
    expect(opacities[0]).toBe(100);
    expect(opacities.at(-1)).toBe(30);
    opacities.slice(1).forEach((opacity, index) => expect(opacity).toBeLessThan(opacities[index]));
  });

  it('handles one category and none', () => {
    expect(adminChartSeries(1)).toEqual([CHART_ACCENT]);
    expect(adminChartSeries(0)).toEqual([]);
  });

  it('only ever names admin tokens, never a hex or rgb color', () => {
    for (const color of [...adminChartSeries(12), CHART_MUTED]) {
      expect(color).toMatch(/var\(--joy-palette-admin-(accent|inkMuted)\)/);
      expect(color).not.toMatch(/#[0-9a-f]|rgba?\(/i);
    }
  });
});
