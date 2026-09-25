import { describe, it, expect } from 'vitest';
import { clearTitleCache, extractCodeBlockTitle, findSelectFromTable } from './codeBlockTitleExtractor';
import {
  GROWTH_RATIO_CEILING,
  SMALL_INPUT_MS_CEILING,
  measureGrowth,
  regexDivergences,
  seededCorpus,
} from '@client/__tests__/utils/regexLinearity';

describe('extractCodeBlockTitle', () => {
  it('prefers an explicit title, trimmed', () => {
    expect(extractCodeBlockTitle('SELECT 1', 'sql', '  My Report  ')).toBe('My Report');
  });

  it('extracts a function name from JavaScript', () => {
    expect(extractCodeBlockTitle('function doThing() {}', 'js')).toBe('doThing');
  });

  it('extracts the table from a SELECT query', () => {
    expect(extractCodeBlockTitle('SELECT id FROM customers WHERE id = 1', 'sql')).toBe('Query customers');
  });

  it('falls back to the language label when no construct matches', () => {
    expect(extractCodeBlockTitle('-- nothing to name here', 'sql')).toBe('Sql Code Block');
  });

  // The title comes from the head of the block, so a construct sitting beyond the
  // MAX_TITLE_SCAN_CHARS (8192) window is intentionally not seen. This is the
  // observable proof the input is bounded before the per-language regexes run.
  it('does not scan a construct that sits beyond the head window', () => {
    const beyondCap = ' '.repeat(9000) + 'SELECT id FROM realtable';
    expect(extractCodeBlockTitle(beyondCap, 'sql')).toBe('Sql Code Block');

    const withinCap = 'SELECT id FROM realtable' + ' '.repeat(9000);
    expect(extractCodeBlockTitle(withinCap, 'sql')).toBe('Query realtable');
  });

  // Regression: the SQL matcher's `SELECT ... FROM` scan grows super-linearly with
  // block size. Uncapped, a ~1MB block drove it past vitest's per-test timeout; the
  // head cap bounds the scan to a few milliseconds regardless of block size.
  it('bounds an oversized SELECT-heavy block instead of stalling', () => {
    const oversized = 'SELECT '.repeat(150_000); // ~1.05MB, no FROM anywhere
    // The lazy SELECT ... FROM scan finds no match on the capped head and falls through
    // to the generic query-type branch. The point is that it returns at all: uncapped,
    // this scan runs past vitest's per-test timeout before reaching this line.
    expect(extractCodeBlockTitle(oversized, 'sql')).toBe('SQL Query');
  });
});

describe('codeBlockTitleExtractor - comment and SELECT regexes', () => {
  const titleOf = (language: string) => (code: string) => {
    clearTitleCache();
    return extractCodeBlockTitle(code, language);
  };

  it('still reads comments and SELECT targets', () => {
    expect(titleOf('html')('<div><!--  Pricing table  --></div>')).toBe('Pricing table');
    expect(titleOf('css')('/*  Card styles  */ .x {}')).toBe('Card styles');
    expect(titleOf('sql')('SELECT id, name\n  FROM users')).toBe('Query users');
    expect(findSelectFromTable('select   from t')).toBeNull();
  });

  // The old regexes took about 0.2-2s per call at these sizes (inputs stay under the 8192 scan cap).
  it.each([
    ['html', 'newlines in an unclosed comment', (n: number) => '<!--' + '\n'.repeat(n) + 'x', 2000],
    ['html', 'space-newline pairs in an unclosed comment', (n: number) => '<!--' + ' \n'.repeat(n) + 'x', 1000],
    ['css', 'newlines in an unclosed comment', (n: number) => '/*' + '\n'.repeat(n) + 'x', 2000],
    ['css', 'space-newline pairs in an unclosed comment', (n: number) => '/*' + ' \n'.repeat(n) + 'x', 1000],
    ['sql', 'spaces after SELECT with no FROM', (n: number) => 'SELECT' + ' '.repeat(n) + 'x', 2000],
    // The scan cap kept this one fast before the fix too; it pins the scanner across SELECT starts.
    ['sql', 'repeated SELECT openers on one line', (n: number) => 'SELECT a '.repeat(n), 400],
  ])('%s: stays linear on %s', (language, _label, build, small) => {
    const { baselineMs, ratio } = measureGrowth(titleOf(language), build, small);
    expect(baselineMs).toBeLessThan(SMALL_INPUT_MS_CEILING);
    expect(ratio).toBeLessThan(GROWTH_RATIO_CEILING);
  });

  it.each([
    [/<!--\s*([^-]+?)\s*-->/, /<!--([^-]+?)-->/, /<!--([\s\S]+?)-->/, ['<!--', '-->', '-', '--']],
    [/\/\*\s*([^*]+?)\s*\*\//, /\/\*([^*]+?)\*\//, /\/\*([\s\S]+?)\*\//, ['/*', '*/', '*', '/']],
  ])('matches the old comment regex %s on seeded input once captures are trimmed', (oldRe, newRe, control, markers) => {
    const corpus = seededCorpus(2998, 3000, [...markers, ' ', '\n', '\t', '\r', 'x', 'Title']);
    expect(corpus.filter(s => newRe.test(s)).length).toBeGreaterThan(50);
    expect(regexDivergences(oldRe, newRe, corpus)).toEqual([]);
    // Control: a body that may cross the marker character diverges, so this differential can fail.
    expect(regexDivergences(oldRe, control, corpus).length).toBeGreaterThan(0);
  });

  it('finds the table the old SELECT regex found, except after a whitespace-only column list', () => {
    const OLD = /SELECT\s+.+?\s+FROM\s+([a-zA-Z_][a-zA-Z0-9_]*)/i;
    const pieces = ['SELECT ', 'select', ' FROM ', 'from', ' ', '\n', '\t', '\r', '\u2028', 'a', 'users', '*', ','];
    const corpus = seededCorpus(2998, 4000, pieces, 14);
    expect(corpus.filter(s => findSelectFromTable(s) !== null).length).toBeGreaterThan(100);
    const diverged = corpus.filter(s => findSelectFromTable(s) !== (s.match(OLD)?.[1] ?? null));
    // Pinned: old matched SELECT<ws>FROM with only whitespace between; the scanner requires a column.
    expect(diverged.length).toBeGreaterThan(0);
    for (const s of diverged) expect(s.match(OLD)![0]).toMatch(/^SELECT\s+FROM\s/i);
  });
});
