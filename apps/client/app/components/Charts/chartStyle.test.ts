import { describe, it, expect } from 'vitest';
import { CATEGORY_COLORS, categoryColor, darken } from './chartStyle';

describe('darken', () => {
  // Expected values are d3-color's rgb(c).darker(k).formatHex().
  it.each([
    ['#e8c1a0', 2, '#725f4e'],
    ['#e8c1a0', 1.6, '#836d5a'],
    ['#f47560', 0.2, '#e36d59'],
    ['#97e3d5', 2, '#4a6f68'],
  ])('darkens %s by %s to %s', (color, k, expected) => {
    expect(darken(color, k)).toBe(expected);
  });

  it('returns a color it cannot parse unchanged', () => {
    expect(darken('var(--joy-palette-primary-500)', 2)).toBe('var(--joy-palette-primary-500)');
  });
});

describe('categoryColor', () => {
  it('cycles through the palette', () => {
    expect(categoryColor(0)).toBe(CATEGORY_COLORS[0]);
    expect(categoryColor(CATEGORY_COLORS.length + 1)).toBe(CATEGORY_COLORS[1]);
  });
});
