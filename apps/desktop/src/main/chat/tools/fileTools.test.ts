import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fileRead, globFiles, grepSearch } from './fileTools';
import { PathAccessDenied } from './paths';
import { MAX_TOOL_IMAGE_BYTES } from './toolImages';
import {
  MAX_FILE_READ_OUTPUT_CHARS,
  MAX_TOOL_OUTPUT_CHARS,
  outputCapFor,
  type PreparedImage,
  type ToolContext,
} from './types';

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

    it('reads a whole file of up to 2000 lines by default', async () => {
      await writeFile(join(root, 'long.txt'), numbered(1000), 'utf8');
      const result = await fileRead.run({ path: join(root, 'long.txt') }, context);
      expect(result.startsWith('   1\tline 1\n')).toBe(true);
      expect(result.endsWith('1000\tline 1000')).toBe(true);
      expect(result).not.toContain('[Lines');
    });

    it('stops at 2000 lines by default and gives the offset to continue from', async () => {
      await writeFile(join(root, 'long.txt'), numbered(2500), 'utf8');
      const result = await fileRead.run({ path: join(root, 'long.txt') }, context);
      expect(result).toContain('2000\tline 2000');
      expect(result).not.toContain('line 2001');
      expect(result.endsWith('[Lines 1-2000 of 2500. Continue with offset 2001.]')).toBe(true);
    });

    it('returns as many lines as fit the output budget and names the exact offset to continue from', async () => {
      const wide = Array.from({ length: 1500 }, (_, index) => `${index + 1} ${'w'.repeat(100)}`).join('\n');
      await writeFile(join(root, 'wide.txt'), wide, 'utf8');
      const result = await fileRead.run({ path: join(root, 'wide.txt') }, context);
      expect(result.length).toBeLessThanOrEqual(MAX_FILE_READ_OUTPUT_CHARS);
      expect(result.length).toBeGreaterThan(MAX_TOOL_OUTPUT_CHARS);
      const trailer =
        /\[Lines 1-(\d+) of 1500\. Continue with offset (\d+)\. The rest did not fit in one result\.\]$/.exec(result);
      expect(trailer).not.toBeNull();
      const lastShown = Number(trailer?.[1]);
      expect(lastShown).toBeLessThan(1500);
      expect(Number(trailer?.[2])).toBe(lastShown + 1);
      expect(result).toContain(`${String(lastShown).padStart(4)}\t${lastShown} w`);
      expect(result).not.toContain(`\t${lastShown + 1} w`);

      const rest = await fileRead.run({ path: join(root, 'wide.txt'), offset: lastShown + 1 }, context);
      expect(rest).toMatch(new RegExp(`^ *${lastShown + 1}\t${lastShown + 1} w`));
    });

    it('reads a 600-line file past the shared 30k cap in one call', async () => {
      const code = Array.from(
        { length: 616 },
        (_, index) => `const value${index} = compute(${index}, 'some argument text');`
      );
      await writeFile(join(root, 'app.ts'), code.join('\n'), 'utf8');
      const result = await fileRead.run({ path: join(root, 'app.ts') }, context);
      expect(result.length).toBeGreaterThan(MAX_TOOL_OUTPUT_CHARS);
      expect(result).toContain('value615');
      expect(result).not.toContain('[Lines');
      expect(outputCapFor('file_read')).toBeGreaterThanOrEqual(result.length);
    });

    it('cuts a line longer than 2000 characters', async () => {
      await writeFile(join(root, 'minified.js'), 'z'.repeat(2500), 'utf8');
      const result = await fileRead.run({ path: join(root, 'minified.js') }, context);
      expect(result).toBe(`1\t${'z'.repeat(2000)}... [line cut at 2000 characters]`);
    });

    it('tells the model to read whole files, not to grep first or page', () => {
      const { description } = fileRead.schema;
      expect(description).toContain('up to 2000 lines');
      expect(description).not.toMatch(/grep_search|cheaper|page/i);
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

    describe('images', () => {
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
      const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(32)]);

      function imageContext(vision: boolean, prepared: PreparedImage | null) {
        const shown: { bytes: Buffer; mimeType: string }[] = [];
        const prepare = vi.fn((_bytes: Buffer, _type: string, _max: number) => prepared);
        const reported: ToolContext = {
          ...context,
          images: { vision, prepare },
          report: { image: (bytes: Buffer, mimeType: string) => shown.push({ bytes, mimeType }) } as never,
        };
        return { reported, shown, prepare };
      }

      it('shows the model a PNG, downscaled, and says what it was', async () => {
        await writeFile(join(root, 'shot.png'), png);
        const small = Buffer.from('small');
        const { reported, shown, prepare } = imageContext(true, {
          bytes: small,
          mediaType: 'image/jpeg',
          width: 1568,
          height: 980,
          sourceWidth: 2880,
          sourceHeight: 1800,
        });
        const result = await fileRead.run({ path: join(root, 'shot.png') }, reported);
        expect(shown).toEqual([{ bytes: small, mimeType: 'image/jpeg' }]);
        expect(prepare.mock.calls[0][2]).toBe(MAX_TOOL_IMAGE_BYTES);
        expect(result).toContain('is a PNG image');
        expect(result).toContain('2880x1800, shown to you at 1568x980');
        expect(result).toContain('in this reply only');
      });

      it('knows an image by its bytes, not its name', async () => {
        await writeFile(join(root, 'fake.png'), 'not an image at all');
        const { reported, shown } = imageContext(true, null);
        await expect(fileRead.run({ path: join(root, 'fake.png') }, reported)).resolves.toBe('1\tnot an image at all');
        expect(shown).toEqual([]);
      });

      it('says so instead of sending an image the model cannot read', async () => {
        await writeFile(join(root, 'shot.png'), png);
        const { reported, shown, prepare } = imageContext(false, null);
        const result = await fileRead.run({ path: join(root, 'shot.png') }, reported);
        expect(result).toMatch(/not shown: the current model does not accept images/);
        expect(shown).toEqual([]);
        expect(prepare).not.toHaveBeenCalled();
      });

      it('refuses a PNG that does not decode rather than send it', async () => {
        await writeFile(join(root, 'broken.png'), png);
        const { reported, shown } = imageContext(true, null);
        await expect(fileRead.run({ path: join(root, 'broken.png') }, reported)).resolves.toMatch(
          /not shown: it could not be decoded/
        );
        expect(shown).toEqual([]);
      });

      it('sends a GIF the decoder cannot read as it is, while it fits', async () => {
        await writeFile(join(root, 'spinner.gif'), gif);
        const { reported, shown } = imageContext(true, null);
        await expect(fileRead.run({ path: join(root, 'spinner.gif') }, reported)).resolves.toMatch(/is a GIF image/);
        expect(shown).toEqual([{ bytes: gif, mimeType: 'image/gif' }]);
      });

      it('describes an image in text outside a conversation', async () => {
        await writeFile(join(root, 'shot.png'), png);
        await expect(fileRead.run({ path: join(root, 'shot.png') }, context)).resolves.toMatch(
          /is a PNG image .*not shown/
        );
      });

      it('keeps the path check for an image', async () => {
        const outside = await realpath(await mkdtemp(join(tmpdir(), 'b4m-outside-')));
        await writeFile(join(outside, 'shot.png'), png);
        const { reported, shown } = imageContext(true, null);
        await expect(fileRead.run({ path: join(outside, 'shot.png') }, reported)).rejects.toBeInstanceOf(
          PathAccessDenied
        );
        expect(shown).toEqual([]);
      });
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

    it('searches a single file when the path is a file', async () => {
      const result = await grepSearch.run({ pattern: '^beta', path: join(root, 'notes.md'), context: 1 }, context);
      expect(result).toContain('1 matching line(s) in 1 file(s)');
      expect(result).toContain('  2: beta gamma');
      expect(result).not.toContain('deep.txt');
      await expect(
        grepSearch.run({ pattern: 'beta', path: join(root, 'notes.md'), include: '*.txt' }, context)
      ).resolves.toContain('beta gamma');
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

    it('searches an invalid regular expression as literal text and says so', async () => {
      await writeFile(join(root, 'paren.txt'), 'see attached file (id 7)\nother\n', 'utf8');
      const result = await grepSearch.run({ pattern: 'attached file (id' }, context);
      expect(result).toMatch(
        /^Note: "attached file \(id" is not a valid regular expression \(.*Unterminated group\), so it was searched as literal text\./
      );
      expect(result).not.toMatch(/Invalid regular expression: .*Invalid regular expression/);
      expect(result).not.toContain('Invalid regular expression');
      expect(result).toContain('1 matching line(s)');
      expect(result).toContain('see attached file (id 7)');
    });

    it('reports the note even when the literal text is not found', async () => {
      const result = await grepSearch.run({ pattern: 'nothing here ([' }, context);
      expect(result).toMatch(/^Note: .*searched as literal text\./);
      expect(result).toContain('No matches for');
    });

    it('searches as plain text on request, and leaves a valid regex alone', async () => {
      await writeFile(join(root, 'dots.txt'), 'a.c\nabc\n', 'utf8');
      const literal = await grepSearch.run({ pattern: 'a.c', literal: true }, context);
      expect(literal).toContain('1 matching line(s)');
      expect(literal).not.toContain('Note:');
      const regex = await grepSearch.run({ pattern: 'a.c' }, context);
      expect(regex).toContain('2 matching line(s)');
      expect(regex).not.toContain('Note:');
    });
  });
});
