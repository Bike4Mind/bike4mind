import { describe, expect, it } from 'vitest';
import { inlineCodePath, splitFilePaths } from './filePaths';

const paths = (text: string) =>
  splitFilePaths(text).flatMap(segment => (segment.kind === 'path' ? [segment.text] : []));

describe('splitFilePaths', () => {
  it('finds relative, absolute, home and dot paths in prose', () => {
    expect(paths('see reports/NETG-TC-2654-qa101-2026-11-17-slow.webm for steps 1 to 9')).toEqual([
      'reports/NETG-TC-2654-qa101-2026-11-17-slow.webm',
    ]);
    expect(paths('wrote /Users/me/project/out.txt and ~/notes/todo.md')).toEqual([
      '/Users/me/project/out.txt',
      '~/notes/todo.md',
    ]);
    expect(paths('run ./scripts/build.sh then ../other/README.md')).toEqual([
      './scripts/build.sh',
      '../other/README.md',
    ]);
    expect(paths('config is in .github/workflows/ci.yml')).toEqual(['.github/workflows/ci.yml']);
    expect(paths('on Windows C:\\Users\\me\\file.txt')).toEqual(['C:\\Users\\me\\file.txt']);
  });

  it('keeps the text around a path whole, closing punctuation included', () => {
    expect(splitFilePaths('Open src/index.ts.')).toEqual([
      { kind: 'text', text: 'Open ' },
      { kind: 'path', text: 'src/index.ts' },
      { kind: 'text', text: '.' },
    ]);
    expect(paths('(see src/a.ts, src/b.ts)')).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('keeps a cited line number with the path', () => {
    expect(paths('the bug is at src/app.ts:42:7 here')).toEqual(['src/app.ts:42:7']);
  });

  it('leaves dates, fractions and urls alone', () => {
    expect(paths('on 11/17/2026 about 1/2 of it')).toEqual([]);
    expect(paths('see http://example.com/a/b.txt')).toEqual([]);
  });

  it('does not start a path in the middle of a word', () => {
    expect(paths('foo.bar/baz')).toEqual(['foo.bar/baz']);
    expect(paths('path:/etc/hosts')).toEqual([]);
    expect(paths('@bike4mind/common/src/index.ts')).toEqual(['@bike4mind/common/src/index.ts']);
  });

  it('returns plain text unchanged when there is no path', () => {
    expect(splitFilePaths('nothing here')).toEqual([{ kind: 'text', text: 'nothing here' }]);
  });
});

describe('inlineCodePath', () => {
  it('takes a span that is only a path, a lone file name included', () => {
    expect(inlineCodePath('apps/desktop/src/main/index.ts')).toBe('apps/desktop/src/main/index.ts');
    expect(inlineCodePath('package.json')).toBe('package.json');
    expect(inlineCodePath(' README.md ')).toBe('README.md');
  });

  it('refuses code that is not a path', () => {
    expect(inlineCodePath('pnpm test')).toBeNull();
    expect(inlineCodePath('const x = a/b')).toBeNull();
    expect(inlineCodePath('## Video')).toBeNull();
    expect(inlineCodePath('1.2.3')).toBeNull();
    expect(inlineCodePath('https://example.com/a.txt')).toBeNull();
  });
});
