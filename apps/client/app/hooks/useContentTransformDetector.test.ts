import { describe, it, expect, vi } from 'vitest';
import {
  GROWTH_RATIO_CEILING,
  SMALL_INPUT_MS_CEILING,
  measureGrowth,
  regexDivergences,
  seededCorpus,
} from '@client/__tests__/utils/regexLinearity';

vi.mock('./data/sessions', () => ({ useGetSessionQuests: vi.fn() }));

import { parseContentTransformResponse } from './useContentTransformDetector';

/** Index, end and trimmed value of group `g`, or null: what the parser can observe. */
const observe = (re: RegExp, s: string, g: number) => {
  const m = s.match(re);
  return m ? JSON.stringify([m.index, (m.index ?? 0) + m[0].length, (m[g] ?? '').trim()]) : null;
};

describe('parseContentTransformResponse', () => {
  it('parses a fenced JSON response and the formatted fallback', () => {
    const json = '```json\n{"title":"T","content":"C","summary":"S","suggestedTags":["a"]}\n```';
    expect(parseContentTransformResponse(json)).toEqual({
      title: 'T',
      content: 'C',
      summary: 'S',
      suggestedTags: ['a'],
    });
    const text = '**Title:**  My doc\n**Summary:** Short\n**Suggested Tags:** a, b\n**Content Preview:**\nBody\n---';
    expect(parseContentTransformResponse(text)).toEqual({
      title: 'My doc',
      content: 'Body',
      summary: 'Short',
      suggestedTags: ['a', 'b'],
    });
  });

  it('now rejects a title line that is blank to the end of input', () => {
    // Old: the backtracking \s* left one space for (.+?), so the title parsed as ''. New: no title.
    expect(parseContentTransformResponse('**Content Preview:**\nBody\n---\n**Title:**   ')).toBeNull();
  });

  // The old regexes took about 1s per call at these sizes.
  it.each([
    ['newlines after an unclosed json fence', (n: number) => '```json' + '\n'.repeat(n) + 'x', 96000],
    ['space-newline pairs after an unclosed json fence', (n: number) => '```json' + ' \n'.repeat(n) + 'x', 64000],
    [
      'spaces ending in a carriage return after a title label',
      (n: number) => '**Title:**' + ' '.repeat(n) + '\r',
      64000,
    ],
    ['newlines after a content preview label', (n: number) => '**Content Preview:**' + '\n'.repeat(n) + 'x', 40000],
    [
      'space-newline pairs after a content preview label',
      (n: number) => '**Content Preview:**' + ' \n'.repeat(n) + 'x',
      40000,
    ],
  ])('stays linear on %s', (_label, build, small) => {
    const { baselineMs, ratio } = measureGrowth(parseContentTransformResponse, build, small);
    expect(baselineMs).toBeLessThan(SMALL_INPUT_MS_CEILING);
    expect(ratio).toBeLessThan(GROWTH_RATIO_CEILING);
  });

  const pieces = ['```', '```json', 'json', ' ', '\n', '\t', '\r', '\u2028', '{"a":1}', 'x', '`', '\n```'];

  it.each([
    [/```json\s*\n([\s\S]*?)\n```/, /```json[^\S\n]*\n([\s\S]*?)\n```/],
    [/```\s*\n([\s\S]*?)\n```/, /```[^\S\n]*\n([\s\S]*?)\n```/],
  ])('matches the old fence regex %s on seeded input once captures are trimmed', (oldRe, newRe) => {
    const corpus = seededCorpus(2998, 3000, pieces);
    expect(corpus.filter(s => newRe.test(s)).length).toBeGreaterThan(50);
    const diverged = regexDivergences(oldRe, newRe, corpus);
    // Expected divergence: after blank lines and a closer, old skipped past that closer to a later
    // one while new stops at it with a blank body. Old's body then starts with ``` and new's is
    // empty, so JSON.parse throws on both and the parser returns null either way.
    for (const s of diverged) {
      expect(s.match(newRe)![1].trim()).toBe('');
      expect(s.match(oldRe)![1].trim().startsWith('```')).toBe(true);
    }
    // Control: a greedy body does diverge, so this differential can fail.
    expect(regexDivergences(oldRe, new RegExp(newRe.source.replace('*?', '*')), corpus).length).toBeGreaterThan(0);
  });

  it.each(['Title', 'Summary', 'Suggested Tags'])('matches the old %s regex except on blank values', label => {
    const oldRe = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+?)(?:\\n|$)`);
    const newRe = new RegExp(`\\*\\*${label}:\\*\\*(?=(\\s*))\\1(.+?)(?:\\n|$)`);
    const corpus = seededCorpus(2998, 3000, [`**${label}:**`, ' ', '\n', '\t', '\r', '\u2028', 'x', 'My doc']);
    expect(corpus.filter(s => newRe.test(s)).length).toBeGreaterThan(300);
    const diverged = corpus.filter(s => observe(oldRe, s, 1) !== observe(newRe, s, 2));
    // Old let (.+?) take whitespace when nothing else was left on the line; new never does.
    expect(diverged.length).toBeGreaterThan(0);
    for (const s of diverged) expect(s.match(oldRe)![1].trim()).toBe('');
  });

  it('matches the old content preview regex except where blank lines precede the separator', () => {
    const oldRe = /\*\*Content Preview[^:]*:\*\*\s*\n([\s\S]+?)(?:\n---|\n\*\*Next Steps|\n$)/;
    const newRe = /\*\*Content Preview[^:]*:\*\*[^\S\n]*\n([\s\S]+?)(?:\n---|\n\*\*Next Steps|\n$)/;
    const corpus = seededCorpus(2998, 6000, ['**Content Preview:**', '\n---', '---', ' ', '\n', '\t', 'x', 'Body'], 16);
    expect(corpus.filter(s => newRe.test(s)).length).toBeGreaterThan(30);
    const diverged = regexDivergences(oldRe, newRe, corpus);
    // Expected divergence: old skipped the blank lines and captured past the --- separator; new
    // stops at it with an empty preview.
    expect(diverged.length).toBeGreaterThan(0);
    for (const s of diverged) expect(s.match(newRe)![1].trim()).toBe('');
  });
});
