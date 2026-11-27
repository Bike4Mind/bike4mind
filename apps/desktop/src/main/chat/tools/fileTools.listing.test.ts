import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gitOutput = vi.hoisted(() => ({ value: '' }));
const git = vi.hoisted(() => vi.fn());
const ripgrepSearch = vi.hoisted(() => vi.fn());
const listDistroFiles = vi.hoisted(() => vi.fn());
vi.mock('../project/git', () => ({ git }));
vi.mock('./ripgrep', () => ({ ripgrepSearch }));
vi.mock('./wslFiles', () => ({ listDistroFiles }));

import { globFiles, grepSearch } from './fileTools';
import type { ToolContext } from './types';

describe('glob_files over a listing it is handed', () => {
  let root: string;
  let context: ToolContext;

  beforeEach(async () => {
    git.mockReset().mockImplementation(async () => gitOutput.value);
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-listing-')));
    context = { roots: [root], signal: new AbortController().signal };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('finds folders in a listing spelled with backslashes', async () => {
    gitOutput.value = ['sub\\deep.txt', 'sub\\inner\\a.txt', 'sub\\inner\\b.txt'].join('\0');
    const result = await globFiles.run({ pattern: 'sub', path: root }, context);
    expect(result).toContain('Folders matching sub:\n  sub/ (3 files)');
    await expect(globFiles.run({ pattern: '*', path: root }, context)).resolves.toContain('  sub/ (3 files)');
  });

  it('never lists a folder that lies outside the searched folder', async () => {
    gitOutput.value = ['../out/a.txt', 'in/b.txt'].join('\0');
    const result = await globFiles.run({ pattern: '../out', path: root }, context);
    expect(result).not.toContain('Folders matching');
    expect(result).toContain('No files matched');
  });
});

// Windows names cannot hold `?` or `:`, so this is a Linux and macOS case.
describe.skipIf(process.platform === 'win32')('names holding ? or : in a folder that is not in WSL', () => {
  let root: string;
  let context: ToolContext;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-hostnames-')));
    context = { roots: [root], signal: new AbortController().signal };
    await writeFile(join(root, 'x?y.txt'), 'needle one\n', 'utf8');
    await writeFile(join(root, 'a:b.txt'), 'needle two\n', 'utf8');
    git.mockReset().mockImplementation(async (_directory: string, args: readonly string[]) => {
      if (args.includes('--ignored')) throw new Error('not a repository');
      return 'x?y.txt\0a:b.txt\0';
    });
    ripgrepSearch.mockReset().mockResolvedValue('unavailable');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists and greps a listed name as it is spelled on disk', async () => {
    const glob = await globFiles.run({ pattern: '*', path: root }, context);
    const grep = await grepSearch.run({ pattern: 'needle', path: root }, context);

    for (const output of [glob, grep]) {
      expect(output).toContain('x?y.txt');
      expect(output).toContain('a:b.txt');
    }
    expect(grep).toContain('needle one');
    expect(grep).toContain('needle two');
  });

  it('shows a name ripgrep printed as it printed it, and filters by that name', async () => {
    ripgrepSearch.mockImplementation(async ({ onFile }) => {
      onFile({ path: 'a:b.txt', matches: 1, lines: [{ number: 1, text: 'needle two', match: true }] });
      onFile({ path: 'x?y.txt', matches: 1, lines: [{ number: 1, text: 'needle one', match: true }] });
      return 'done';
    });

    const result = await grepSearch.run(
      { pattern: 'needle', path: root, outputMode: 'files', include: 'a:*' },
      context
    );

    expect(result).toContain('a:b.txt');
    expect(result).not.toContain('x?y.txt');
  });
});

describe('file search in a WSL folder without ripgrep or git', () => {
  let root: string;
  let context: ToolContext;

  beforeEach(async () => {
    git.mockReset().mockRejectedValue(new Error('not a repository'));
    listDistroFiles.mockReset();
    ripgrepSearch.mockReset().mockResolvedValue('unavailable');
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-wslfiles-')));
    context = { roots: [root], signal: new AbortController().signal };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists with the distro and takes sizes and times from that listing instead of statting the share', async () => {
    listDistroFiles.mockResolvedValue({
      complete: true,
      files: [
        { path: 'repo-a/readme.md', size: 2048, modified: Date.UTC(2026, 0, 2) },
        { path: 'notes.txt', size: 5, modified: Date.UTC(2026, 0, 3) },
      ],
    });

    const result = await globFiles.run({ pattern: '**/*', path: root }, context);

    expect(listDistroFiles).toHaveBeenCalledWith(root, expect.any(Set), expect.any(Number), context.signal);
    expect(result).toContain('2 file(s)');
    expect(result).toMatch(/2\.0 ?KB\s+2026-01-02\s+repo-a\/readme\.md/);
    expect(result.indexOf('notes.txt')).toBeLessThan(result.indexOf('repo-a/readme.md'));
  });

  it('summarises the top level from the distro listing', async () => {
    listDistroFiles.mockResolvedValue({
      complete: true,
      files: [
        { path: 'repo-a/one.ts', size: 1, modified: 1 },
        { path: 'repo-a/two.ts', size: 1, modified: 1 },
        { path: 'repo-b/three.ts', size: 1, modified: 1 },
      ],
    });

    const result = await globFiles.run({ pattern: '*', path: root }, context);

    expect(result).toContain('Folders:');
    expect(result).toMatch(/repo-a\/.*2/);
    expect(result).toMatch(/repo-b\/.*1/);
  });

  it('says so when the distro list stopped at the limit', async () => {
    listDistroFiles.mockResolvedValue({ complete: false, files: [{ path: 'a.ts', size: 1, modified: 1 }] });
    await expect(globFiles.run({ pattern: '**/*.ts', path: root }, context)).resolves.toContain('Only the first');
  });

  it('walks the folder itself when the distro cannot list it', async () => {
    listDistroFiles.mockResolvedValue(null);
    await writeFile(join(root, 'local.txt'), 'x', 'utf8');
    await expect(globFiles.run({ pattern: '*.txt', path: root }, context)).resolves.toContain('local.txt');
  });

  it('greps the files the distro listed when ripgrep is missing, and no others', async () => {
    await writeFile(join(root, 'listed.txt'), 'needle here\n', 'utf8');
    await writeFile(join(root, 'unlisted.txt'), 'needle here too\n', 'utf8');
    listDistroFiles.mockResolvedValue({ complete: true, files: [{ path: 'listed.txt', size: 12, modified: 1 }] });

    const result = await grepSearch.run({ pattern: 'needle', path: root }, context);

    expect(result).toContain('listed.txt');
    expect(result).not.toContain('unlisted.txt');
  });
});
