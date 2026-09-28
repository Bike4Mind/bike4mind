import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { fileRead, globFiles, grepSearch } from './fileTools';
import { PathAccessDenied } from './paths';
import type { ToolContext } from './types';

describe('file tools', () => {
  let root: string;
  let context: ToolContext;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-tools-')));
    context = { roots: [root], signal: new AbortController().signal };

    await writeFile(join(root, 'small.txt'), 'x'.repeat(10), 'utf8');
    await writeFile(join(root, 'big.bin'), 'y'.repeat(5000), 'utf8');
    await writeFile(join(root, 'notes.md'), 'alpha\nbeta gamma\ndelta\n', 'utf8');
    await mkdir(join(root, 'sub'), { recursive: true });
    await writeFile(join(root, 'sub', 'deep.txt'), 'beta again\n', 'utf8');
  });

  describe('file_read', () => {
    it('returns the whole file', async () => {
      await expect(fileRead.run({ path: join(root, 'notes.md') }, context)).resolves.toContain('beta gamma');
    });

    it('slices with offset and limit', async () => {
      const result = await fileRead.run({ path: join(root, 'notes.md'), offset: 2, limit: 1 }, context);
      expect(result).toBe('beta gamma');
    });

    it('points at glob_files rather than dumping a directory', async () => {
      await expect(fileRead.run({ path: root }, context)).rejects.toThrow(/glob_files/);
    });

    it('refuses a path outside the granted root', async () => {
      await expect(fileRead.run({ path: '/etc/hosts' }, context)).rejects.toBeInstanceOf(PathAccessDenied);
    });

    it('rejects a missing path argument instead of guessing one', async () => {
      await expect(fileRead.run({}, context)).rejects.toThrow(/"path" argument is required/);
    });
  });

  describe('glob_files', () => {
    // The question that started this work: "what is the largest file in my Downloads folder?"
    it('sorts by size when asked, largest first', async () => {
      const result = await globFiles.run({ pattern: '*', sort: 'size' }, context);
      const names = result
        .split('\n')
        .slice(1)
        .map(line => line.trim().split(/\s+/).pop());
      expect(names[0]).toBe('big.bin');
    });

    it('reports sizes in human units', async () => {
      await expect(globFiles.run({ pattern: 'big.bin', sort: 'size' }, context)).resolves.toContain('4.9 KB');
    });

    it('defaults to the single granted root when no path is given', async () => {
      await expect(globFiles.run({}, context)).resolves.toContain(root);
    });

    it('asks for a path when several roots make a relative pattern ambiguous', async () => {
      const second = await realpath(await mkdtemp(join(tmpdir(), 'b4m-tools2-')));
      await expect(globFiles.run({}, { ...context, roots: [root, second] })).rejects.toThrow(/Specify "path"/);
    });

    it('says so plainly when nothing matches', async () => {
      await expect(globFiles.run({ pattern: '*.nope' }, context)).resolves.toMatch(/No files matched/);
    });

    it('refuses a folder outside the granted root', async () => {
      await expect(globFiles.run({ path: '/etc' }, context)).rejects.toBeInstanceOf(PathAccessDenied);
    });
  });

  describe('grep_search', () => {
    it('finds matches across subdirectories with line numbers', async () => {
      const result = await grepSearch.run({ pattern: 'beta' }, context);
      expect(result).toContain('notes.md:2');
      expect(result).toContain(join('sub', 'deep.txt'));
    });

    it('honours the case-insensitive flag', async () => {
      await expect(grepSearch.run({ pattern: 'BETA' }, context)).resolves.toMatch(/No matches/);
      await expect(grepSearch.run({ pattern: 'BETA', ignoreCase: true }, context)).resolves.toContain('notes.md:2');
    });

    it('reports a bad regular expression as such', async () => {
      await expect(grepSearch.run({ pattern: '([' }, context)).rejects.toThrow(/Invalid regular expression/);
    });
  });
});
