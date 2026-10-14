import { describe, expect, it } from 'vitest';
import type { B4MLLMTools } from '@bike4mind/common';
import { filterToolsForDisplay, isToolDenied } from './toolMapping';

describe('isToolDenied', () => {
  it('denies nothing when there is no denylist yet', () => {
    expect(isToolDenied('dice_roll', undefined)).toBe(false);
  });

  it('denies nothing for an empty denylist', () => {
    expect(isToolDenied('dice_roll', [])).toBe(false);
  });

  it('denies a listed tool', () => {
    expect(isToolDenied('dice_roll', ['web_search', 'dice_roll'])).toBe(true);
  });

  it('does not deny an unlisted tool', () => {
    expect(isToolDenied('web_search', ['dice_roll'])).toBe(false);
  });

  it('matches ids exactly, never by prefix or substring', () => {
    expect(isToolDenied('image', ['image_generation'])).toBe(false);
    expect(isToolDenied('image_generation', ['image'])).toBe(false);
  });
});

describe('filterToolsForDisplay with a session denylist', () => {
  const enabled = ['web_search', 'dice_roll', 'image_generation'] as B4MLLMTools[];

  it('is unchanged for an undefined or empty denylist', () => {
    expect(filterToolsForDisplay(enabled, undefined, undefined)).toEqual(enabled);
    expect(filterToolsForDisplay(enabled, undefined, [])).toEqual(enabled);
  });

  it('drops a denied tool and keeps the rest in order', () => {
    expect(filterToolsForDisplay(enabled, undefined, ['dice_roll'])).toEqual(['web_search', 'image_generation']);
  });

  it('combines with a missing-key availability gate', () => {
    expect(filterToolsForDisplay(enabled, { web_search: false }, ['dice_roll'])).toEqual(['image_generation']);
  });

  it('does not mutate the input array', () => {
    const input = [...enabled];
    filterToolsForDisplay(input, { web_search: false }, ['dice_roll']);
    expect(input).toEqual(enabled);
  });
});
