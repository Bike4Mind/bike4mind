import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
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
      expect(result).toBe('2\tbeta gamma\n\n[Lines 2-2 of 3. Continue with offset 3.]');
    });

    it('numbers every line and adds no range note when the whole file fits', async () => {
      await expect(fileRead.run({ path: join(root, 'notes.md') }, context)).resolves.toBe(
        '1\talpha\n2\tbeta gamma\n3\tdelta'
      );
    });

    const numbered = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');

    it('stops a long file at the default page and says how to get the rest', async () => {
      await writeFile(join(root, 'long.txt'), numbered(1000), 'utf8');
      const result = await fileRead.run({ path: join(root, 'long.txt') }, context);
      expect(result).toContain('400\tline 400');
      expect(result).not.toContain('line 401');
      expect(result).toMatch(/\[Lines 1-400 of 1000\. Continue with offset 401\. grep_search with context .*\]$/);
    });

    it('honours an explicit limit, up to the maximum', async () => {
      await writeFile(join(root, 'long.txt'), numbered(3000), 'utf8');
      const some = await fileRead.run({ path: join(root, 'long.txt'), limit: 900 }, context);
      expect(some).toContain('[Lines 1-900 of 3000. Continue with offset 901.');
      const capped = await fileRead.run({ path: join(root, 'long.txt'), limit: 5000 }, context);
      expect(capped).toContain('[Lines 1-2000 of 3000. Continue with offset 2001.');
    });

    it('describes a binary file instead of dumping it', async () => {
      await writeFile(join(root, 'blob.dat'), Buffer.from([1, 0, 2, 3]));
      await expect(fileRead.run({ path: join(root, 'blob.dat') }, context)).resolves.toMatch(/binary file/);
    });

    it('says when the offset is past the end', async () => {
      await expect(fileRead.run({ path: join(root, 'notes.md'), offset: 9 }, context)).resolves.toMatch(
        /has 3 lines; offset 9 is past the end/
      );
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

    it('lists the subfolders of a plain "*" with their file counts', async () => {
      await expect(globFiles.run({ pattern: '*' }, context)).resolves.toContain('Folders:\n  sub/ (1 file)');
    });

    it('suggests "**/" when a top-level pattern misses files that exist deeper', async () => {
      await expect(globFiles.run({ pattern: 'deep.txt' }, context)).resolves.toContain('try "**/deep.txt"');
      await expect(globFiles.run({ pattern: '**/deep.txt' }, context)).resolves.toContain(join('sub', 'deep.txt'));
    });
  });

  describe('inside a git work tree', () => {
    beforeEach(async () => {
      execFileSync('git', ['init', '-q'], { cwd: root });
      await writeFile(join(root, '.gitignore'), 'generated/\n', 'utf8');
      await mkdir(join(root, 'generated'), { recursive: true });
      await writeFile(join(root, 'generated', 'built.txt'), 'beta from a build\n', 'utf8');
    });

    it('leaves out what .gitignore ignores, in both searches', async () => {
      await expect(globFiles.run({ pattern: '**/*.txt' }, context)).resolves.not.toContain('built.txt');
      await expect(grepSearch.run({ pattern: 'beta' }, context)).resolves.not.toContain('built.txt');
    });

    it('still searches an ignored folder when it is asked for by path', async () => {
      await expect(grepSearch.run({ pattern: 'beta', path: join(root, 'generated') }, context)).resolves.toContain(
        'built.txt'
      );
    });

    it('does not follow a symlink out of the granted root', async () => {
      const outside = await realpath(await mkdtemp(join(tmpdir(), 'b4m-outside-')));
      await writeFile(join(outside, 'secret.txt'), 'beta secret\n', 'utf8');
      await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
      await expect(grepSearch.run({ pattern: 'secret' }, context)).resolves.toMatch(/No matches/);
    });
  });

  describe('grep_search', () => {
    it('finds matches across subdirectories with line numbers', async () => {
      const result = await grepSearch.run({ pattern: 'beta' }, context);
      expect(result).toContain('notes.md\n  2: beta gamma');
      expect(result).toContain(join('sub', 'deep.txt'));
    });

    it('honours the case-insensitive flag', async () => {
      await expect(grepSearch.run({ pattern: 'BETA' }, context)).resolves.toMatch(/No matches/);
      await expect(grepSearch.run({ pattern: 'BETA', ignoreCase: true }, context)).resolves.toContain(
        '  2: beta gamma'
      );
    });

    it('limits the search with an include glob that matches file names at any depth', async () => {
      const result = await grepSearch.run({ pattern: 'beta', include: '*.txt' }, context);
      expect(result).toContain(join('sub', 'deep.txt'));
      expect(result).not.toContain('notes.md');
    });

    it('accepts a comma-separated include as well as the brace form', async () => {
      for (const include of ['*.txt,*.md', '*.{txt,md}']) {
        const result = await grepSearch.run({ pattern: 'beta', include }, context);
        expect(result).toContain('notes.md');
        expect(result).toContain(join('sub', 'deep.txt'));
      }
    });

    it('lists only the matching files and their counts in files mode', async () => {
      await writeFile(join(root, 'twice.md'), 'beta\nbeta\n', 'utf8');
      const result = await grepSearch.run({ pattern: 'beta', outputMode: 'files' }, context);
      expect(result).toContain('twice.md (2)');
      expect(result).toMatch(/^3 file\(s\) under .* match, 4 matching line\(s\) in all:/);
      expect(result).not.toContain('beta gamma');
    });

    it('shows context lines around a match and separates distant blocks', async () => {
      const lines = ['one', 'hit', 'three', 'four', 'five', 'six', 'hit', 'eight'].join('\n');
      await writeFile(join(root, 'ctx.txt'), lines, 'utf8');
      const result = await grepSearch.run({ pattern: '^hit$', include: 'ctx.txt', context: 1 }, context);
      expect(result).toContain('ctx.txt\n  1- one\n  2: hit\n  3- three\n  --\n  6- six\n  7: hit\n  8- eight');
    });

    it('says there are more matches than it shows', async () => {
      await writeFile(join(root, 'many.txt'), 'beta\n'.repeat(50), 'utf8');
      const result = await grepSearch.run({ pattern: 'beta', maxResults: 5 }, context);
      expect(result).toMatch(/^Showing the first 5 matching line\(s\); there are more/);
      expect(result.split('\n').filter(line => /^ {2}\d+: /.test(line))).toHaveLength(5);
    });

    it('skips binary files', async () => {
      await writeFile(join(root, 'blob.dat'), Buffer.concat([Buffer.from('beta'), Buffer.from([0])]));
      await expect(grepSearch.run({ pattern: 'beta' }, context)).resolves.not.toContain('blob.dat');
    });

    it('reports a bad regular expression as such', async () => {
      await expect(grepSearch.run({ pattern: '([' }, context)).rejects.toThrow(/Invalid regular expression/);
    });
  });
});
