import { describe, expect, it } from 'vitest';
import { estimateCaptionMaxLineChars, wrapStudioCaption } from './wrapCaption';

describe('wrapStudioCaption', () => {
  it('keeps a short caption on one line', () => {
    expect(wrapStudioCaption('Hello world', 20)).toEqual(['Hello world']);
  });

  it('wraps greedily at word boundaries', () => {
    expect(wrapStudioCaption('the quick brown fox jumps over', 10)).toEqual(['the quick', 'brown fox', 'jumps over']);
  });

  it('honors explicit line breaks, including CRLF and blank lines', () => {
    expect(wrapStudioCaption('one\r\ntwo three\n\nfour', 20)).toEqual(['one', 'two three', '', 'four']);
  });

  it('leaves an overlong word whole on its own line', () => {
    expect(wrapStudioCaption('a supercalifragilistic b', 8)).toEqual(['a', 'supercalifragilistic', 'b']);
  });

  it('collapses runs of whitespace', () => {
    expect(wrapStudioCaption('  a    b  ', 10)).toEqual(['a b']);
  });

  it('wraps exactly at the limit', () => {
    expect(wrapStudioCaption('abcd efgh', 9)).toEqual(['abcd efgh']);
    expect(wrapStudioCaption('abcd efgh', 8)).toEqual(['abcd', 'efgh']);
  });
});

describe('estimateCaptionMaxLineChars', () => {
  it('divides the width by the average glyph advance', () => {
    expect(estimateCaptionMaxLineChars(600, 50)).toBe(20);
  });

  it('never returns less than one', () => {
    expect(estimateCaptionMaxLineChars(5, 100)).toBe(1);
  });
});
