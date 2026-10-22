import { describe, expect, it } from 'vitest';
import { insertSnippet } from './insertSnippet';

describe('insertSnippet', () => {
  it('fills an empty field and leaves the caret on the next line', () => {
    expect(insertSnippet('', '[Verse]', 0, 0)).toEqual({ value: '[Verse]\n', caret: 8 });
  });

  it('starts a new line when the caret is mid-line', () => {
    expect(insertSnippet('la la', '[Chorus]', 5, 5)).toEqual({ value: 'la la\n[Chorus]\n', caret: 15 });
  });

  it('does not double a line break that is already there', () => {
    const result = insertSnippet('one\n\ntwo', '[Bridge]', 4, 4);
    expect(result.value).toBe('one\n[Bridge]\ntwo');
    expect(result.value.slice(result.caret)).toBe('two');
  });

  it('replaces the selected text', () => {
    expect(insertSnippet('a\nOLD\nb', '[Verse]', 2, 5).value).toBe('a\n[Verse]\nb');
  });
});
