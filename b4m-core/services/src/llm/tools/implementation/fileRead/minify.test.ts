import { describe, it, expect, vi } from 'vitest';
import { normalizeWhitespace, estimateTokens, minifyFileContent } from './minify';

describe('normalizeWhitespace', () => {
  it('normalizes CRLF to LF', () => {
    expect(normalizeWhitespace('a\r\nb\r\nc')).toBe('a\nb\nc');
  });

  it('strips trailing whitespace on each line', () => {
    expect(normalizeWhitespace('a   \nb\t\n')).toBe('a\nb');
  });

  it('collapses runs of blank lines to a single blank line', () => {
    expect(normalizeWhitespace('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('trims leading and trailing blank lines', () => {
    expect(normalizeWhitespace('\n\na\n\n')).toBe('a');
  });

  it('never removes non-whitespace content', () => {
    const code = 'const x = 1;\nconst y = 2;';
    expect(normalizeWhitespace(code)).toBe(code);
  });
});

describe('estimateTokens', () => {
  it('approximates ~4 chars per token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('minifyFileContent', () => {
  it('uses the injected minifier and reports comments stripped + tokens saved', async () => {
    const raw = '// a comment that adds bulk to the file\nconst x = 1;\n';
    const codeMinifier = vi.fn(async () => 'const x = 1;\n');

    const result = await minifyFileContent(raw, '/repo/file.ts', codeMinifier);

    expect(codeMinifier).toHaveBeenCalledWith(raw, '.ts');
    expect(result.strippedComments).toBe(true);
    expect(result.content).toBe('const x = 1;');
    expect(result.tokensSaved).toBeGreaterThan(0);
  });

  it('falls back to whitespace-only normalization (comments preserved) when the minifier declines', async () => {
    const raw = '# yaml-ish comment\nkey:   value   \n\n\n';
    const codeMinifier = vi.fn(async () => null);

    const result = await minifyFileContent(raw, '/repo/config.yaml', codeMinifier);

    expect(result.strippedComments).toBe(false);
    expect(result.content).toContain('# yaml-ish comment'); // comment kept
    expect(result.content).toBe('# yaml-ish comment\nkey:   value'); // trailing/blank normalized
  });

  it('falls back safely when the minifier throws', async () => {
    const raw = 'const x = 1;\n';
    const codeMinifier = vi.fn(async () => {
      throw new Error('boom');
    });

    const result = await minifyFileContent(raw, '/repo/file.ts', codeMinifier);

    expect(result.strippedComments).toBe(false);
    expect(result.content).toBe('const x = 1;');
  });

  it('falls back to whitespace-only when no minifier is injected', async () => {
    const raw = '// comment\nconst x = 1;\n';
    const result = await minifyFileContent(raw, '/repo/file.ts');

    expect(result.strippedComments).toBe(false);
    expect(result.content).toContain('// comment');
  });
});
