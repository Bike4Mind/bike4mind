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

    it('refuses to rewrite a binary file as text', async () => {
      await writeFile(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]));
      await expect(fileWrite.run({ path: join(root, 'blob.bin'), content: 'text' }, context)).rejects.toThrow(
        /binary file/
      );
    });

    it('creates missing parents inside the granted root', async () => {
      const target = join(root, 'a', 'b', 'c.txt');
      await fileWrite.run({ path: target, content: 'deep\n' }, context);
      await expect(readFile(target, 'utf8')).resolves.toBe('deep\n');
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
});
