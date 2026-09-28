import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { fileRead, globFiles } from './fileTools';
import { resolveWithinRoots } from './paths';
import { resolveCwd } from './shellTools';
import type { ToolContext } from './types';

/**
 * The bug this feature exists to prevent: a Code session bound to a worktree whose tools still
 * operate in the main checkout.
 *
 * The shape of every case here is the same - the session's working directory is the SECOND
 * root, so anything that silently falls back to `roots[0]` lands in the wrong checkout and the
 * assertion catches it.
 */
describe('tools rooted at the session working directory', () => {
  let mainCheckout: string;
  let worktree: string;
  let context: ToolContext;

  beforeEach(async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-cwd-')));
    mainCheckout = join(root, 'main');
    worktree = join(root, 'feat+thing');
    await mkdir(mainCheckout, { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(join(mainCheckout, 'where.txt'), 'main checkout\n', 'utf8');
    await writeFile(join(worktree, 'where.txt'), 'worktree\n', 'utf8');

    context = {
      roots: [mainCheckout, worktree],
      workingDirectory: worktree,
      signal: new AbortController().signal,
    };
  });

  it('runs a command in the worktree, not the first granted root', async () => {
    expect(await resolveCwd({}, context.roots, context.workingDirectory)).toBe(worktree);
  });

  it('still honours a cwd the model names explicitly, when it is granted', async () => {
    expect(await resolveCwd({ cwd: mainCheckout }, context.roots, context.workingDirectory)).toBe(mainCheckout);
  });

  it('falls back to the first root only when there is no working directory', async () => {
    expect(await resolveCwd({}, context.roots, undefined)).toBe(mainCheckout);
  });

  it('resolves a relative path against the worktree rather than the process cwd', async () => {
    const resolved = await resolveWithinRoots('where.txt', context.roots, worktree);
    expect(resolved).toBe(join(worktree, 'where.txt'));
  });

  it('reads the worktree copy of a file that exists in both', async () => {
    const output = await fileRead.run({ path: 'where.txt' }, context);
    expect(output).toContain('worktree');
    expect(output).not.toContain('main checkout');
  });

  it('anchors a glob with no path at the worktree even though two roots are granted', async () => {
    const output = await globFiles.run({ pattern: '*.txt' }, context);
    // The listing names its base directory in the header and the matches relative to it.
    expect(output).toContain(worktree);
    expect(output).not.toContain(mainCheckout);
  });

  // A Chat session has no working directory, so the pre-existing ambiguity error must survive.
  it('still asks for a path when several roots are granted and nothing grounds the session', async () => {
    const chatContext: ToolContext = { roots: [mainCheckout, worktree], signal: new AbortController().signal };
    await expect(globFiles.run({ pattern: '*.txt' }, chatContext)).rejects.toThrow(/Specify "path"/);
  });
});
