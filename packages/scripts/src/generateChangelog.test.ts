import { describe, it, expect } from 'vitest';
import { buildFallbackTitle } from './generateChangelog';

describe('buildFallbackTitle', () => {
  it('uses the single change as the title, capitalized', () => {
    expect(
      buildFallbackTitle([{ type: 'features', items: ['add settlement view to admin usage-margin endpoint'] }])
    ).toBe('Add settlement view to admin usage-margin endpoint');
  });

  it('summarizes multiple changes across sections by count', () => {
    expect(
      buildFallbackTitle([
        { type: 'features', items: ['a', 'b', 'c'] },
        { type: 'fixes', items: ['x', 'y'] },
      ])
    ).toBe('3 features and 2 fixes');
  });

  it('uses singular nouns for single-item sections in a multi-section summary', () => {
    expect(
      buildFallbackTitle([
        { type: 'features', items: ['a'] },
        { type: 'fixes', items: ['x'] },
      ])
    ).toBe('1 feature and 1 fix');
  });

  it('oxford-joins three or more sections', () => {
    expect(
      buildFallbackTitle([
        { type: 'features', items: ['a', 'b'] },
        { type: 'fixes', items: ['x'] },
        { type: 'performance', items: ['p', 'q'] },
      ])
    ).toBe('2 features, 1 fix, and 2 performance improvements');
  });

  it('ignores empty sections when counting', () => {
    expect(
      buildFallbackTitle([
        { type: 'features', items: [] },
        { type: 'fixes', items: ['only one'] },
      ])
    ).toBe('Only one');
  });

  it('degrades to a generic title only when nothing is categorized', () => {
    expect(buildFallbackTitle([])).toBe('Production Release');
    expect(buildFallbackTitle([{ type: 'internal', items: [] }])).toBe('Production Release');
  });
});
