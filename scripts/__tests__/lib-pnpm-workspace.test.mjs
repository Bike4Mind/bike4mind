import { describe, it, expect } from 'vitest';
import { parseOverrides, renderOverrides } from '../lib-pnpm-workspace.mjs';

const YAML = [
  'packages:',
  '  - apps/*',
  '',
  '# note',
  'overrides:',
  '  esbuild: 0.28.1',
  '  "@smithy/core": "3.35.0"',
  '  "katex@<0.18.2": "0.18.10"',
  '',
  'onlyBuiltDependencies:',
  '  - "sharp"',
  '',
].join('\n');

describe('parseOverrides', () => {
  it('reads plain and quoted keys and values', () => {
    expect(parseOverrides(YAML)).toEqual({
      esbuild: '0.28.1',
      '@smithy/core': '3.35.0',
      'katex@<0.18.2': '0.18.10',
    });
  });

  it('returns an empty map when there is no overrides block', () => {
    expect(parseOverrides('packages:\n  - apps/*\n')).toEqual({});
  });

  it('throws on an indented line it cannot read instead of stopping early', () => {
    expect(() => parseOverrides('overrides:\n  a: 1\n  b:\n    nested: x\n  c: 2\n')).toThrow(/Unparseable/);
    expect(() => parseOverrides('overrides:\n    a: 1\n')).toThrow(/Unparseable/);
  });
});

describe('renderOverrides', () => {
  it('replaces only the overrides block and keeps the rest byte-for-byte', () => {
    const next = renderOverrides(YAML, { 'a@<1.0.0': '^1.0.0', 'katex@<0.18.2': '0.18.10' });
    expect(next).toBe(
      YAML.replace(
        '  esbuild: 0.28.1\n  "@smithy/core": "3.35.0"\n  "katex@<0.18.2": "0.18.10"\n',
        '  "a@<1.0.0": "^1.0.0"\n  "katex@<0.18.2": "0.18.10"\n'
      )
    );
    expect(parseOverrides(next)).toEqual({ 'a@<1.0.0': '^1.0.0', 'katex@<0.18.2': '0.18.10' });
  });

  it('appends a block when the file has none', () => {
    const next = renderOverrides('packages:\n  - apps/*\n', { 'a@<1.0.0': '^1.0.0' });
    expect(next).toBe('packages:\n  - apps/*\noverrides:\n  "a@<1.0.0": "^1.0.0"\n');
  });
});
