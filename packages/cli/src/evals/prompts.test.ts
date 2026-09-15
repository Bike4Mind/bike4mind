import { describe, it, expect } from 'vitest';
import { getPromptVariant, isPromptVariant, PROMPT_VARIANTS } from './prompts';

describe('prompt variants', () => {
  it('exports both current and minimal in PROMPT_VARIANTS', () => {
    expect(PROMPT_VARIANTS).toContain('current');
    expect(PROMPT_VARIANTS).toContain('minimal');
  });

  it('returns undefined for "current" so the agent default fires', () => {
    expect(getPromptVariant('current')).toBeUndefined();
  });

  it('returns a non-empty string for "minimal"', () => {
    const prompt = getPromptVariant('minimal');
    expect(prompt).toBeDefined();
    expect(prompt!.length).toBeGreaterThan(0);
  });

  it('minimal prompt is meaningfully shorter than 1KB', () => {
    // The whole point of minimal is to be small. If it grows past 1KB
    // we've stopped doing the experiment we set out to do.
    const prompt = getPromptVariant('minimal');
    expect(prompt!.length).toBeLessThan(1000);
  });

  it('isPromptVariant guards against unknown names', () => {
    expect(isPromptVariant('current')).toBe(true);
    expect(isPromptVariant('minimal')).toBe(true);
    expect(isPromptVariant('mystery')).toBe(false);
    expect(isPromptVariant('')).toBe(false);
  });
});
