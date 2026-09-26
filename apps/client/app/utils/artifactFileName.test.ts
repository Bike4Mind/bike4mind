import { describe, it, expect, vi, afterEach } from 'vitest';
import { artifactFileName } from './artifactFileName';

describe('artifactFileName', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('collapses whitespace to underscores like the pattern it replaces', () => {
    vi.useFakeTimers().setSystemTime(1700000000000);
    expect(artifactFileName('My Chart Title', 'png')).toBe('my_chart_title_1700000000000.png');
  });

  it('collapses path and OS-reserved characters instead of passing them through', () => {
    vi.useFakeTimers().setSystemTime(1700000000000);
    expect(artifactFileName('a/b:c?d*e"f<g>h|i\\j', 'txt')).toBe('a_b_c_d_e_f_g_h_i_j_1700000000000.txt');
  });

  it('trims leading and trailing separators left by stripped characters', () => {
    vi.useFakeTimers().setSystemTime(1700000000000);
    expect(artifactFileName('/../etc/passwd', 'txt')).toBe('etc_passwd_1700000000000.txt');
  });

  it('falls back when the title is empty, null, or undefined', () => {
    vi.useFakeTimers().setSystemTime(1700000000000);
    expect(artifactFileName('', 'mmd', 'mermaid-chart')).toBe('mermaid-chart_1700000000000.mmd');
    expect(artifactFileName(null, 'mmd', 'mermaid-chart')).toBe('mermaid-chart_1700000000000.mmd');
    expect(artifactFileName(undefined, 'mmd', 'mermaid-chart')).toBe('mermaid-chart_1700000000000.mmd');
  });

  it('falls back when only reserved characters remain after collapsing', () => {
    vi.useFakeTimers().setSystemTime(1700000000000);
    expect(artifactFileName('///', 'txt', 'file')).toBe('file_1700000000000.txt');
  });

  it('caps length at 80 characters and re-trims a separator the cut lands on', () => {
    vi.useFakeTimers().setSystemTime(1700000000000);
    // The 80th character of the collapsed title is the underscore from the space, so slicing
    // at 80 would otherwise leave a trailing separator for the cap to expose.
    const longTitle = 'a'.repeat(79) + ' ' + 'b'.repeat(5);
    expect(artifactFileName(longTitle, 'txt')).toBe(`${'a'.repeat(79)}_1700000000000.txt`);
  });

  it('lowercases the title', () => {
    vi.useFakeTimers().setSystemTime(1700000000000);
    expect(artifactFileName('UPPER CASE', 'py')).toBe('upper_case_1700000000000.py');
  });

  // Regression: the old `[^a-z0-9._-]` class only kept ASCII letters/digits, so a non-ASCII
  // title was wiped down to nothing but separators and fell all the way through to `fallback`.
  // Written as \u escapes rather than literal characters to keep this file ASCII-only (repo
  // convention), while still exercising the actual non-ASCII code points at runtime.
  it('keeps CJK characters instead of wiping the title to the fallback', () => {
    vi.useFakeTimers().setSystemTime(1700000000000);
    // '日本語のタイトル' is a Japanese title (no case to fold).
    const title = '日本語のタイトル';
    expect(artifactFileName(title, 'txt')).toBe(`${title}_1700000000000.txt`);
  });

  it('keeps accented characters instead of wiping the title to the fallback', () => {
    vi.useFakeTimers().setSystemTime(1700000000000);
    // 'Résumé Café' is "Résumé Café".
    expect(artifactFileName('Résumé Café', 'txt')).toBe('résumé_café_1700000000000.txt');
  });

  it('still strips path/OS-reserved characters and control characters from a non-ASCII title', () => {
    vi.useFakeTimers().setSystemTime(1700000000000);
    // '日本語/タイトル' is a Japanese title split by a stripped slash.
    expect(artifactFileName('日本語/タイトル', 'txt')).toBe('日本語_タイトル_1700000000000.txt');
    expect(artifactFileName('caf\u0000e\u0007', 'txt')).toBe('caf_e_1700000000000.txt');
  });
});
