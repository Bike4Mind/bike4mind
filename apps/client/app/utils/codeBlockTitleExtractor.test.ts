import { describe, it, expect } from 'vitest';
import { extractCodeBlockTitle } from './codeBlockTitleExtractor';

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
