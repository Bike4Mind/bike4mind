import { describe, it, expect } from 'vitest';
import { assemblePrompt, EMPTY_SELECTIONS, PROMPT_BUILDER_CATEGORIES, PROMPT_SUGGESTIONS } from './taxonomy';

const sel = (overrides: Partial<typeof EMPTY_SELECTIONS>) => ({ ...EMPTY_SELECTIONS, ...overrides });

describe('assemblePrompt', () => {
  it('returns empty string with no selections and no free text', () => {
    expect(assemblePrompt(EMPTY_SELECTIONS)).toBe('');
  });

  it('builds a full natural-language prompt, subject-first', () => {
    const out = assemblePrompt(
      sel({
        style: ['cinematic'],
        subject: ['a lone figure'],
        scene: ['in a dense forest'],
        mood: ['dramatic and moody'],
        lighting: ['dramatic rim lighting'],
      })
    );
    expect(out).toBe(
      'A cinematic image of a lone figure, in a dense forest, dramatic and moody, with dramatic rim lighting.'
    );
  });

  it('capitalizes a subject-only prompt and terminates it', () => {
    expect(assemblePrompt(sel({ subject: ['a mountain landscape'] }))).toBe('A mountain landscape.');
  });

  it('handles style without a subject', () => {
    expect(assemblePrompt(sel({ style: ['watercolor'], mood: ['serene'] }))).toBe('A watercolor image, serene.');
  });

  it('joins multiple styles with commas and multiple subjects with "and"', () => {
    expect(
      assemblePrompt(sel({ style: ['photorealistic', 'cinematic'], subject: ['a lone figure', 'a small animal'] }))
    ).toBe('A photorealistic, cinematic image of a lone figure and a small animal.');
  });

  it('appends free text as its own sentence', () => {
    expect(assemblePrompt(sel({ subject: ['a city skyline'] }), 'shot on 35mm film')).toBe(
      'A city skyline. shot on 35mm film.'
    );
  });

  it('uses free text alone when nothing is selected', () => {
    expect(assemblePrompt(EMPTY_SELECTIONS, 'a serene mountain lake at dawn')).toBe('a serene mountain lake at dawn.');
  });

  it('does not double-terminate free text that already ends in punctuation', () => {
    expect(assemblePrompt(EMPTY_SELECTIONS, 'a robot barista!')).toBe('a robot barista!');
  });
});

describe('taxonomy shape', () => {
  it('has the five prose categories in order, no "quality"', () => {
    expect(PROMPT_BUILDER_CATEGORIES.map(c => c.key)).toEqual(['subject', 'scene', 'style', 'mood', 'lighting']);
  });

  it('autocomplete suggestions include every chip value and are de-duplicated', () => {
    const chipValues = PROMPT_BUILDER_CATEGORIES.flatMap(c => c.chips);
    chipValues.forEach(v => expect(PROMPT_SUGGESTIONS).toContain(v));
    expect(new Set(PROMPT_SUGGESTIONS).size).toBe(PROMPT_SUGGESTIONS.length);
  });
});
