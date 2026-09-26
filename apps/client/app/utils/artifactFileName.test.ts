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
});
