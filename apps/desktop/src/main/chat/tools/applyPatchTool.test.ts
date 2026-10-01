import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatDiff } from '@shared/chat';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyPatch, usesApplyPatch } from './applyPatchTool';
import { fileRead } from './fileTools';
import { PathAccessDenied } from './paths';
import type { ToolContext, ToolReporter } from './types';

const wrap = (...body: string[]): string => ['*** Begin Patch', ...body, '*** End Patch'].join('\n');

describe('usesApplyPatch', () => {
  it('is true for GPT models', () => {
    for (const id of ['gpt-5', 'gpt-5-mini', 'gpt-5.4', 'openai/gpt-5-codex', 'GPT-5']) {
      expect(usesApplyPatch(id), id).toBe(true);
    }
  });

  it('is false for gpt-4, oss and every non-GPT model', () => {
    for (const id of ['gpt-4o', 'gpt-4.1', 'gpt-4', 'gpt-oss-120b', 'openai/gpt-oss-20b']) {
      expect(usesApplyPatch(id), id).toBe(false);
    }
    for (const id of ['claude-sonnet-5-5', 'claude-opus-4-6', 'gemini-3-flash', 'o3', '', undefined]) {
      expect(usesApplyPatch(id), String(id)).toBe(false);
    }
  });
});

describe('apply_patch', () => {
  let root: string;
  let outside: string;
  let context: ToolContext;
  let diffs: ChatDiff[];
  let labels: string[];

  const file = (name: string): string => join(root, name);
  const read = (name: string): Promise<string> => readFile(file(name), 'utf8');
  const exists = (name: string): Promise<boolean> =>
    stat(file(name)).then(
      () => true,
      () => false
    );

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-patch-')));
    outside = await realpath(await mkdtemp(join(tmpdir(), 'b4m-patch-out-')));
    diffs = [];
    labels = [];
    const report = { diff: (value: ChatDiff) => diffs.push(value), label: (text: string) => labels.push(text) };
    context = {
      roots: [root],
      workingDirectory: root,
      signal: new AbortController().signal,
      protectedPaths: [join(root, 'vault')],
      report: report as unknown as ToolReporter,
    };
    await writeFile(file('a.ts'), 'one\ntwo\nthree\n');
    await writeFile(file('b.ts'), 'red\ngreen\nblue\n');
  });

  const run = (patchText: string) => applyPatch.run({ patchText }, context);
  const failure = async (patchText: string): Promise<string> => {
    const caught = await run(patchText).then(
      () => null,
      (error: unknown) => error
    );
    expect(caught).toBeInstanceOf(Error);
    return (caught as Error).message;
  };

  describe('misplaced hunks', () => {
    const hunk = (path: string) =>
      wrap(
        `*** Update File: ${path}`,
        '@@',
        ' export function Chat() {',
        '-  return explorerOnlyHelper(deepLinkTarget);',
        '+  return null;'
      );

    beforeEach(async () => {
      await writeFile(file('Chat.tsx'), 'export function Chat() {\n  return null;\n}\n');
      await writeFile(
        file('Explorer.tsx'),
        'export function Chat() {\n  return explorerOnlyHelper(deepLinkTarget);\n}\n'
      );
      context = { ...context, sessionId: 'hint-session' };
    });

    it('names a file the session already read', async () => {
      await fileRead.run({ path: file('Explorer.tsx') }, context);
      expect(await failure(hunk('Chat.tsx'))).toContain(
        'These lines are in Explorer.tsx; did you mean to patch that file?'
      );
    });

    it('stays quiet about files the session never touched', async () => {
      context = { ...context, sessionId: 'other-session' };
      expect(await failure(hunk('Chat.tsx'))).not.toContain('did you mean');
    });
  });

  describe('operations', () => {
    it('adds, updates, moves and deletes in one patch, and summarises each file', async () => {
      await writeFile(file('old.txt'), 'bye\n');
      const result = await run(
        wrap(
          '*** Add File: sub/new.txt',
          '+hello',
          '*** Update File: a.ts',
          '@@',
          ' one',
          '-two',
          '+TWO',
          '*** Update File: b.ts',
          '*** Move to: c.ts',
          '@@',
          '-green',
          '+GREEN',
          '*** Delete File: old.txt'
        )
      );

      expect(await read('sub/new.txt')).toBe('hello\n');
      expect(await read('a.ts')).toBe('one\nTWO\nthree\n');
      expect(await read('c.ts')).toBe('red\nGREEN\nblue\n');
      expect(await exists('b.ts')).toBe(false);
      expect(await exists('old.txt')).toBe(false);

      expect(result).toContain('A sub/new.txt (+1 -0)');
      expect(result).toContain('M a.ts (+1 -1)');
      expect(result).toContain('R b.ts -> c.ts (+1 -1)');
      expect(result).toContain('D old.txt (+0 -1)');
      expect(result).toContain('[Edited region, lines 1-3 as they now read:]\n1\tone\n2\tTWO\n3\tthree');
      expect(labels).toEqual(['Edited 4 files']);
      expect(diffs.map(diff => diff.operation)).toEqual(['create', 'edit', 'edit', 'delete']);
      expect(diffs[2].movedFrom).toBe(file('b.ts'));
    });

    it('accepts absolute paths and a heredoc-wrapped patch', async () => {
      await run(`cat <<'EOF'\n${wrap(`*** Update File: ${file('a.ts')}`, '@@', '-one', '+1')}\nEOF`);
      expect(await read('a.ts')).toBe('1\ntwo\nthree\n');
      expect(labels).toEqual(['Patched a.ts']);
    });

    it('applies a later hunk after an earlier add of the same file in one patch', async () => {
      await run(wrap('*** Add File: n.txt', '+a', '+b', '*** Update File: n.txt', '@@', ' a', '+mid', ' b'));
      expect(await read('n.txt')).toBe('a\nmid\nb\n');
    });

    it('resolves a repeated closer by hunk order', async () => {
      await writeFile(file('t.ts'), 'it(1, () => {\n  x();\n});\nit(2, () => {\n  y();\n});\n');
      await run(wrap('*** Update File: t.ts', '@@', '-  x();', '+  X();', ' });', '@@', '-  y();', '+  Y();', ' });'));
      expect(await read('t.ts')).toBe('it(1, () => {\n  X();\n});\nit(2, () => {\n  Y();\n});\n');
    });

    it('matches through trailing whitespace and indentation, and says so', async () => {
      await writeFile(file('w.ts'), '  keep   \n  old\n');
      const result = await run(wrap('*** Update File: w.ts', '@@', ' keep', '-old', '+new'));
      expect(await read('w.ts')).toBe('  keep   \nnew\n');
      expect(result).toMatch(/w\.ts: some hunks matched only after ignoring indentation/);
    });

    it('keeps a missing final newline missing', async () => {
      await writeFile(file('nonl.txt'), 'a\nb');
      await run(wrap('*** Update File: nonl.txt', '@@', '-b', '+c'));
      expect(await read('nonl.txt')).toBe('a\nc');
    });

    it('keeps CRLF files CRLF and a BOM in place', async () => {
      await writeFile(file('win.txt'), '\uFEFFone\r\ntwo\r\nthree\r\n');
      await run(wrap('*** Update File: win.txt', '@@', ' one', '-two', '+2', '+2b', ' three'));
      expect(await read('win.txt')).toBe('\uFEFFone\r\n2\r\n2b\r\nthree\r\n');
    });

    it('builds the diff against line-ending-normalised text, so CRLF is not a whole-file change', async () => {
      await writeFile(file('win.txt'), 'one\r\ntwo\r\n');
      await run(wrap('*** Update File: win.txt', '@@', '-two', '+2'));
      expect(diffs[0]).toMatchObject({ added: 1, removed: 1 });
    });

    it('returns a no-change note when the patch leaves everything as it is', async () => {
      const result = await run(wrap('*** Update File: a.ts', '@@', '-one', '+one'));
      expect(result).toMatch(/^No change made/);
      expect(diffs).toEqual([]);
    });
  });

  describe('atomicity and failure reports', () => {
    it('writes nothing to either file when one hunk of the second does not locate', async () => {
      const message = await failure(
        wrap(
          '*** Update File: a.ts',
          '@@',
          '-one',
          '+1',
          '*** Update File: b.ts',
          '@@',
          ' red',
          '-greenish',
          '+x',
          '*** Add File: fresh.txt',
          '+x'
        )
      );

      expect(await read('a.ts')).toBe('one\ntwo\nthree\n');
      expect(await read('b.ts')).toBe('red\ngreen\nblue\n');
      expect(await exists('fresh.txt')).toBe(false);
      expect(diffs).toEqual([]);

      expect(message).toContain('Nothing was written.');
      expect(message).toContain('b.ts, hunk 1 of 1: could not find these lines:\nred\ngreenish');
      expect(message).toContain('its first line at line 1');
      expect(message).not.toContain('a.ts,');
    });

    it('names every failing hunk across files in one error', async () => {
      const message = await failure(
        wrap('*** Update File: a.ts', '@@', '-nope', '+x', '*** Update File: b.ts', '@@', '-never', '+y')
      );
      expect(message).toContain('a.ts, hunk 1 of 1');
      expect(message).toContain('b.ts, hunk 1 of 1');
    });

    it('errors when updating or deleting a missing file', async () => {
      expect(await failure(wrap('*** Update File: missing.ts', '@@', '-a', '+b'))).toMatch(
        /missing\.ts: Update File, but the file does not exist\. Use "\*\*\* Add File: missing\.ts"/
      );
      expect(await failure(wrap('*** Delete File: missing.ts'))).toMatch(
        /missing\.ts: Delete File, but the file does not exist/
      );
    });

    it('errors on adding an existing file and suggests Update', async () => {
      const message = await failure(wrap('*** Add File: a.ts', '+x'));
      expect(message).toMatch(/a\.ts: Add File, but the file already exists\. Use "\*\*\* Update File: a\.ts"/);
      expect(await read('a.ts')).toBe('one\ntwo\nthree\n');
    });

    it('refuses to move onto an existing file', async () => {
      const message = await failure(wrap('*** Update File: a.ts', '*** Move to: b.ts', '@@', '-one', '+1'));
      expect(message).toMatch(/Move to b\.ts, but that file already exists/);
    });

    it('reports a malformed patch without touching anything', async () => {
      expect(await failure('*** Begin Patch\n*** Add File: x\n+y')).toMatch(
        /^Invalid patch: .*End Patch.* Nothing was written\./
      );
      expect(await failure('   ')).toMatch(/"patchText" argument is required/);
      expect(await failure(wrap())).toMatch(/no file operations/);
    });
  });

  describe('safety rules shared with file_write', () => {
    it('rejects garbled control characters in added lines, in Add and Update alike', async () => {
      expect(await failure(wrap('*** Add File: n.txt', '+bad \u0000b7'))).toMatch(
        /n\.txt: the added lines contains U\+0000 at line 1, column 5/
      );
      expect(await failure(wrap('*** Update File: a.ts', '@@', '-one', '+x\u0001'))).toMatch(/U\+0001/);
      expect(await exists('n.txt')).toBe(false);
      expect(await read('a.ts')).toBe('one\ntwo\nthree\n');
    });

    it('refuses to patch a binary file', async () => {
      await writeFile(file('blob.bin'), Buffer.from('a \u0000 b', 'utf8'));
      expect(await failure(wrap('*** Update File: blob.bin', '@@', '-a', '+c'))).toMatch(/binary file/);
    });

    it('refuses a path outside the granted folders, and a patch that mixes one in writes nothing', async () => {
      await writeFile(join(outside, 'secret.txt'), 'not yours\n');
      const caught = await run(
        wrap(
          '*** Update File: a.ts',
          '@@',
          '-one',
          '+1',
          `*** Update File: ${join(outside, 'secret.txt')}`,
          '@@',
          '-not yours',
          '+mine'
        )
      ).then(
        () => null,
        (error: unknown) => error
      );
      expect(caught).toBeInstanceOf(PathAccessDenied);
      expect(await read('a.ts')).toBe('one\ntwo\nthree\n');
      expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('not yours\n');
    });

    it('refuses a relative path that escapes the folder, a symlink out, a move out, and protected paths', async () => {
      await symlink(outside, file('link'));
      await mkdir(file('vault'));
      for (const body of [
        ['*** Add File: ../escape.txt', '+x'],
        ['*** Add File: link/planted.txt', '+x'],
        ['*** Update File: a.ts', `*** Move to: ${join(outside, 'moved.ts')}`, '@@', '-one', '+1'],
        ['*** Add File: vault/token', '+x'],
      ]) {
        await expect(run(wrap(...body))).rejects.toBeInstanceOf(PathAccessDenied);
      }
      expect(await exists('../escape.txt')).toBe(false);
      await expect(stat(join(outside, 'planted.txt'))).rejects.toThrow();
      expect(await read('a.ts')).toBe('one\ntwo\nthree\n');
    });
  });

  describe('approval', () => {
    it('shows one diff for a single file and one per file for several', async () => {
      const single = await applyPatch.approval?.(
        { patchText: wrap('*** Update File: a.ts', '@@', '-one', '+1') },
        context
      );
      expect(single?.diff).toMatchObject({ operation: 'edit', added: 1, removed: 1 });
      expect(single?.diffs).toBeUndefined();

      const several = await applyPatch.approval?.(
        { patchText: wrap('*** Update File: a.ts', '@@', '-one', '+1', '*** Delete File: b.ts') },
        context
      );
      expect(several?.diff).toBeUndefined();
      expect(several?.diffs?.map(diff => diff.operation)).toEqual(['edit', 'delete']);
      expect(several?.detail).toContain('Apply patch to 2 files (+1 -4):');
      expect(several?.detail).toContain('D b.ts (+0 -3)');
    });

    it('fails at approval time, before the user is asked, when a hunk does not locate', async () => {
      await expect(
        applyPatch.approval?.({ patchText: wrap('*** Update File: a.ts', '@@', '-nope', '+x') }, context)
      ).rejects.toThrow(/could not find these lines/);
    });

    it('refuses a write when the file changed after the diff was approved', async () => {
      const input = { patchText: wrap('*** Update File: a.ts', '@@', '-one', '+1') };
      await applyPatch.approval?.(input, context);
      await writeFile(file('a.ts'), 'one\nsomeone else\n');
      await expect(applyPatch.run(input, context)).rejects.toThrow(/changed on disk after the user approved/);
      expect(await read('a.ts')).toBe('one\nsomeone else\n');
    });

    it('needs no approval for a patch that changes nothing', async () => {
      const input = { patchText: wrap('*** Update File: a.ts', '@@', '-one', '+one') };
      expect(await applyPatch.needsApproval?.(input, context)).toBe(false);
      expect(await applyPatch.needsApproval?.({ patchText: wrap('*** Delete File: a.ts') }, context)).toBe(true);
    });
  });
});
