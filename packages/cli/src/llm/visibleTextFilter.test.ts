import { describe, expect, it } from 'vitest';
import { stripThinkingBlocks } from './streamAccumulator';
import { VisibleTextFilter } from './visibleTextFilter';

/** Feed `chunks` through a fresh filter and return the concatenated output. */
const streamThrough = (chunks: string[]): string => {
  const filter = new VisibleTextFilter();
  return chunks.map(chunk => filter.push(chunk)).join('') + filter.end();
};

/** Every way to split `text` into two chunks, plus one char per chunk. */
const splits = (text: string): string[][] => [
  ...Array.from({ length: text.length + 1 }, (_, i) => [text.slice(0, i), text.slice(i)]),
  [...text],
];

describe('VisibleTextFilter', () => {
  it.each([
    'plain answer',
    '  padded answer \n',
    '<think>reasoning</think>The answer',
    'before <think>x</think> after',
    '<think>a<think>nested</think>tail',
    '<think>never closed',
    'stray </think> close',
    'a < b and <thin but not a tag',
    '<think>one</think> mid <think>two</think> end  ',
    '   ',
    '',
  ])('matches stripThinkingBlocks for every chunking of %j', text => {
    for (const chunks of splits(text)) {
      expect(streamThrough(chunks)).toBe(stripThinkingBlocks(text));
    }
  });

  it('releases visible text as soon as it is unambiguous', () => {
    const filter = new VisibleTextFilter();
    expect(filter.push('Hello')).toBe('Hello');
    expect(filter.push(' world')).toBe(' world');
  });

  it('holds back a possible tag prefix until the next chunk resolves it', () => {
    const filter = new VisibleTextFilter();
    expect(filter.push('a <thi')).toBe('a');
    expect(filter.push('nk>hidden</think>b')).toBe(' b');
  });

  it('holds trailing whitespace until more visible text follows', () => {
    const filter = new VisibleTextFilter();
    expect(filter.push('line\n\n')).toBe('line');
    expect(filter.push('next')).toBe('\n\nnext');
    expect(filter.push('\n')).toBe('');
    expect(filter.end()).toBe('');
  });

  it('emits nothing while inside a thinking block', () => {
    const filter = new VisibleTextFilter();
    expect(filter.push('<think>step one')).toBe('');
    expect(filter.push(' step two')).toBe('');
    expect(filter.push('</think>Done')).toBe('Done');
  });
});
