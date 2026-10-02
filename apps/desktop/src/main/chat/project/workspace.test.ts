import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  containerDirectory,
  currentBranch,
  git,
  isGitRepository,
  listBranches,
  listWorktrees,
  projectDisplayName,
  unusableProjectReason,
} from './git';
import { resolveWorkspace, worktreeFolderName } from './workspace';

/**
 * Real git repositories in a temp directory rather than a mocked child_process: the whole
 * value of this module is that it drives git correctly, and a mock would only assert that the
 * arguments match what was written here.
 *
 * The fixture is the user's own layout - <container>/.bare beside <container>/main - because
 * that is what decides where a worktree lands. An ordinary clone is covered separately below.
 */
async function bareLayoutRepository(): Promise<{ container: string; main: string }> {
  // realpath because on macOS tmpdir() is a symlink into /private and git reports resolved paths.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-project-')));

  const source = join(root, 'source');
  await mkdir(source, { recursive: true });
  await git(source, ['init', '--initial-branch=main', '--quiet']);
  await git(source, ['config', 'user.email', 'test@example.com']);
  await git(source, ['config', 'user.name', 'Test']);
  await writeFile(join(source, 'README.md'), 'hello\n', 'utf8');
  await git(source, ['add', '.']);
  await git(source, ['commit', '--quiet', '-m', 'first']);

  const container = join(root, 'project');
  await mkdir(container, { recursive: true });
  await git(container, ['clone', '--bare', '--quiet', source, '.bare']);

  const bare = join(container, '.bare');
  const main = join(container, 'main');
  await git(bare, ['worktree', 'add', '--quiet', main, 'main']);
  await git(main, ['config', 'user.email', 'test@example.com']);
  await git(main, ['config', 'user.name', 'Test']);
  // The container's own gitlink, written by the user's `worktree` helper. Without it git walks
  // out of the container looking for a repository, and the tests below would be asking about a
  // plain folder rather than about the layout that confuses them.
  await writeFile(join(container, '.git'), 'gitdir: ./.bare\n', 'utf8');

  return { container, main };
}

describe('worktreeFolderName', () => {
  it("turns a branch's slashes into '+' so it is one directory entry", () => {
    expect(worktreeFolderName('fix/some-branch')).toBe('fix+some-branch');
    expect(worktreeFolderName('feat/a/b')).toBe('feat+a+b');
    expect(worktreeFolderName('main')).toBe('main');
  });
});

describe('project inspection', () => {
  it('lists the real branches, checked-out one first', async () => {
    const { main } = await bareLayoutRepository();
    await git(main, ['branch', 'feat/one']);
    await git(main, ['branch', 'feat/two']);

    expect(await listBranches(main)).toEqual(['main', 'feat/one', 'feat/two']);
  });

  it('names the container as the parent of the shared git dir', async () => {
    const { container, main } = await bareLayoutRepository();
    expect(await containerDirectory(main)).toBe(container);
  });

  /**
   * In the bare-repo layout the directory a user picks IS <container>/main, so a plain basename
   * would label every project "main" in the sidebar.
   */
  it('names the project after its container, not the checkout folder', async () => {
    const { main } = await bareLayoutRepository();
    expect(await projectDisplayName(main)).toBe('project');
  });

  it('names an ordinary clone after its own folder', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-plain-')));
    const repo = join(root, 'myrepo');
    await mkdir(repo, { recursive: true });
    await git(repo, ['init', '--initial-branch=main', '--quiet']);

    expect(await projectDisplayName(repo)).toBe('myrepo');
  });
});

/**
 * The container answers `rev-parse --abbrev-ref HEAD` for the BARE repo, so for the whole of
 * this layout there is a branch name available that no session is ever on. The chip used to
 * print it. These pin the two functions that decide what a repository is to the same answer.
 */
describe('a worktree container is not a checkout', () => {
  it('reads the branch of a checkout, and nothing from the container', async () => {
    const { container, main } = await bareLayoutRepository();

    expect(await currentBranch(main)).toBe('main');
    expect(await currentBranch(container)).toBeNull();
  });

  it('agrees with isGitRepository about which of the two is a repository', async () => {
    const { container, main } = await bareLayoutRepository();

    expect(await isGitRepository(main)).toBe(true);
    expect(await isGitRepository(container)).toBe(false);
    expect(await currentBranch(container)).toBeNull();
  });

  it('answers null on a detached HEAD rather than the literal string', async () => {
    const { main } = await bareLayoutRepository();
    await git(main, ['checkout', '--quiet', '--detach', 'HEAD']);

    expect(await currentBranch(main)).toBeNull();
  });

  it('refuses the container as a project and names the checkouts inside it', async () => {
    const { container, main } = await bareLayoutRepository();
    await resolveWorkspace(main, 'feat/one');

    const reason = await unusableProjectReason(container);
    expect(reason).toMatch(/not a checkout/i);
    expect(reason).toContain('main');
    expect(reason).toContain('feat+one');
  });

  it('lets a checkout, an ordinary clone and a plain folder through', async () => {
    const { main } = await bareLayoutRepository();
    const plain = await realpath(await mkdtemp(join(tmpdir(), 'b4m-plain-')));
    const clone = join(plain, 'myrepo');
    await mkdir(clone, { recursive: true });
    await git(clone, ['init', '--initial-branch=main', '--quiet']);

    expect(await unusableProjectReason(main)).toBeNull();
    expect(await unusableProjectReason(clone)).toBeNull();
    expect(await unusableProjectReason(plain)).toBeNull();
  });
});

describe('resolveWorkspace', () => {
  let container: string;
  let main: string;

  beforeEach(async () => {
    ({ container, main } = await bareLayoutRepository());
  });

  it('creates the worktree inside the container, never as a ../ sibling', async () => {
    const resolved = await resolveWorkspace(main, 'feat/thing');

    expect(resolved.outcome).toBe('created');
    expect(resolved.workingDirectory).toBe(join(container, 'feat+thing'));
    // The guard that matters: the path stays under the project's own container, so nothing is
    // scattered beside unrelated projects.
    expect(resolved.workingDirectory.startsWith(`${container}/`)).toBe(true);
  });

  it('creates the branch when it does not exist yet', async () => {
    const resolved = await resolveWorkspace(main, 'feat/brand-new');

    const head = (await git(resolved.workingDirectory, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    expect(head).toBe('feat/brand-new');
  });

  it('checks out an existing branch rather than refusing it', async () => {
    await git(main, ['branch', 'feat/already']);
    const resolved = await resolveWorkspace(main, 'feat/already');

    expect(resolved.outcome).toBe('created');
    expect((await git(resolved.workingDirectory, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('feat/already');
  });

  it('reuses a worktree that already exists for that branch instead of failing', async () => {
    const first = await resolveWorkspace(main, 'feat/twice');
    const second = await resolveWorkspace(main, 'feat/twice');

    expect(second).toEqual({ workingDirectory: first.workingDirectory, outcome: 'reused' });
    expect((await listWorktrees(main)).filter(entry => entry.branch === 'feat/twice')).toHaveLength(1);
  });

  /**
   * git allows a branch in exactly one worktree, so picking the branch the main checkout is on
   * has to resolve TO the main checkout. The caller surfaces the resolved path, so this never
   * silently claims an isolation it did not get.
   */
  it('resolves the main checkout when its own branch is chosen', async () => {
    const resolved = await resolveWorkspace(main, 'main');

    expect(resolved).toEqual({ workingDirectory: main, outcome: 'reused' });
  });

  it('refuses a path already occupied by something that is not a worktree', async () => {
    await mkdir(join(container, 'feat+taken'), { recursive: true });
    await writeFile(join(container, 'feat+taken', 'notes.txt'), 'mine\n', 'utf8');

    await expect(resolveWorkspace(main, 'feat/taken')).rejects.toThrow(/already exists but is not a git worktree/);
  });

  /**
   * The case this guard used to get wrong: a worktree created for one branch and later switched
   * to another is still a worktree, so "not a git worktree" was false and sent the user off to
   * `mv` a directory git is tracking.
   */
  it('names the branch a worktree at that path is actually on', async () => {
    const occupied = await resolveWorkspace(main, 'agent/one');
    await git(occupied.workingDirectory, ['checkout', '--quiet', '-b', 'fix/one']);

    await expect(resolveWorkspace(main, 'agent/one')).rejects.toThrow(/is a git worktree holding the branch fix\/one/);
    await expect(resolveWorkspace(main, 'agent/one')).rejects.not.toThrow(/is not a git worktree/);
  });

  it('points at git worktree move rather than telling the user to move it aside', async () => {
    const occupied = await resolveWorkspace(main, 'agent/two');
    await git(occupied.workingDirectory, ['checkout', '--quiet', '-b', 'fix/two']);

    await expect(resolveWorkspace(main, 'agent/two')).rejects.toThrow(/git worktree move/);
  });

  it('reports a detached worktree as such rather than as a branch', async () => {
    const occupied = await resolveWorkspace(main, 'agent/three');
    await git(occupied.workingDirectory, ['checkout', '--quiet', '--detach', 'HEAD']);

    await expect(resolveWorkspace(main, 'agent/three')).rejects.toThrow(/holding a detached HEAD/);
  });

  it('reuses a worktree registered for the branch even at an unexpected path', async () => {
    const elsewhere = join(container, 'somewhere-else');
    await git(main, ['worktree', 'add', '--quiet', '-b', 'feat/elsewhere', elsewhere]);

    expect(await resolveWorkspace(main, 'feat/elsewhere')).toEqual({
      workingDirectory: elsewhere,
      outcome: 'reused',
    });
  });
});

/**
 * With core.bare=false in the shared config git lists the bare repo like a checkout, branch
 * line included, and it comes first - the shape that rooted sessions in <container>/.bare.
 */
describe('resolveWorkspace when git lists the bare repo as a checkout', () => {
  let container: string;
  let main: string;

  beforeEach(async () => {
    ({ container, main } = await bareLayoutRepository());
    await git(join(container, '.bare'), ['config', 'core.bare', 'false']);
  });

  it('never lists the bare repo as a worktree', async () => {
    const paths = (await listWorktrees(main)).map(entry => entry.path);

    expect(paths).toEqual([main]);
  });

  it('reuses the worktree already holding the chosen branch', async () => {
    expect(await resolveWorkspace(main, 'main')).toEqual({ workingDirectory: main, outcome: 'reused' });
  });

  it('creates a new branch inside the container, not in .bare', async () => {
    const resolved = await resolveWorkspace(main, 'fix/new-thing');

    expect(resolved).toEqual({ workingDirectory: join(container, 'fix+new-thing'), outcome: 'created' });
  });
});

describe('resolveWorkspace in an ordinary clone', () => {
  it('puts the worktree beside the checkout, which is where the shell helper puts it too', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-plain-')));
    const repo = join(root, 'repo');
    await mkdir(repo, { recursive: true });
    await git(repo, ['init', '--initial-branch=main', '--quiet']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'Test']);
    await writeFile(join(repo, 'README.md'), 'hello\n', 'utf8');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '--quiet', '-m', 'first']);

    const resolved = await resolveWorkspace(repo, 'feat/inside');

    // git-common-dir is <repo>/.git here, so the container is <repo> itself.
    expect(resolved.workingDirectory).toBe(join(repo, 'feat+inside'));
  });
});
