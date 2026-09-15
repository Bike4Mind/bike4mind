import { describe, it, expect } from 'vitest';
import { escapeMarkdown } from './markdownEscape';

describe('escapeMarkdown', () => {
  it('should escape markdown special characters', () => {
    expect(escapeMarkdown('*bold*')).toBe('\\*bold\\*');
    expect(escapeMarkdown('_italic_')).toBe('\\_italic\\_');
    expect(escapeMarkdown('`code`')).toBe('\\`code\\`');
    expect(escapeMarkdown('[link]')).toBe('\\[link\\]');
    expect(escapeMarkdown('<tag>')).toBe('&lt;tag&gt;');
  });

  it('neutralizes `@` mentions with a zero-width space', () => {
    // GitHub auto-links @user and @org/team - without neutralization, an LLM-
    // hallucinated mention would ping real users.
    expect(escapeMarkdown('cc @StormyEmery')).toBe('cc @​StormyEmery');
    expect(escapeMarkdown('contact @MillionOnMars/platform')).toBe('contact @​MillionOnMars/platform');
    expect(escapeMarkdown('email user@example.com')).toBe('email user@​example.com');
  });

  it('leaves @-free text otherwise unchanged', () => {
    expect(escapeMarkdown('plain text')).toBe('plain text');
  });
});
