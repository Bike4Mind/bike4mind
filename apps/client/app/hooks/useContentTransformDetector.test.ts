import { describe, it, expect, vi } from 'vitest';
import {
  GROWTH_RATIO_CEILING,
  SMALL_INPUT_MS_CEILING,
  measureGrowth,
  regexDivergences,
  seededCorpus,
} from '@client/__tests__/utils/regexLinearity';

vi.mock('./data/sessions', () => ({ useGetSessionQuests: vi.fn() }));

import {
  matchContentPreview,
  matchLabelValue,
  matchNewlineFence,
  parseContentTransformResponse,
} from './useContentTransformDetector';

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

  it.each(['**Title:**   ', '**Title:** \n'])('parses a blank title line %j as an empty title', titleLine => {
    // The backtracking \s* leaves one space for (.+?), so a blank title still counts as present.
    expect(parseContentTransformResponse('**Content Preview:**\nBody\n---\n' + titleLine)).toEqual({
      title: '',
      content: 'Body',
      summary: '',
      suggestedTags: [],
    });
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
    ['repeated json openers with no newline closer', (n: number) => '```json\nx'.repeat(n), 40000],
    ['repeated bare openers with no newline closer', (n: number) => '```\nx'.repeat(n), 40000],
    ['repeated title labels on a CR-terminated line', (n: number) => '**Title:** '.repeat(n) + '\r', 16000],
    ['repeated title labels with values on a CR-terminated line', (n: number) => '**Title:**a'.repeat(n) + '\r', 16000],
    ['repeated content preview labels with no end', (n: number) => '**Content Preview:**\n'.repeat(n) + 'x', 16000],
    ['repeated content preview openers with no colon', (n: number) => '**Content Preview'.repeat(n), 16000],
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

  it.each(['Title', 'Summary', 'Suggested Tags'])('captures exactly what the old %s regex did', label => {
    const oldRe = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+?)(?:\\n|$)`);
    const corpus = seededCorpus(2998, 6000, [`**${label}:**`, ' ', '\n', '\t', '\r', '\u2028', 'x', 'My doc']);
    expect(corpus.filter(s => oldRe.test(s)).length).toBeGreaterThan(300);
    expect(corpus.filter(s => matchLabelValue(s, `**${label}:**`) !== (s.match(oldRe)?.[1] ?? null))).toEqual([]);
  });

  it('scanners capture exactly what the fence and content preview regexes did', () => {
    const previewPieces = [
      '**Content Preview:**',
      '**Content Preview',
      ':**',
      ':',
      '\n---',
      '\n**Next Steps',
      ' ',
      '\n',
      'x',
    ];
    const cases: Array<[RegExp, (s: string) => string | null, string[]]> = [
      [/```json[^\S\n]*\n([\s\S]*?)\n```/, s => matchNewlineFence(s, 'json'), pieces],
      [/```[^\S\n]*\n([\s\S]*?)\n```/, s => matchNewlineFence(s, ''), pieces],
      [
        /\*\*Content Preview[^:]*:\*\*[^\S\n]*\n([\s\S]+?)(?:\n---|\n\*\*Next Steps|\n$)/,
        matchContentPreview,
        previewPieces,
      ],
    ];
    for (const [re, scan, corpusPieces] of cases) {
      const corpus = seededCorpus(2998, 8000, corpusPieces, 16);
      expect(corpus.filter(s => re.test(s)).length).toBeGreaterThan(30);
      expect(corpus.filter(s => scan(s) !== (s.match(re)?.[1] ?? null))).toEqual([]);
    }
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
