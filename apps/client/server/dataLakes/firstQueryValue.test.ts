import { describe, it, expect } from 'vitest';
import { firstQueryValue } from './firstQueryValue';

describe('firstQueryValue', () => {
  it('passes a single string through unchanged', () => {
    expect(firstQueryValue('onboarding')).toBe('onboarding');
  });

  it('narrows a repeated query param to its first value', () => {
    expect(firstQueryValue(['onboarding', 'other'])).toBe('onboarding');
  });

  it('passes undefined through unchanged', () => {
    expect(firstQueryValue(undefined)).toBeUndefined();
  });

  it('returns undefined for an empty array', () => {
    expect(firstQueryValue([])).toBeUndefined();
  });
});
