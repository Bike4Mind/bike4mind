import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { grepSearch } from './fileTools';
import type { ToolContext } from './types';

function hasRipgrep(): boolean {
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasRipgrep())('grep_search engines', () => {
  let root: string;
  let context: ToolContext;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-rg-')));
    context = { roots: [root], signal: new AbortController().signal };
    execFileSync('git', ['init', '-q'], { cwd: root });
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'dep'), { recursive: true });
    await writeFile(join(root, '.gitignore'), 'ignored.txt\nnode_modules/\n');
    await writeFile(join(root, 'ignored.txt'), 'needle in an ignored file\n');
    await writeFile(join(root, 'node_modules', 'dep', 'index.js'), 'needle\n');
    await writeFile(join(root, 'src', 'a.ts'), 'one\nneedle here\nthree\nfour\nfive\nneedle again\n');
    await writeFile(join(root, 'src', 'b.md'), 'Needle in markdown\n');
    await writeFile(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 110, 101, 101, 100, 108, 101]));
    await writeFile(join(root, 'notes.txt'), `${'x'.repeat(400)} needle ${'y'.repeat(400)}\n`);
  });

  afterEach(() => {
    delete process.env.B4M_DISABLE_RIPGREP;
  });

  async function both(input: Record<string, unknown>): Promise<[string, string]> {
    const withRipgrep = await grepSearch.run(input, context);
    process.env.B4M_DISABLE_RIPGREP = '1';
    const withoutRipgrep = await grepSearch.run(input, context);
    delete process.env.B4M_DISABLE_RIPGREP;
    return [withRipgrep, withoutRipgrep];
  }

  it.each([
    ['plain content', { pattern: 'needle' }],
    ['case-insensitive', { pattern: 'needle', ignoreCase: true }],
    ['context lines', { pattern: 'needle', context: 1 }],
    ['files mode', { pattern: 'needle', outputMode: 'files' }],
    ['include glob', { pattern: 'needle', ignoreCase: true, include: '*.md' }],
    ['include alternatives', { pattern: 'needle', include: '*.ts,*.txt' }],
    ['result cap', { pattern: 'needle', maxResults: 1 }],
    ['no match', { pattern: 'absent-token' }],
  ])('agrees with the JavaScript scan: %s', async (_name, input) => {
    const [withRipgrep, withoutRipgrep] = await both({ ...input, path: root });
    expect(withRipgrep).toBe(withoutRipgrep);
  });

  it('skips ignored files, dependency folders and binaries', async () => {
    const result = await grepSearch.run({ pattern: 'needle', path: root, outputMode: 'files' }, context);
    expect(result).toContain('src/a.ts (2)');
    expect(result).not.toMatch(/ignored\.txt|node_modules|blob\.bin/);
  });

  it('falls back to the JavaScript engine for syntax the Rust regex engine rejects', async () => {
    const result = await grepSearch.run({ pattern: '(?<=one\\n)needle|needle(?= again)', path: root }, context);
    expect(result).toContain('needle again');
  });

  it('still searches a file git tracks even though .gitignore matches it', async () => {
    await writeFile(join(root, 'kept.log'), 'needle in a tracked log\n');
    await writeFile(join(root, '.gitignore'), 'ignored.txt\nnode_modules/\n*.log\n');
    execFileSync('git', ['add', '-f', 'kept.log'], { cwd: root });
    await writeFile(join(root, 'other.log'), 'needle in an untracked log\n');
    const [withRipgrep, withoutRipgrep] = await both({ pattern: 'needle', path: root, outputMode: 'files' });
    expect(withRipgrep).toContain('kept.log');
    expect(withRipgrep).not.toContain('other.log');
    // Same files; the tracked-but-ignored one is searched after rg's own, so not in path order.
    const lines = (text: string) => text.split('\n').sort();
    expect(lines(withRipgrep)).toEqual(lines(withoutRipgrep));
  });

  it('does not report a clean miss when rg itself errors', async () => {
    // Valid JavaScript, but past the Rust regex engine's compiled-size limit.
    const result = await grepSearch.run({ pattern: '(?:a{1000}){1000}|needle here', path: root }, context);
    expect(result).toContain('needle here');
  });
});
