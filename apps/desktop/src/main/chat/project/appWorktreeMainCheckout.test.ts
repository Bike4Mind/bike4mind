import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { mainCheckoutOf } from '../tools/shellTools';
import { appWorktreeMainCheckout, appWorktreeRoot } from './workspace';

const run = promisify(execFile);

async function repository(): Promise<string> {
  // realpath because on macOS tmpdir() is a symlink into /private and git reports resolved paths.
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'b4m-app-worktree-')));
  const git = (...args: string[]) =>
    run('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo });
  await git('init', '-q', '-b', 'main');
  await writeFile(join(repo, 'README.md'), 'x');
  await git('add', '.');
  await git('commit', '-q', '-m', 'init');
  return repo;
}

describe('appWorktreeMainCheckout', () => {
  it('names the main checkout of a worktree inside its app root', async () => {
    const repo = await repository();
    const worktree = join(appWorktreeRoot(repo), 'task');
    await run('git', ['worktree', 'add', '-q', '-b', 'task', worktree], { cwd: repo });
    expect(await appWorktreeMainCheckout(worktree, mainCheckoutOf)).toBe(repo);
  });

  it('refuses a worktree made anywhere else', async () => {
    const repo = await repository();
    const elsewhere = join(await realpath(await mkdtemp(join(tmpdir(), 'b4m-elsewhere-'))), 'task');
    await run('git', ['worktree', 'add', '-q', '-b', 'task', elsewhere], { cwd: repo });
    expect(await appWorktreeMainCheckout(elsewhere, mainCheckoutOf)).toBeNull();
  });

  it('refuses the main checkout and a plain folder inside the app root', async () => {
    const repo = await repository();
    const folder = join(appWorktreeRoot(repo), 'plain');
    await mkdir(folder, { recursive: true });
    expect(await appWorktreeMainCheckout(repo, mainCheckoutOf)).toBeNull();
    expect(await appWorktreeMainCheckout(folder, mainCheckoutOf)).toBeNull();
  });
});
