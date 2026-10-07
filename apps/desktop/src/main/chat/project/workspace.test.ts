import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
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
import { appWorktreeRoot, resolveWorkspace, worktreeFolderName } from './workspace';

/**
 * Real git repositories in a temp directory rather than a mocked child_process: the whole
 * value of this module is that it drives git correctly, and a mock would only assert that the
 * arguments match what was written here.
 *
 * The fixture is the user's own layout - <container>/.bare beside <container>/main - because
 * that is what decides where a worktree lands. An ordinary clone is covered separately below.
 */
async function bareLayoutRepository(): Promise<{ container: string; main: string; source: string }> {
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

  return { container, main, source };
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
    await git(main, ['worktree', 'add', '--quiet', '-b', 'feat/one', join(container, 'feat+one')]);

    const reason = await unusableProjectReason(container);
    expect(reason).toMatch(/not a checkout/i);
    expect(reason).toContain('main');
    expect(reason).toContain('feat+one');
  });

  /**
   * The containment guard this app's own nesting now depends on: a worktree under
   * <container>/.b4m/worktrees is not a folder anyone picks, and listing it would send the user
   * off to point a session at one.
   */
  it('leaves the app own worktrees out of the folders it names', async () => {
    const { container, main } = await bareLayoutRepository();
    const resolved = await resolveWorkspace(main, { base: 'main' });

    const reason = await unusableProjectReason(container);
    expect(reason).toContain('main');
    expect(reason).not.toContain(worktreeFolderName(resolved.branch));
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
  let root: string;

  beforeEach(async () => {
    ({ container, main } = await bareLayoutRepository());
    root = appWorktreeRoot(container);
  });

  it('creates the worktree in the app own directory, never as a ../ sibling', async () => {
    const resolved = await resolveWorkspace(main, { base: 'main' });

    expect(resolved.outcome).toBe('created');
    expect(resolved.workingDirectory).toBe(join(root, worktreeFolderName(resolved.branch)));
    // The guard that matters: the path stays under the project own container, so nothing is
    // scattered beside unrelated projects.
    expect(resolved.workingDirectory.startsWith(`${container}/`)).toBe(true);
  });

  /**
   * The collision the nesting exists to make impossible: <container>/main is the user primary
   * checkout, and the app used to resolve the branch `main` straight onto it.
   */
  it('never lands on a folder the user named', async () => {
    const resolved = await resolveWorkspace(main, { base: 'main' });

    expect(resolved.workingDirectory).not.toBe(main);
    expect(join(container, 'main')).toBe(main);
  });

  /**
   * Part of the same change: the chosen branch is a BASE. Picking one that is already checked
   * out somewhere used to hand back that checkout, so "worktree" claimed an isolation the
   * session did not get - and `main` is both the likeliest pick and always already checked out.
   */
  it('cuts a new branch from the chosen one rather than checking it out', async () => {
    const resolved = await resolveWorkspace(main, { base: 'main', name: 'Fix the login form' });

    expect(resolved.branch).toMatch(/^b4m\/fix-the-login-form-[0-9a-f]{6}$/);
    expect(resolved.branch).not.toBe('main');
    expect((await git(resolved.workingDirectory, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe(resolved.branch);
    // Same commit as the base, which is what "start from main" means.
    expect((await git(resolved.workingDirectory, ['rev-parse', 'HEAD'])).trim()).toBe(
      (await git(main, ['rev-parse', 'main'])).trim()
    );
  });

  it('names the branch after the session even when the base is a feature branch', async () => {
    await git(main, ['branch', 'feat/base']);
    const resolved = await resolveWorkspace(main, { base: 'feat/base', name: 'Second pass' });

    expect(resolved.branch).toMatch(/^b4m\/second-pass-[0-9a-f]{6}$/);
    expect((await git(resolved.workingDirectory, ['merge-base', '--is-ancestor', 'feat/base', 'HEAD'])).trim()).toBe(
      ''
    );
  });

  it('falls back to a generated name when the session has no usable title', async () => {
    const resolved = await resolveWorkspace(main, { base: 'main' });

    expect(resolved.branch).toMatch(/^b4m\/session-[0-9a-f]{6}$/);
  });

  it('gives two sessions on the same base two different worktrees', async () => {
    const first = await resolveWorkspace(main, { base: 'main', name: 'Same title' });
    const second = await resolveWorkspace(main, { base: 'main', name: 'Same title' });

    expect(second.branch).not.toBe(first.branch);
    expect(second.workingDirectory).not.toBe(first.workingDirectory);
  });

  /**
   * The other half of the one rule: a name that is NOT a branch is the user naming their own,
   * not a base. Typing it in the chip menu still creates it.
   */
  it('creates a typed name that names no branch, rather than deriving one', async () => {
    const resolved = await resolveWorkspace(main, { base: 'feat/brand-new' });

    expect(resolved.branch).toBe('feat/brand-new');
    expect((await git(resolved.workingDirectory, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('feat/brand-new');
  });

  it('does not track the base it forked from', async () => {
    const resolved = await resolveWorkspace(main, { base: 'main' });

    await expect(git(resolved.workingDirectory, ['config', `branch.${resolved.branch}.merge`])).rejects.toThrow();
  });

  /**
   * The whole point of handing `branch` back out: without it every restart and every re-read of
   * a project would cut another branch, which at this user volume is a worktree an hour.
   */
  it('re-resolves to the same worktree when given the branch it cut', async () => {
    const first = await resolveWorkspace(main, { base: 'main', name: 'Idempotent' });
    const second = await resolveWorkspace(main, { base: 'main', branch: first.branch, name: 'Idempotent' });

    expect(second).toEqual({ workingDirectory: first.workingDirectory, branch: first.branch, outcome: 'reused' });
    expect((await listWorktrees(main)).filter(entry => entry.branch?.startsWith('b4m/'))).toHaveLength(1);
  });

  it('re-creates the worktree for a recorded branch whose folder was removed', async () => {
    const first = await resolveWorkspace(main, { base: 'main' });
    await rm(first.workingDirectory, { recursive: true, force: true });
    await git(main, ['worktree', 'prune']);

    const again = await resolveWorkspace(main, { base: 'main', branch: first.branch });

    expect(again).toEqual({ workingDirectory: first.workingDirectory, branch: first.branch, outcome: 'created' });
  });

  it('refuses a path already occupied by something that is not a worktree', async () => {
    await mkdir(join(root, 'feat+taken'), { recursive: true });
    await writeFile(join(root, 'feat+taken', 'notes.txt'), 'mine\n', 'utf8');

    await expect(resolveWorkspace(main, { base: 'feat/taken' })).rejects.toThrow(
      /already exists but is not a git worktree/
    );
  });

  /**
   * The case this guard used to get wrong: a worktree created for one branch and later switched
   * to another is still a worktree, so "not a git worktree" was false and sent the user off to
   * `mv` a directory git is tracking.
   */
  it('names the branch a worktree at that path is actually on', async () => {
    const occupied = await resolveWorkspace(main, { branch: 'agent/one' });
    await git(occupied.workingDirectory, ['checkout', '--quiet', '-b', 'fix/one']);

    await expect(resolveWorkspace(main, { branch: 'agent/one' })).rejects.toThrow(
      /is a git worktree holding the branch fix\/one/
    );
    await expect(resolveWorkspace(main, { branch: 'agent/one' })).rejects.not.toThrow(/is not a git worktree/);
  });

  it('points at git worktree move rather than telling the user to move it aside', async () => {
    const occupied = await resolveWorkspace(main, { branch: 'agent/two' });
    await git(occupied.workingDirectory, ['checkout', '--quiet', '-b', 'fix/two']);

    await expect(resolveWorkspace(main, { branch: 'agent/two' })).rejects.toThrow(/git worktree move/);
  });

  it('reports a detached worktree as such rather than as a branch', async () => {
    const occupied = await resolveWorkspace(main, { branch: 'agent/three' });
    await git(occupied.workingDirectory, ['checkout', '--quiet', '--detach', 'HEAD']);

    await expect(resolveWorkspace(main, { branch: 'agent/three' })).rejects.toThrow(/holding a detached HEAD/);
  });

  it('reuses a worktree registered for the branch even at an unexpected path', async () => {
    const elsewhere = join(container, 'somewhere-else');
    await git(main, ['worktree', 'add', '--quiet', '-b', 'feat/elsewhere', elsewhere]);

    expect(await resolveWorkspace(main, { branch: 'feat/elsewhere' })).toEqual({
      workingDirectory: elsewhere,
      branch: 'feat/elsewhere',
      outcome: 'reused',
    });
  });
});

/**
 * A long-lived local `main` drifts hundreds of commits behind origin/main without anyone
 * noticing, and a branch cut from it starts life needing a merge nobody asked for.
 *
 * An ordinary clone rather than the layout above: `clone --bare` writes no refs/remotes, so the
 * bare fixture has no origin/main to prefer and could not tell the two answers apart.
 */
describe('resolveWorkspace choosing what to fork from', () => {
  async function clonedRepository(): Promise<{ repo: string; origin: string }> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-clone-')));
    const origin = join(root, 'origin.git');
    await mkdir(origin, { recursive: true });
    await git(origin, ['init', '--bare', '--initial-branch=main', '--quiet']);

    const repo = join(root, 'repo');
    await git(root, ['clone', '--quiet', origin, repo]);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'Test']);
    await writeFile(join(repo, 'README.md'), 'hello\n', 'utf8');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '--quiet', '-m', 'first']);
    await git(repo, ['push', '--quiet', '-u', 'origin', 'main']);
    return { repo, origin };
  }

  it('forks from the remote base when the local one is behind it', async () => {
    const { repo } = await clonedRepository();
    await writeFile(join(repo, 'later.txt'), 'later\n', 'utf8');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '--quiet', '-m', 'second']);
    await git(repo, ['push', '--quiet', 'origin', 'main']);
    // The stale local ref: origin has the commit, this checkout no longer does.
    await git(repo, ['reset', '--quiet', '--hard', 'HEAD~1']);
    // Dropped so the answer can only come from the fetch, which is the half that matters on a
    // machine where origin/main has moved since this checkout last looked.
    await git(repo, ['update-ref', '-d', 'refs/remotes/origin/main']);

    const resolved = await resolveWorkspace(repo, { base: 'main' });

    expect((await git(repo, ['rev-parse', 'main'])).trim()).not.toBe(
      (await git(repo, ['rev-parse', 'origin/main'])).trim()
    );
    expect((await git(resolved.workingDirectory, ['rev-parse', 'HEAD'])).trim()).toBe(
      (await git(repo, ['rev-parse', 'origin/main'])).trim()
    );
  });

  it('keeps local commits the remote has not seen', async () => {
    const { repo } = await clonedRepository();
    await writeFile(join(repo, 'unpushed.txt'), 'mine\n', 'utf8');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '--quiet', '-m', 'unpushed']);

    const resolved = await resolveWorkspace(repo, { base: 'main' });

    expect((await git(resolved.workingDirectory, ['rev-parse', 'HEAD'])).trim()).toBe(
      (await git(repo, ['rev-parse', 'main'])).trim()
    );
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

  it('creates a new branch in the app directory, not in .bare and not on the main checkout', async () => {
    const resolved = await resolveWorkspace(main, { base: 'main' });

    expect(resolved.workingDirectory).toBe(join(appWorktreeRoot(container), worktreeFolderName(resolved.branch)));
    expect(resolved.outcome).toBe('created');
  });
});

describe('resolveWorkspace in an ordinary clone', () => {
  async function plainClone(): Promise<string> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-plain-')));
    const repo = join(root, 'repo');
    await mkdir(repo, { recursive: true });
    await git(repo, ['init', '--initial-branch=main', '--quiet']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'Test']);
    await writeFile(join(repo, 'README.md'), 'hello\n', 'utf8');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '--quiet', '-m', 'first']);
    return repo;
  }

  /**
   * git-common-dir is <repo>/.git here, so the container IS the repository. Under the old flat
   * layout every app worktree was therefore an untracked sibling folder in the repo root.
   */
  it('nests the worktree in the app own directory rather than the repo root', async () => {
    const repo = await plainClone();
    const resolved = await resolveWorkspace(repo, { base: 'main' });

    expect(resolved.workingDirectory).toBe(join(appWorktreeRoot(repo), worktreeFolderName(resolved.branch)));
  });

  it('ignores its own directory without touching the repo gitignore', async () => {
    const repo = await plainClone();
    await resolveWorkspace(repo, { base: 'main' });

    expect(await readFile(join(repo, '.b4m', '.gitignore'), 'utf8')).toBe('*\n');
    expect((await git(repo, ['status', '--porcelain'])).trim()).toBe('');
    await expect(stat(join(repo, '.gitignore'))).rejects.toThrow();
  });
});
