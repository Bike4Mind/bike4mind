import { describe, it, expect } from 'vitest';
import { stripInlineMarkdown } from './plainTitle';

describe('stripInlineMarkdown', () => {
  it.each([
    ['Session 1 Recap: *Tides of the Drowned Crown*', 'Session 1 Recap: Tides of the Drowned Crown'],
    ['**Bold** and _italic_ and ~~gone~~', 'Bold and italic and gone'],
    ['Use `npm ci` here', 'Use npm ci here'],
    ['See [the docs](https://example.com/docs)', 'See the docs'],
    ['***Both***', 'Both'],
  ])('%j -> %j', (input, expected) => {
    expect(stripInlineMarkdown(input)).toBe(expected);
  });

  it.each(['snake_case_name stays', '5 * 3 = 15', 'Price: 2 * 4 * 6'])('leaves %j alone', input => {
    expect(stripInlineMarkdown(input)).toBe(input);
  });
});
