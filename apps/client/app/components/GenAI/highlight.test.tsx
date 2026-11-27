import { isValidElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { highlightTextSearch } from './highlight';

const shape = (parts: ReactNode) =>
  (parts as ReactNode[]).map(part =>
    isValidElement<{ children: ReactNode }>(part) ? ['mark', part.props.children] : part
  );

describe('highlightTextSearch', () => {
  it('marks a literal match and keeps the surrounding text', () => {
    expect(shape(highlightTextSearch('find the needle here', 'needle'))).toEqual([
      'find the ',
      ['mark', 'needle'],
      ' here',
    ]);
  });

  it('matches case-insensitively and keeps the original casing', () => {
    expect(shape(highlightTextSearch('Needle needle NEEDLE', 'needle'))).toEqual([
      '',
      ['mark', 'Needle'],
      ' ',
      ['mark', 'needle'],
      ' ',
      ['mark', 'NEEDLE'],
      '',
    ]);
  });

  it.each([
    ['a.b', 'a.b axb', ['', ['mark', 'a.b'], ' axb']],
    ['a-b', 'a-b a b', ['', ['mark', 'a-b'], ' a b']],
    ['why?', 'why? wh', ['', ['mark', 'why?'], ' wh']],
    ['hi!', 'oh hi! hi', ['oh ', ['mark', 'hi!'], ' hi']],
    ['1,000', 'paid 1,000 or 1000', ['paid ', ['mark', '1,000'], ' or 1000']],
  ])('treats %j as literal text, not as a pattern', (search, text, expected) => {
    expect(shape(highlightTextSearch(text, search))).toEqual(expected);
  });

  it('returns the input untouched for a search with characters outside the safe set', () => {
    expect(highlightTextSearch('a+b (c)', 'a+b')).toBe('a+b (c)');
  });

  it('returns the node untouched when there is nothing to search for', () => {
    expect(highlightTextSearch('text', '')).toBe('text');
    expect(highlightTextSearch('text')).toBe('text');
  });

  it('marks inside each string child of an array and passes non-strings through', () => {
    const element = <b>bold</b>;
    const result = highlightTextSearch(['one two', element, 'two'], 'two') as ReactNode[];
    expect(shape(result.slice(0, 3))).toEqual(['one ', ['mark', 'two'], '']);
    expect(result[3]).toBe(element);
    expect(shape(result.slice(4))).toEqual(['', ['mark', 'two'], '']);
  });
});
