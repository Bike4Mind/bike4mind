import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { PathAccessDenied } from './paths';
import type { ToolContext } from './types';
import { fileEdit, fileWrite } from './writeTools';

describe('write tools', () => {
  let root: string;
  let outside: string;
  let context: ToolContext;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-write-')));
    outside = await realpath(await mkdtemp(join(tmpdir(), 'b4m-outside-')));
    context = { roots: [root], signal: new AbortController().signal, protectedPaths: [join(root, 'vault')] };

    await writeFile(join(root, 'notes.md'), 'alpha\nbeta\ngamma\n', 'utf8');
    await writeFile(join(outside, 'secret.txt'), 'not yours\n', 'utf8');
  });

  /** The message a rejected edit produced, so a test can assert what it does NOT claim too. */
  async function editFailure(input: Record<string, unknown>): Promise<string> {
    const caught = await fileEdit.run(input, context).then(
      () => null,
      (error: unknown) => error
    );
    expect(caught).toBeInstanceOf(Error);
    return (caught as Error).message;
  }

  describe('control characters and binary files in file_edit', () => {
    it('rejects newText containing a NUL before writing', async () => {
      const message = await editFailure({ path: join(root, 'notes.md'), oldText: 'beta', newText: 'x \u0000b7' });
      expect(message).toMatch(/newText contains U\+0000 at line 1, column 3/);
      await expect(readFile(join(root, 'notes.md'), 'utf8')).resolves.toBe('alpha\nbeta\ngamma\n');
    });

    it('names the batch entry whose newText is garbled', async () => {
      const message = await editFailure({
        path: join(root, 'notes.md'),
        edits: [
          { oldText: 'alpha', newText: 'fine' },
          { oldText: 'beta', newText: 'b\u0000' },
        ],
      });
      expect(message).toMatch(/edits\[1\]\.newText contains U\+0000/);
    });

    it('still refuses to edit a file containing NUL bytes', async () => {
      await writeFile(join(root, 'blob.bin'), Buffer.from('a \u0000 b', 'utf8'));
      expect(await editFailure({ path: join(root, 'blob.bin'), oldText: 'a', newText: 'c' })).toMatch(/binary file/);
    });
  });

  describe('file_write', () => {
    it('describes a new file as a creation before writing anything', async () => {
      const input = { path: join(root, 'fresh.txt'), content: 'hello\n' };
      const prompt = await fileWrite.approval?.(input, context);

      expect(prompt?.diff?.operation).toBe('create');
      expect(prompt?.diff?.added).toBe(1);
      await expect(readFile(join(root, 'fresh.txt'), 'utf8')).rejects.toThrow();

      await fileWrite.run(input, context);
      await expect(readFile(join(root, 'fresh.txt'), 'utf8')).resolves.toBe('hello\n');
    });

    it('diffs an overwrite against what is on disk', async () => {
      const prompt = await fileWrite.approval?.(
        { path: join(root, 'notes.md'), content: 'alpha\nbeta changed\ngamma\n' },
        context
      );

      expect(prompt?.diff?.operation).toBe('overwrite');
      expect(prompt?.diff?.added).toBe(1);
      expect(prompt?.diff?.removed).toBe(1);
    });

    // A write outside the grant is refused at the point the prompt is built, so the user is
    // never shown a dialog they could click through.
    it('refuses a path outside every granted root without asking', async () => {
      const input = { path: join(outside, 'secret.txt'), content: 'mine now\n' };

      await expect(fileWrite.approval?.(input, context)).rejects.toBeInstanceOf(PathAccessDenied);
      await expect(fileWrite.run(input, context)).rejects.toBeInstanceOf(PathAccessDenied);
      await expect(readFile(join(outside, 'secret.txt'), 'utf8')).resolves.toBe('not yours\n');
    });

    it('refuses a protected path even though it sits inside a granted root', async () => {
      const input = { path: join(root, 'vault', 'tokens.json'), content: '{}' };
      await expect(fileWrite.run(input, context)).rejects.toThrow(/protected location/);
    });

    // The containment check runs again in `run`, against the resolved real path: the prompt the
    // user answered was about a plain file, and a symlink swapped in behind it must not be followed.
    it('re-checks containment at execution time, not only when prompting', async () => {
      const target = join(root, 'swapped.txt');
      await writeFile(target, 'harmless\n', 'utf8');

      const input = { path: target, content: 'replaced\n' };
      await expect(fileWrite.approval?.(input, context)).resolves.toBeTruthy();

      await rm(target);
      await symlink(join(outside, 'secret.txt'), target);

      await expect(fileWrite.run(input, context)).rejects.toBeInstanceOf(PathAccessDenied);
      await expect(readFile(join(outside, 'secret.txt'), 'utf8')).resolves.toBe('not yours\n');
    });

    it('refuses to apply a diff the file no longer matches', async () => {
      const input = { path: join(root, 'notes.md'), content: 'rewritten\n' };
      await fileWrite.approval?.(input, context);

      await writeFile(join(root, 'notes.md'), 'someone else got here first\n', 'utf8');

      await expect(fileWrite.run(input, context)).rejects.toThrow(/changed on disk/);
      await expect(readFile(join(root, 'notes.md'), 'utf8')).resolves.toBe('someone else got here first\n');
    });

    it('lets a whole-file write replace a file corrupted with NUL bytes', async () => {
      await writeFile(join(root, 'blob.bin'), Buffer.from('a \u0000\u0000b7 b', 'utf8'));
      await fileWrite.run({ path: join(root, 'blob.bin'), content: 'a \u00b7 b\n' }, context);
      await expect(readFile(join(root, 'blob.bin'), 'utf8')).resolves.toBe('a \u00b7 b\n');
    });

    it('rejects content with a NUL, naming the character and position, and writes nothing', async () => {
      const target = join(root, 'jsx.tsx');
      await expect(fileWrite.run({ path: target, content: 'ok\nab \u0000\u0000b7 x' }, context)).rejects.toThrow(
        /"content" contains U\+0000 at line 2, column 4, which looks like a garbled \\u escape/
      );
      await expect(readFile(target, 'utf8')).rejects.toThrow();
    });

    it('rejects other C0 controls such as a vertical tab but allows tab, CR and form feed', async () => {
      await expect(fileWrite.run({ path: join(root, 'v.txt'), content: '\u000bb' }, context)).rejects.toThrow(
        /U\+000B at line 1, column 1/
      );
      await fileWrite.run({ path: join(root, 'ok.txt'), content: 'a\tb\r\n\fc' }, context);
      await expect(readFile(join(root, 'ok.txt'), 'utf8')).resolves.toBe('a\tb\r\n\fc');
    });

    it('creates missing parents inside the granted root', async () => {
      const target = join(root, 'a', 'b', 'c.txt');
      await fileWrite.run({ path: target, content: 'deep\n' }, context);
      await expect(readFile(target, 'utf8')).resolves.toBe('deep\n');
    });
  });

  describe('file_edit result snippet', () => {
    const numberedFile = (count: number) =>
      Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n') + '\n';

    it('shows the edited region numbered like file_read, with four lines of context', async () => {
      await writeFile(join(root, 'long.txt'), numberedFile(40), 'utf8');
      const result = await fileEdit.run(
        { path: join(root, 'long.txt'), oldText: 'line 20\n', newText: 'twenty\nextra\n' },
        context
      );
      expect(result).toContain('[Edited region, lines 16-25 as they now read:]');
      expect(result).toContain(
        '16\tline 16\n17\tline 17\n18\tline 18\n19\tline 19\n20\ttwenty\n21\textra\n22\tline 21'
      );
      expect(result).toContain('25\tline 24');
      expect(result).not.toContain('line 15');
      expect(result).not.toContain('line 25');
    });

    it('keeps the whitespace-normalized note and adds the snippet', async () => {
      await writeFile(join(root, 'ind.ts'), 'function f() {\n    return 1;\n}\n', 'utf8');
      const result = await fileEdit.run(
        {
          path: join(root, 'ind.ts'),
          oldText: 'function f() {\n  return 1;\n}',
          newText: 'function f() {\n  return 2;\n}',
        },
        context
      );
      expect(result).toContain('whitespace-normalized matching');
      expect(result).toContain('2\t  return 2;');
    });

    it('shows one snippet per separate edit of a batch and merges neighbours', async () => {
      await writeFile(join(root, 'long.txt'), numberedFile(60), 'utf8');
      const result = await fileEdit.run(
        {
          path: join(root, 'long.txt'),
          edits: [
            { oldText: 'line 5\n', newText: 'five\n' },
            { oldText: 'line 50\n', newText: 'fifty\n' },
          ],
        },
        context
      );
      expect(result.match(/\[Edited region/g)).toHaveLength(2);
      expect(result).toContain('5\tfive');
      expect(result).toContain('50\tfifty');
    });

    it('anchors a deletion on the lines around it', async () => {
      await writeFile(join(root, 'long.txt'), numberedFile(30), 'utf8');
      const result = await fileEdit.run({ path: join(root, 'long.txt'), oldText: 'line 15\n', newText: '' }, context);
      expect(result).toContain('14\tline 14\n15\tline 16');
    });

    it('caps a long region at 60 lines', async () => {
      await writeFile(join(root, 'long.txt'), numberedFile(200), 'utf8');
      const big = Array.from({ length: 100 }, (_, index) => `new ${index}`).join('\n') + '\n';
      const result = await fileEdit.run({ path: join(root, 'long.txt'), oldText: 'line 50\n', newText: big }, context);
      expect(result).toContain('as they now read:]');
      expect(result).toMatch(/\[Lines \d+-\d+ of this region not shown\.\]/);
      expect(result.split('\n').filter(row => /^ *\d+\t/.test(row))).toHaveLength(60);
    });

    it('adds no snippet for a file_write', async () => {
      const result = await fileWrite.run({ path: join(root, 'notes.md'), content: 'one\ntwo\n' }, context);
      expect(result).not.toContain('Edited region');
    });
  });

  describe('file_edit', () => {
    it('replaces a unique stretch and leaves the rest alone', async () => {
      const input = { path: join(root, 'notes.md'), oldText: 'beta', newText: 'BETA' };
      const prompt = await fileEdit.approval?.(input, context);
      expect(prompt?.diff?.operation).toBe('edit');

      await fileEdit.run(input, context);
      await expect(readFile(join(root, 'notes.md'), 'utf8')).resolves.toBe('alpha\nBETA\ngamma\n');
    });

    it('refuses an ambiguous match rather than guessing which one', async () => {
      await writeFile(join(root, 'dup.txt'), 'x\nx\n', 'utf8');
      await expect(fileEdit.run({ path: join(root, 'dup.txt'), oldText: 'x', newText: 'y' }, context)).rejects.toThrow(
        /appears 2 times/
      );
    });

    it('changes every occurrence when asked to', async () => {
      await writeFile(join(root, 'dup.txt'), 'x\nx\n', 'utf8');
      await fileEdit.run({ path: join(root, 'dup.txt'), oldText: 'x', newText: 'y', replaceAll: true }, context);
      await expect(readFile(join(root, 'dup.txt'), 'utf8')).resolves.toBe('y\ny\n');
    });

    it('tells the model to re-read rather than accepting text that is not there', async () => {
      await expect(
        fileEdit.run({ path: join(root, 'notes.md'), oldText: 'epsilon', newText: 'x' }, context)
      ).rejects.toThrow(/does not appear/);
    });

    // `$&` in a replacement string is a back-reference to the match, which would silently
    // duplicate the old text instead of replacing it.
    it('inserts a dollar sign literally', async () => {
      await fileEdit.run({ path: join(root, 'notes.md'), oldText: 'beta', newText: 'cost $& more' }, context);
      await expect(readFile(join(root, 'notes.md'), 'utf8')).resolves.toBe('alpha\ncost $& more\ngamma\n');
    });

    it('points at file_write when the file does not exist', async () => {
      await expect(
        fileEdit.run({ path: join(root, 'missing.txt'), oldText: 'a', newText: 'b' }, context)
      ).rejects.toThrow(/file_write/);
    });
  });
  describe('file_edit with edits', () => {
    const file = () => join(root, 'multi.txt');
    beforeEach(async () => {
      await writeFile(file(), 'one\ntwo\nthree\nfour\nfive\n', 'utf8');
    });

    it('applies edits in sequence and writes once', async () => {
      const input = {
        path: file(),
        edits: [
          { oldText: 'one', newText: '1' },
          { oldText: 'five', newText: '5' },
        ],
      };
      await fileEdit.run(input, context);
      await expect(readFile(file(), 'utf8')).resolves.toBe('1\ntwo\nthree\nfour\n5\n');
    });

    it('lets an edit depend on the result of an earlier one', async () => {
      const input = {
        path: file(),
        edits: [
          { oldText: 'two', newText: 'TWO-A' },
          { oldText: 'TWO-A', newText: 'TWO-B' },
        ],
      };
      await fileEdit.run(input, context);
      await expect(readFile(file(), 'utf8')).resolves.toBe('one\nTWO-B\nthree\nfour\nfive\n');
    });

    it('supports replaceAll inside the batch', async () => {
      await writeFile(file(), 'x\nx\nkeep\n', 'utf8');
      const input = {
        path: file(),
        edits: [
          { oldText: 'x', newText: 'y', replaceAll: true },
          { oldText: 'keep', newText: 'kept' },
        ],
      };
      await fileEdit.run(input, context);
      await expect(readFile(file(), 'utf8')).resolves.toBe('y\ny\nkept\n');
    });

    it('is atomic: edit 3 of 5 failing writes nothing and names edits[2]', async () => {
      const input = {
        path: file(),
        edits: [
          { oldText: 'one', newText: '1' },
          { oldText: 'two', newText: '2' },
          { oldText: 'absent', newText: 'x' },
          { oldText: 'four', newText: '4' },
          { oldText: 'five', newText: '5' },
        ],
      };
      await expect(fileEdit.run(input, context)).rejects.toThrow(/edits\[2\] \(edit 3 of 5.*does not appear/);
      await expect(readFile(file(), 'utf8')).resolves.toBe('one\ntwo\nthree\nfour\nfive\n');
    });

    it('names an ambiguous edit by index', async () => {
      await writeFile(file(), 'a\nb\nb\n', 'utf8');
      const input = {
        path: file(),
        edits: [
          { oldText: 'a', newText: 'A' },
          { oldText: 'b', newText: 'B' },
        ],
      };
      await expect(fileEdit.run(input, context)).rejects.toThrow(/edits\[1\].*appears 2 times/);
    });

    // The old label blamed "the earlier edits" on every batch entry, index 0 included, which
    // pushed the model into re-deriving text from its own edit chain instead of re-reading.
    it('does not blame earlier edits when the first edit is the one that missed', async () => {
      const message = await editFailure({
        path: file(),
        edits: [
          { oldText: 'absent', newText: 'x' },
          { oldText: 'two', newText: '2' },
        ],
      });
      expect(message).toMatch(/edits\[0\] \(edit 1 of 2, nothing was written\)/);
      expect(message).not.toMatch(/earlier edits/);
    });

    it('does blame earlier edits once one has actually applied', async () => {
      const message = await editFailure({
        path: file(),
        edits: [
          { oldText: 'two', newText: 'TWO' },
          { oldText: 'two', newText: 'x' },
        ],
      });
      expect(message).toMatch(/edits\[1\] \(edit 2 of 2, nothing was written\).*as it stands after the earlier edits/);
    });

    it('makes no earlier-edits claim for a one-element batch', async () => {
      const message = await editFailure({ path: file(), edits: [{ oldText: 'absent', newText: 'x' }] });
      expect(message).toMatch(/edits\[0\] \(edit 1 of 1, nothing was written\)/);
      expect(message).not.toMatch(/earlier edits/);
    });

    it('leaves the lone oldText form unlabelled', async () => {
      const message = await editFailure({ path: file(), oldText: 'absent', newText: 'x' });
      expect(message).toMatch(/^"oldText" does not appear in/);
      expect(message).not.toMatch(/edits\[|earlier edits/);
    });

    it('leaves the file byte-identical when edit 2 of 3 fails', async () => {
      const before = await readFile(file(), 'utf8');
      const message = await editFailure({
        path: file(),
        edits: [
          { oldText: 'one', newText: '1' },
          { oldText: 'absent', newText: 'x' },
          { oldText: 'three', newText: '3' },
        ],
      });
      expect(message).toMatch(/edits\[1\] \(edit 2 of 3, nothing was written\)/);
      await expect(readFile(file(), 'utf8')).resolves.toBe(before);
    });

    it('rejects mixing the two forms and oversized batches', async () => {
      await expect(
        fileEdit.run({ path: file(), oldText: 'one', newText: '1', edits: [{ oldText: 'two', newText: '2' }] }, context)
      ).rejects.toThrow(/not both/);
      const many = Array.from({ length: 51 }, () => ({ oldText: 'one', newText: '1' }));
      await expect(fileEdit.run({ path: file(), edits: many }, context)).rejects.toThrow(/limit is 50/);
    });

    it('shows one combined diff for approval', async () => {
      const input = {
        path: file(),
        edits: [
          { oldText: 'one', newText: '1' },
          { oldText: 'five', newText: '5' },
        ],
      };
      const prompt = await fileEdit.approval?.(input, context);
      expect(prompt?.diff?.operation).toBe('edit');
      expect(prompt?.diff?.added).toBe(2);
      expect(prompt?.diff?.removed).toBe(2);
      const texts = prompt?.diff?.lines.map(line => line.text);
      expect(texts).toEqual(expect.arrayContaining(['1', '5', 'one', 'five']));
    });
  });

  describe('recoverable edits', () => {
    const file = () => join(root, 'tolerant.txt');
    const block = 'function f() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n';
    beforeEach(async () => {
      await writeFile(file(), block, 'utf8');
    });

    it('applies an over-indented oldText and re-indents newText, saying so', async () => {
      const result = await fileEdit.run(
        {
          path: file(),
          oldText: '    const a = 1;\n    const b = 2;',
          newText: '    const a = 10;\n      const b = 20;',
        },
        context
      );
      await expect(readFile(file(), 'utf8')).resolves.toBe(
        'function f() {\n  const a = 10;\n    const b = 20;\n  return a + b;\n}\n'
      );
      expect(result).toMatch(/whitespace-normalized matching/);
    });

    it('applies an under-indented oldText, adding the missing indent to newText', async () => {
      await fileEdit.run({ path: file(), oldText: 'const a = 1;\nconst b = 2;\n', newText: 'const c = 3;\n' }, context);
      await expect(readFile(file(), 'utf8')).resolves.toBe('function f() {\n  const c = 3;\n  return a + b;\n}\n');
    });

    it('refuses a loose match that hits two places and lists both', async () => {
      await writeFile(file(), 'if (x) {\n  run();\n}\nif (y) {\n    run();\n}\n', 'utf8');
      const message = await editFailure({ path: file(), oldText: '      run();', newText: 'stop();' });
      expect(message).toMatch(/matches 2 places.*at lines 2, 5/s);
      await expect(readFile(file(), 'utf8')).resolves.toBe('if (x) {\n  run();\n}\nif (y) {\n    run();\n}\n');
    });

    it('lists every occurrence of an ambiguous exact match with previews', async () => {
      await writeFile(file(), 'a\nmark one\nb\nmark two\nc\nmark three\n', 'utf8');
      const message = await editFailure({ path: file(), oldText: 'mark', newText: 'x' });
      expect(message).toMatch(/appears 3 times.*at lines 2, 4, 6/s);
      expect(message).toContain('4: mark two');
    });

    it('names which batch edits were fine and writes nothing', async () => {
      await writeFile(file(), 'a\nb\nb\nc\n', 'utf8');
      const message = await editFailure({
        path: file(),
        edits: [
          { oldText: 'a', newText: 'A' },
          { oldText: 'b', newText: 'B' },
          { oldText: 'c', newText: 'C' },
        ],
      });
      expect(message).toMatch(/edits\[1\].*at lines 2, 3/s);
      expect(message).toMatch(/other edits \(edits\[0\], edits\[2\]\) were fine/);
      await expect(readFile(file(), 'utf8')).resolves.toBe('a\nb\nb\nc\n');
    });

    it('accepts edits alongside empty single-form fields', async () => {
      await fileEdit.run(
        {
          path: file(),
          oldText: '',
          newText: '',
          replaceAll: false,
          edits: [{ oldText: 'const a = 1;', newText: 'const a = 5;' }],
        },
        context
      );
      await expect(readFile(file(), 'utf8')).resolves.toContain('const a = 5;');
    });

    it('still refuses edits alongside a real single-form edit', async () => {
      await expect(
        fileEdit.run(
          { path: file(), oldText: 'a', newText: 'b', edits: [{ oldText: 'const a = 1;', newText: 'x' }] },
          context
        )
      ).rejects.toThrow(/not both/);
    });

    it('skips a no-op edit and applies the rest', async () => {
      const result = await fileEdit.run(
        {
          path: file(),
          edits: [
            { oldText: 'const a = 1;', newText: 'const a = 1;' },
            { oldText: 'const b = 2;', newText: 'const b = 9;' },
          ],
        },
        context
      );
      await expect(readFile(file(), 'utf8')).resolves.toContain('const b = 9;');
      expect(result).toMatch(/edits\[0\] was skipped/);
    });

    it('reports a batch of only no-ops as a non-error that changed nothing', async () => {
      const result = await fileEdit.run(
        {
          path: file(),
          edits: [
            { oldText: 'const a = 1;', newText: 'const a = 1;' },
            { oldText: 'zzz', newText: 'zzz' },
          ],
        },
        context
      );
      expect(result).toMatch(/No change made/);
      await expect(readFile(file(), 'utf8')).resolves.toBe(block);
    });
  });

  describe('why an edit missed', () => {
    const miss = async (content: string, oldText: string): Promise<string> => {
      const target = join(root, 'subject.txt');
      await writeFile(target, content, 'utf8');
      return editFailure({ path: target, oldText, newText: 'REPLACED' });
    };

    it('names indentation as the cause and quotes the file version', async () => {
      const message = await miss('function f() {\n  return  1;\n}\n', 'return 1;');
      expect(message).toMatch(/indentation or spacing differs/);
      expect(message).toContain('has:\nreturn  1;\nUse that exactly.');
      expect(message).not.toMatch(/CRLF|None of its lines|Its line/);
    });

    it('applies an LF oldText to a CRLF file and keeps the file on CRLF', async () => {
      const target = join(root, 'subject.txt');
      await writeFile(target, 'alpha\r\nbeta\r\ngamma\r\n', 'utf8');
      await fileEdit.run({ path: target, oldText: 'alpha\nbeta', newText: 'one\ntwo' }, context);
      await expect(readFile(target, 'utf8')).resolves.toBe('one\r\ntwo\r\ngamma\r\n');
    });

    it('applies a CRLF oldText to an LF file and keeps the file on LF', async () => {
      const target = join(root, 'subject.txt');
      await writeFile(target, 'alpha\nbeta\ngamma\n', 'utf8');
      await fileEdit.run({ path: target, oldText: 'alpha\r\nbeta', newText: 'one\r\ntwo' }, context);
      await expect(readFile(target, 'utf8')).resolves.toBe('one\ntwo\ngamma\n');
    });

    it('points at a unique anchor line so the snippet can be fixed in place', async () => {
      const message = await miss('alpha\nbeta\ngamma\n', 'beta\ndelta');
      expect(message).toMatch(/Its line "beta" is at line 2/);
      expect(message).toContain('alpha\nbeta\ngamma');
      expect(message).not.toMatch(/CRLF|indentation or spacing|None of its lines/);
    });

    it('says plainly when nothing in the file is close', async () => {
      const message = await miss('alpha\nbeta\ngamma\n', 'epsilon\nzeta');
      expect(message).toMatch(/None of its lines appear in the file/);
      expect(message).not.toMatch(/CRLF|indentation or spacing|Its line/);
    });

    it('falls back to the generic advice when a shared line is not unique', async () => {
      const message = await miss('x\ny\nx\n', 'x\nzeta');
      expect(message).toMatch(/Read the file and copy the exact text/);
      expect(message).not.toMatch(/Its line|None of its lines|indentation or spacing/);
    });

    it('warns when the spacing match is not unique either', async () => {
      const message = await miss('  a b\n   a  b\n', 'a    b');
      expect(message).toMatch(/matches in more than one place/);
    });

    it('caps how much of the file it quotes back', async () => {
      const message = await miss(`${'q'.repeat(400)} tail\n`, `${'q'.repeat(400)}  tail`);
      expect(message).toMatch(/indentation or spacing differs/);
      expect(message).toContain(`${'q'.repeat(200)}...`);
      expect(message).not.toContain('q'.repeat(300));
    });
  });

  describe('parallel writes to one file', () => {
    const importLine = 'import { formatDuration, sessionElapsedMs } from "x";';
    let big: string;
    let first: Record<string, unknown>;
    let second: Record<string, unknown>;

    beforeEach(async () => {
      big = join(root, 'Big.tsx');
      const middle = Array.from({ length: 2500 }, (_, i) => `const line${i} = ${i};`);
      await writeFile(big, [importLine, ...middle, 'const ms = sessionElapsedMs(a);', ''].join('\n'), 'utf8');
      first = {
        path: big,
        oldText: 'import { formatDuration, sessionElapsedMs }',
        newText: 'import { elapsedMs, formatDuration }',
      };
      second = { path: big, oldText: 'const ms = sessionElapsedMs(a);', newText: 'const ms = elapsedMs(a);' };
    });

    async function expectBothApplied(): Promise<void> {
      const lines = (await readFile(big, 'utf8')).split('\n');
      expect(lines[0]).toBe('import { elapsedMs, formatDuration } from "x";');
      expect(lines.at(-2)).toBe('const ms = elapsedMs(a);');
      expect(lines).toHaveLength(2503);
    }

    it('applies two edits issued in one round instead of losing the first', async () => {
      await Promise.all([fileEdit.run(first, context), fileEdit.run(second, context)]);
      await expectBothApplied();
    });

    // Both prompts were built against the original, so the second edit's approval is stale by
    // the time it runs - but only because of the first, which the user also approved.
    it('re-plans an approved edit on top of a sibling approved in the same round', async () => {
      await fileEdit.approval?.(first, context);
      await fileEdit.approval?.(second, context);

      const results = await Promise.all([fileEdit.run(first, context), fileEdit.run(second, context)]);
      expect(results.every(result => result.includes('Written'))).toBe(true);
      await expectBothApplied();
    });

    it('still refuses an approval the file was changed under by someone else', async () => {
      await fileEdit.approval?.(first, context);
      await fileEdit.approval?.(second, context);
      await fileEdit.run(first, context);
      await writeFile(big, `${await readFile(big, 'utf8')}// edited elsewhere\n`, 'utf8');

      await expect(fileEdit.run(second, context)).rejects.toThrow(/changed on disk/);
    });
  });
});
