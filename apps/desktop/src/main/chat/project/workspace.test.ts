import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhaseTimer } from '../PhaseTimer';
import { gitFixture } from './gitFixture.testHelper';
import * as projectGit from './git';
import {
  branchExists,
  containerDirectory,
  currentBranch,
  fetchRemoteFor,
  git,
  isGitRepository,
  listBranches,
  listWorktrees,
  projectDisplayName,
  unusableProjectReason,
} from './git';
import { mainCheckoutOf } from '../tools/shellTools';
import {
  appWorktreeMainCheckout,
  appWorktreeRoot,
  releaseBranchName,
  reserveBranchName,
  resolveWorkspace,
  sessionBranchName,
  SpareWorktrees,
  unusedBranchName,
  worktreeFolderName,
} from './workspace';

/**
 * Real git repositories in a temp directory rather than a mocked child_process: the whole
 * value of this module is that it drives git correctly, and a mock would only assert that the
 * arguments match what was written here.
 *
 * The fixture is the user's own layout - <container>/.bare beside <container>/main - because
 * that is what decides where a worktree lands. An ordinary clone is covered separately below.
 */
const bareLayoutRoot = gitFixture('b4m-project-', buildBareLayout, [
  'project/.bare/config',
  'project/.bare/worktrees/main/gitdir',
  'project/main/.git',
]);

async function bareLayoutRepository(): Promise<{ container: string; main: string; source: string }> {
  const root = await bareLayoutRoot();
  return { container: join(root, 'project'), main: join(root, 'project', 'main'), source: join(root, 'source') };
}

async function buildBareLayout(root: string): Promise<void> {
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
}

beforeAll(async () => {
  await bareLayoutRoot();
});

async function plainFolder(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'b4m-plain-')));
}

describe('branch and folder names', () => {
  it("turns a branch's slashes into '+' so it is one directory entry", () => {
    expect(worktreeFolderName('fix/some-branch')).toBe('fix+some-branch');
    expect(worktreeFolderName('feat/a/b')).toBe('feat+a+b');
    expect(worktreeFolderName('main')).toBe('main');
  });

  it('derives a session branch from its title, with a random suffix so equal titles never collide', () => {
    expect(sessionBranchName('Fix the login form')).toMatch(/^b4m\/fix-the-login-form-[0-9a-f]{6}$/);
    // An untitled conversation still gets a usable branch.
    expect(sessionBranchName()).toMatch(/^b4m\/session-[0-9a-f]{6}$/);
    expect(sessionBranchName('Same title')).not.toBe(sessionBranchName('Same title'));
  });
});

/**
 * The container answers `rev-parse --abbrev-ref HEAD` for the BARE repo, so for the whole of
 * this layout there is a branch name available that no session is ever on. The chip used to
 * print it. These pin the functions that decide what a repository is to the same answer.
 */
describe('project inspection in the bare layout', () => {
  it('tells the checkout from its container', async () => {
    const { container, main } = await bareLayoutRepository();

    expect(await containerDirectory(main), 'container is the parent of the shared git dir').toBe(container);
    // A plain basename would label every project in this layout "main".
    expect(await projectDisplayName(main), 'project is named after its container').toBe('project');
    expect(await currentBranch(main)).toBe('main');
    expect(await currentBranch(container), 'nothing is read from the container').toBeNull();
    expect(await isGitRepository(main)).toBe(true);
    expect(await isGitRepository(container), 'agrees with currentBranch about the container').toBe(false);
    expect(await unusableProjectReason(main)).toBeNull();

    await git(main, ['branch', 'feat/one']);
    await git(main, ['branch', 'feat/two']);
    expect(await listBranches(main), 'real branches, checked-out one first').toEqual(['main', 'feat/one', 'feat/two']);

    await git(main, ['checkout', '--quiet', '--detach', 'HEAD']);
    expect(await currentBranch(main), 'a detached HEAD is null, not the literal string').toBeNull();
  });

  /**
   * The containment guard this app's own nesting depends on: a worktree under
   * <container>/.b4m/worktrees is not a folder anyone picks, and listing it would send the user
   * off to point a session at one.
   */
  it('refuses the container as a project, naming the checkouts inside it but not the app own worktrees', async () => {
    const { container, main } = await bareLayoutRepository();
    await git(main, ['worktree', 'add', '--quiet', '-b', 'feat/one', join(container, 'feat+one')]);
    await git(main, ['worktree', 'add', '--quiet', '-b', 'b4m/app', join(appWorktreeRoot(container), 'b4m+app')]);

    const reason = await unusableProjectReason(container);
    expect(reason).toMatch(/not a checkout/i);
    expect(reason).toContain('main');
    expect(reason).toContain('feat+one');
    expect(reason).not.toContain('b4m+app');
  });

  it('names an ordinary clone after its own folder, and lets it and a plain folder through', async () => {
    const plain = await plainFolder();
    const clone = join(plain, 'myrepo');
    await mkdir(clone, { recursive: true });
    await git(clone, ['init', '--initial-branch=main', '--quiet']);

    expect(await projectDisplayName(clone)).toBe('myrepo');
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

  /**
   * The chosen branch is a BASE. Picking one already checked out used to hand back that checkout,
   * so "worktree" claimed an isolation the session did not get - and `main` is both the likeliest
   * pick and always already checked out. <container>/main is also the user's primary checkout,
   * which the app used to resolve the branch `main` straight onto.
   */
  it('cuts a branch of its own from the chosen base inside the app directory, and reuses it when handed back', async () => {
    const resolved = await resolveWorkspace(main, { base: 'main', name: 'Fix the login form' });

    expect(resolved.outcome).toBe('created');
    expect(resolved.branch).toMatch(/^b4m\/fix-the-login-form-[0-9a-f]{6}$/);
    expect(resolved.workingDirectory, 'in the app directory').toBe(join(root, worktreeFolderName(resolved.branch)));
    expect(resolved.workingDirectory.startsWith(`${container}/`), 'never a ../ sibling').toBe(true);
    expect(resolved.workingDirectory, 'never the folder the user named').not.toBe(main);
    expect((await git(resolved.workingDirectory, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe(resolved.branch);
    expect((await git(resolved.workingDirectory, ['rev-parse', 'HEAD'])).trim(), 'starts at the base').toBe(
      (await git(main, ['rev-parse', 'main'])).trim()
    );
    await expect(
      git(resolved.workingDirectory, ['config', `branch.${resolved.branch}.merge`]),
      'does not track the base it forked from'
    ).rejects.toThrow();

    // Without handing `branch` back, every restart and every re-read of a project would cut another.
    const again = await resolveWorkspace(main, { base: 'main', branch: resolved.branch, name: 'Fix the login form' });
    expect(again).toEqual({ workingDirectory: resolved.workingDirectory, branch: resolved.branch, outcome: 'reused' });
    expect((await listWorktrees(main)).filter(entry => entry.branch?.startsWith('b4m/'))).toHaveLength(1);
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

  // What a recorded branch whose folder was removed and pruned leaves: the branch, and no worktree.
  it('re-creates the worktree for a recorded branch that has none', async () => {
    await git(main, ['branch', 'b4m/recorded']);

    expect(await resolveWorkspace(main, { base: 'main', branch: 'b4m/recorded' })).toEqual({
      workingDirectory: join(root, 'b4m+recorded'),
      branch: 'b4m/recorded',
      outcome: 'created',
    });
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
  it('names what a worktree at that path actually holds, and points at git worktree move', async () => {
    const occupied = await resolveWorkspace(main, { branch: 'agent/one' });
    await git(occupied.workingDirectory, ['checkout', '--quiet', '-b', 'fix/one']);

    const onBranch = await resolveWorkspace(main, { branch: 'agent/one' }).catch((err: Error) => err.message);
    expect(onBranch).toMatch(/is a git worktree holding the branch fix\/one/);
    expect(onBranch).toMatch(/git worktree move/);
    expect(onBranch).not.toMatch(/is not a git worktree/);

    await git(occupied.workingDirectory, ['checkout', '--quiet', '--detach', 'HEAD']);
    await expect(resolveWorkspace(main, { branch: 'agent/one' })).rejects.toThrow(/holding a detached HEAD/);
  });

  /**
   * Runs the real `worktree add`, then fails it the way a timeout kill does after it made things:
   * the registration is left locked "initializing", which a plain --force does not get past.
   */
  function failWorktreeAddAfterIt() {
    const originalGit = projectGit.git;
    const timeouts: (number | undefined)[] = [];
    const spy = vi.spyOn(projectGit, 'git').mockImplementation(async (directory, args, options) => {
      if (args[0] !== 'worktree' || args[1] !== 'add') return originalGit(directory, args, options);
      timeouts.push(options?.timeoutMs);
      await originalGit(directory, args, options);
      await originalGit(directory, ['worktree', 'lock', '--reason', 'initializing', args[args.length - 2]]);
      throw new projectGit.GitError(args, 'Updating files:  4% (616/15405)\r', options?.timeoutMs);
    });
    return { spy, timeouts };
  }

  // Each leftover alone would make the next attempt at the same branch fail.
  it('leaves no folder, registration or branch behind when a new worktree fails', async () => {
    const path = join(root, worktreeFolderName('agent/slow'));
    const { spy, timeouts } = failWorktreeAddAfterIt();
    let failure: unknown;
    try {
      failure = await resolveWorkspace(main, { base: 'main', branch: 'agent/slow' }).catch((err: unknown) => err);
    } finally {
      spy.mockRestore();
    }

    expect(timeouts, 'worktree add gets its own long timeout').toEqual([projectGit.WORKTREE_ADD_TIMEOUT_MS]);
    expect((failure as Error).message).toBe('git worktree add timed out after 5 min.');
    await expect(stat(path)).rejects.toThrow();
    expect((await listWorktrees(main)).some(entry => entry.branch === 'agent/slow')).toBe(false);
    expect(await branchExists(main, 'agent/slow')).toBe(false);

    expect(await resolveWorkspace(main, { base: 'main', branch: 'agent/slow' })).toEqual({
      workingDirectory: path,
      branch: 'agent/slow',
      outcome: 'created',
    });
  });

  it('keeps a branch it did not create when checking it out fails', async () => {
    await git(main, ['branch', 'feat/kept']);
    const { spy } = failWorktreeAddAfterIt();
    try {
      await resolveWorkspace(main, { branch: 'feat/kept' }).catch(() => undefined);
    } finally {
      spy.mockRestore();
    }

    expect(await branchExists(main, 'feat/kept')).toBe(true);
    await expect(stat(join(root, worktreeFolderName('feat/kept')))).rejects.toThrow();
  });

  it('cleans up nothing when git refuses because another writer made the path first', async () => {
    const path = join(root, worktreeFolderName('agent/race'));
    const originalGit = projectGit.git;
    const spy = vi.spyOn(projectGit, 'git').mockImplementation(async (directory, args, options) => {
      if (args[0] !== 'worktree' || args[1] !== 'add') return originalGit(directory, args, options);
      // The other writer lands between our checks and this add.
      await originalGit(directory, ['worktree', 'add', '--quiet', '-b', 'agent/race', path, 'main']);
      await writeFile(join(path, 'theirs.txt'), 'theirs');
      throw new projectGit.GitError(args, `fatal: a branch named 'agent/race' already exists`);
    });
    try {
      await expect(resolveWorkspace(main, { base: 'main', branch: 'agent/race' })).rejects.toThrow(/already exists/);
    } finally {
      spy.mockRestore();
    }

    expect(await readFile(join(path, 'theirs.txt'), 'utf8')).toBe('theirs');
    expect(await branchExists(main, 'agent/race')).toBe(true);
    expect((await listWorktrees(main)).some(entry => entry.branch === 'agent/race')).toBe(true);
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

  /**
   * With core.bare=false in the shared config git lists the bare repo like a checkout, branch
   * line included, and it comes first - the shape that rooted sessions in <container>/.bare.
   */
  it('never lists or cuts into the bare repo when git lists it as a checkout', async () => {
    await git(join(container, '.bare'), ['config', 'core.bare', 'false']);

    expect((await listWorktrees(main)).map(entry => entry.path)).toEqual([main]);
    const resolved = await resolveWorkspace(main, { base: 'main' });
    expect(resolved.workingDirectory).toBe(join(root, worktreeFolderName(resolved.branch)));
    expect(resolved.outcome).toBe('created');
  });
});

/**
 * A long-lived local `main` drifts hundreds of commits behind origin/main without anyone
 * noticing, and a branch cut from it starts life needing a merge nobody asked for.
 *
 * An ordinary clone rather than the layout above: `clone --bare` writes no refs/remotes, so the
 * bare fixture has no origin/main to prefer and could not tell the two answers apart.
 *
 * Built once: local main has diverged from origin (it lacks `upstream`, which origin has, and
 * holds `local`, which origin lacks) and its origin/main is stale at the first commit, so the
 * upstream answer can only come from a fetch. feat/local exists only here; feat/pushed is pushed
 * with one more commit on top.
 */
describe('resolveWorkspace choosing what to fork from', () => {
  const clonedRoot = gitFixture(
    'b4m-clone-',
    async root => {
      const origin = join(root, 'origin.git');
      await mkdir(origin, { recursive: true });
      await git(origin, ['init', '--bare', '--initial-branch=main', '--quiet']);

      const repo = join(root, 'repo');
      await git(root, ['clone', '--quiet', origin, repo]);
      await git(repo, ['config', 'user.email', 'test@example.com']);
      await git(repo, ['config', 'user.name', 'Test']);
      const initial = await commitOn(repo, 'README.md');
      await git(repo, ['push', '--quiet', '-u', 'origin', 'main']);
      await commitOn(repo, 'upstream.txt');
      await git(repo, ['push', '--quiet', 'origin', 'main']);
      await git(repo, ['reset', '--quiet', '--hard', initial]);
      await git(repo, ['update-ref', 'refs/remotes/origin/main', initial]);

      await git(repo, ['switch', '--quiet', '-c', 'feat/local']);
      await commitOn(repo, 'feature.txt');
      await git(repo, ['switch', '--quiet', '-c', 'feat/pushed', initial]);
      await commitOn(repo, 'pushed.txt');
      await git(repo, ['push', '--quiet', 'origin', 'feat/pushed']);
      await commitOn(repo, 'unpushed.txt');
      await git(repo, ['switch', '--quiet', 'main']);
      await commitOn(repo, 'local.txt');
    },
    ['repo/.git/config']
  );

  // Built here so the one-time cost is not charged to whichever test happens to run first.
  beforeAll(async () => {
    await clonedRoot();
  });

  async function clonedRepository(): Promise<{ repo: string; origin: string }> {
    const root = await clonedRoot();
    return { repo: join(root, 'repo'), origin: join(root, 'origin.git') };
  }

  async function commitOn(repo: string, file: string): Promise<string> {
    await writeFile(join(repo, file), `${file}\n`, 'utf8');
    await git(repo, ['add', file]);
    await git(repo, ['commit', '--quiet', '-m', file]);
    return headOf(repo);
  }

  const headOf = async (directory: string, ref = 'HEAD') => (await git(directory, ['rev-parse', ref])).trim();
  const goOffline = (repo: string) => git(repo, ['remote', 'set-url', 'origin', join(repo, 'offline')]);

  it('forks from upstream when local main has diverged, leaving local main intact', async () => {
    const { repo, origin } = await clonedRepository();
    const local = await headOf(repo);

    const resolved = await resolveWorkspace(repo, { base: 'main', branch: 'agent/clean' });

    expect(await headOf(resolved.workingDirectory)).toBe(await headOf(origin, 'main'));
    expect(await headOf(repo)).toBe(local);
  });

  it('retries a failed prefetch immediately instead of marking it fresh', async () => {
    const { repo, origin } = await clonedRepository();
    await goOffline(repo);
    await fetchRemoteFor(repo, 'origin/main');
    await git(repo, ['remote', 'set-url', 'origin', origin]);
    const first = fetchRemoteFor(repo, 'origin/main');
    expect(fetchRemoteFor(repo, 'origin/main')).toBe(first);
    await first;
    expect(fetchRemoteFor(repo, 'origin/main')).toBe(first);
    expect(await headOf(repo, 'origin/main')).toBe(await headOf(origin, 'main'));
  });

  it.each(['main', 'origin/main', ''])('refuses a stale %s base when upstream fetch fails', async base => {
    const { repo } = await clonedRepository();
    const local = await headOf(repo);
    await goOffline(repo);
    await fetchRemoteFor(repo, 'origin/main');

    await expect(resolveWorkspace(repo, { base, branch: 'agent/refused' })).rejects.toThrow(
      /Could not update origin\/main.*pick another base branch/s
    );

    expect(await headOf(repo)).toBe(local);
    expect(await branchExists(repo, 'agent/refused')).toBe(false);
  });

  it('does not default to local main when its tracking ref is missing and origin is offline', async () => {
    const { repo } = await clonedRepository();
    await git(repo, ['update-ref', '-d', 'refs/remotes/origin/main']);
    await goOffline(repo);

    await expect(resolveWorkspace(repo, { branch: 'agent/refused' })).rejects.toThrow(/Could not update origin\/main/);

    expect(await branchExists(repo, 'agent/refused')).toBe(false);
  });

  /**
   * git-common-dir is <repo>/.git in an ordinary clone, so the container IS the repository. Under
   * the old flat layout every app worktree was therefore an untracked sibling in the repo root.
   */
  it('uses local main when there is no origin, nesting the worktree in the app own ignored directory', async () => {
    const { repo } = await clonedRepository();
    await git(repo, ['remote', 'remove', 'origin']);

    const resolved = await resolveWorkspace(repo, { base: 'main' });

    expect(await headOf(resolved.workingDirectory)).toBe(await headOf(repo));
    expect(resolved.workingDirectory).toBe(join(appWorktreeRoot(repo), worktreeFolderName(resolved.branch)));
    expect(await readFile(join(repo, '.b4m', '.gitignore'), 'utf8')).toBe('*\n');
    expect((await git(repo, ['status', '--porcelain'])).trim(), 'the app directory is ignored').toBe('');
    await expect(stat(join(repo, '.gitignore')), 'the repo gitignore is untouched').rejects.toThrow();
  });

  // A spawned session names its branch AND its base: the branch the user approved, cut from the
  // branch its parent is on. Offline and local-only take the same fallback to the local ref.
  it('keeps an explicit feature base usable while origin is offline', async () => {
    const { repo } = await clonedRepository();
    await goOffline(repo);

    const resolved = await resolveWorkspace(repo, { base: 'feat/local', branch: 'agent/feature' });

    expect(resolved.branch).toBe('agent/feature');
    expect(await headOf(resolved.workingDirectory)).toBe(await headOf(repo, 'feat/local'));
  });

  it('cuts a named branch from the local base when its remote has not seen the latest commits', async () => {
    const { repo } = await clonedRepository();

    const resolved = await resolveWorkspace(repo, { branch: 'agent/child', base: 'feat/pushed' });

    expect(await headOf(resolved.workingDirectory)).toBe(await headOf(repo, 'feat/pushed'));
  });

  it('cuts a named branch from HEAD as it is', async () => {
    const { repo } = await clonedRepository();

    const local = await resolveWorkspace(repo, { branch: 'agent/head', base: 'HEAD' });

    expect(await headOf(local.workingDirectory)).toBe(await headOf(repo));
  });

  it("still cuts a user's session with no branch picked from origin/main, whatever is checked out", async () => {
    const { repo, origin } = await clonedRepository();
    await git(repo, ['switch', '--quiet', 'feat/local']);

    const resolved = await resolveWorkspace(repo, { name: 'My session' });

    expect(await headOf(resolved.workingDirectory)).toBe(await headOf(origin, 'main'));
  });
});

describe('SpareWorktrees', () => {
  const spareAt = (container: string) => join(container, '.b4m', 'spare');
  const spareListed = async (main: string, container: string) =>
    (await listWorktrees(main)).some(entry => entry.path === spareAt(container));

  /** Reads the marker through the spare's gitlink rather than asking git, so polling spawns nothing. */
  async function spareReady(container: string): Promise<void> {
    await vi.waitUntil(
      async () => {
        try {
          const link = await readFile(join(spareAt(container), '.git'), 'utf8');
          const marker = join(link.replace(/^gitdir: /, '').trim(), 'b4m-spare');
          return (await readFile(marker, 'utf8')).startsWith('bike4mind-spare:');
        } catch {
          return false;
        }
      },
      { timeout: 10000, interval: 10 }
    );
  }

  /** Lets a 0ms refill start; dispose waits for any fill already under way. */
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));

  it('hands a ready spare to the next session on its own branch, then asks for another', async () => {
    const { container, main } = await bareLayoutRepository();
    const spares = new SpareWorktrees(0);
    try {
      spares.refill(main, container, 'HEAD');
      await spareReady(container);
      const refill = vi.spyOn(spares, 'refill').mockImplementation(() => undefined);
      await writeFile(join(main, 'later.txt'), 'later\n', 'utf8');
      await git(main, ['add', 'later.txt']);
      await git(main, ['commit', '--quiet', '-m', 'later']);
      const tip = (await git(main, ['rev-parse', 'HEAD'])).trim();

      const timer = new PhaseTimer();
      const second = await resolveWorkspace(main, { base: 'main', branch: 'b4m/second', spares, timer });

      expect(timer.summary()).toContain('spareSwitch=');
      expect(second.workingDirectory).toBe(join(appWorktreeRoot(container), 'b4m+second'));
      expect((await git(second.workingDirectory, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('b4m/second');
      expect((await git(second.workingDirectory, ['rev-parse', 'HEAD'])).trim()).toBe(
        (await git(main, ['rev-parse', 'origin/main'])).trim()
      );
      expect((await git(main, ['rev-parse', 'HEAD'])).trim(), 'main stays at its own commit').toBe(tip);
      await expect(stat(join(second.workingDirectory, 'later.txt'))).rejects.toThrow();
      expect(refill, 'the cut renews the spare for the session after this one').toHaveBeenCalledWith(
        main,
        container,
        'origin/main'
      );
    } finally {
      await spares.dispose();
    }
  });

  it('removes its ready spare on dispose', async () => {
    const { container, main } = await bareLayoutRepository();
    const spares = new SpareWorktrees(0);
    spares.refill(main, container, 'HEAD');
    await spareReady(container);

    await spares.dispose();

    expect(await spareListed(main, container)).toBe(false);
  });

  it('preserves an unowned detached worktree where the spare would go', async () => {
    const { container, main } = await bareLayoutRepository();
    await mkdir(join(container, '.b4m'), { recursive: true });
    await git(main, ['worktree', 'add', '--quiet', '--detach', spareAt(container), 'HEAD']);
    const spares = new SpareWorktrees(0);
    try {
      spares.refill(main, container, 'HEAD');
      await tick();
    } finally {
      await spares.dispose();
    }
    expect(await readFile(join(spareAt(container), 'README.md'), 'utf8')).toBe('hello\n');
    expect(await spareListed(main, container)).toBe(true);
  });

  it('leaves a folder it did not make where the spare would go, and so has none to hand out', async () => {
    const { container, main } = await bareLayoutRepository();
    await mkdir(spareAt(container), { recursive: true });
    await writeFile(join(spareAt(container), 'mine.txt'), 'keep\n', 'utf8');
    const spares = new SpareWorktrees(0);
    try {
      spares.refill(main, container, 'HEAD');
      await tick();
      const path = join(appWorktreeRoot(container), 'b4m+two');
      expect(await spares.take(main, container, 'b4m/two', path, 'HEAD')).toBe(false);
      expect(await readFile(join(spareAt(container), 'mine.txt'), 'utf8')).toBe('keep\n');
    } finally {
      await spares.dispose();
    }
  });

  /** Each case is a separate guard in removeWorktree: owned-and-unmoved HEAD, untracked, ignored. */
  it.each([
    [
      'untracked edits',
      async (_main: string, spare: string) => {
        await writeFile(join(spare, 'mine.txt'), 'keep\n');
      },
    ],
    [
      'a commit on its detached HEAD',
      async (_main: string, spare: string) => {
        await writeFile(join(spare, 'mine.txt'), 'keep\n');
        await git(spare, ['add', 'mine.txt']);
        await git(spare, ['commit', '--quiet', '-m', 'keep detached work']);
        expect((await git(spare, ['status', '--porcelain'])).trim()).toBe('');
      },
    ],
    [
      'ignored files',
      async (main: string, spare: string) => {
        await git(main, ['config', 'core.excludesFile', join(spare, '..', 'ignore')]);
        await writeFile(join(spare, '..', 'ignore'), 'mine.txt\n');
        await writeFile(join(spare, 'mine.txt'), 'keep\n');
      },
    ],
  ])('does not delete %s in its own spare on cleanup', async (_case, change) => {
    const { container, main } = await bareLayoutRepository();
    const spares = new SpareWorktrees(0);
    spares.refill(main, container, 'HEAD');
    await spareReady(container);
    await change(main, spareAt(container));
    await spares.dispose();
    expect(await readFile(join(spareAt(container), 'mine.txt'), 'utf8')).toBe('keep\n');
  });

  it('cancels a scheduled refill when the project is forgotten', async () => {
    const { container, main } = await bareLayoutRepository();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const spares = new SpareWorktrees(60_000);
    try {
      spares.refill(main, container, 'HEAD');
      expect(vi.getTimerCount()).toBe(1);
      await spares.forget(main);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      await spares.dispose();
    }
  });

  it('makes none once disposed', async () => {
    const { container, main } = await bareLayoutRepository();
    const spares = new SpareWorktrees(0);
    await spares.dispose();

    spares.refill(main, container, 'HEAD');
    await tick();
    await spares.dispose();

    expect(await spareListed(main, container)).toBe(false);
  });

  it.each(['forget', 'dispose'] as const)('cancels an in-flight refill on %s', async action => {
    const { container, main } = await bareLayoutRepository();
    const spares = new SpareWorktrees(0);
    const originalGit = projectGit.git;
    let releaseCheckout!: () => void;
    const paused = new Promise<void>(resolve => {
      releaseCheckout = resolve;
    });
    let announceCheckout!: () => void;
    const started = new Promise<void>(resolve => {
      announceCheckout = resolve;
    });
    const spy = vi.spyOn(projectGit, 'git').mockImplementation(async (directory, args) => {
      if (args.includes('--detach') && args.includes(spareAt(container))) {
        announceCheckout();
        await paused;
      }
      return originalGit(directory, args);
    });
    try {
      spares.refill(main, container, 'HEAD');
      await started;
      const stopped = action === 'forget' ? spares.forget(main) : spares.dispose();
      releaseCheckout();
      await stopped;
      expect(await spareListed(main, container)).toBe(false);
    } finally {
      releaseCheckout();
      await spares.dispose();
      spy.mockRestore();
    }
  });
});

describe('unusedBranchName', () => {
  let container: string;
  let main: string;

  // Each test asks about its own names, so one repository serves them all.
  beforeAll(async () => {
    ({ container, main } = await bareLayoutRepository());
  });

  /** The name it answers, given back straight away. */
  async function pick(wanted: string): Promise<string> {
    const { branch, reservation } = await unusedBranchName(main, wanted);
    if (reservation) releaseBranchName(reservation);
    return branch;
  }

  it('answers the name itself when nothing holds it', async () => {
    expect(await pick('agent/free')).toBe('agent/free');
  });

  it('steps past a leftover branch and a branch held by a worktree', async () => {
    await git(main, ['branch', 'agent/review']);
    await git(main, ['worktree', 'add', '--quiet', '-b', 'agent/review-2', join(container, 'review-2')]);

    expect(await pick('agent/review')).toBe('agent/review-3');
  });

  it('gives two calls made together two names, and frees a name once it is released', async () => {
    const [first, second] = await Promise.all([
      unusedBranchName(main, 'agent/twin'),
      unusedBranchName(main, 'agent/twin'),
    ]);
    expect(new Set([first.branch, second.branch])).toEqual(new Set(['agent/twin', 'agent/twin-2']));

    const holderOfTwin = first.branch === 'agent/twin' ? first : second;
    releaseBranchName(holderOfTwin.reservation!);
    expect(await pick('agent/twin')).toBe('agent/twin');
    releaseBranchName((holderOfTwin === first ? second : first).reservation!);
  });

  it('steps past a name another spawn reserved by hand, as a card does', async () => {
    const card = reserveBranchName(main, 'agent/typed');

    expect(await pick('agent/typed')).toBe('agent/typed-2');
    releaseBranchName(card!);
  });

  it('answers the wanted name with no reservation when the directory is not a repository', async () => {
    expect(await unusedBranchName(await plainFolder(), 'agent/plain')).toEqual({
      branch: 'agent/plain',
      reservation: null,
    });
  });

  it('answers the wanted name with no reservation when every candidate is taken', async () => {
    const held = [reserveBranchName(main, 'agent/full')];
    for (let attempt = 2; attempt <= 20; attempt++) held.push(reserveBranchName(main, `agent/full-${attempt}`));

    expect(await unusedBranchName(main, 'agent/full')).toEqual({ branch: 'agent/full', reservation: null });
    for (const reservation of held) releaseBranchName(reservation!);
  });
});

describe('reserveBranchName', () => {
  // Reservations are in-memory and keyed on the directory string; no repository is read.
  const directory = '/b4m-reserve-test';

  it('refuses a name already held, until its holder gives it back', () => {
    const held = reserveBranchName(directory, 'agent/one');

    expect(held).not.toBeNull();
    expect(reserveBranchName(directory, 'agent/one')).toBeNull();
    releaseBranchName(held!);
    const again = reserveBranchName(directory, 'agent/one');
    expect(again).not.toBeNull();
    releaseBranchName(again!);
  });

  it('lets only the holder release a name, so a stale reservation frees nothing', () => {
    const first = reserveBranchName(directory, 'agent/one')!;
    releaseBranchName(first);
    const second = reserveBranchName(directory, 'agent/one')!;

    releaseBranchName(first);
    expect(reserveBranchName(directory, 'agent/one')).toBeNull();
    releaseBranchName(second);
  });
});

describe('appWorktreeMainCheckout', () => {
  async function repository(): Promise<string> {
    const repo = await plainFolder();
    await git(repo, ['init', '-q', '-b', 'main']);
    await writeFile(join(repo, 'README.md'), 'x');
    await git(repo, ['add', '.']);
    await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init']);
    return repo;
  }

  it('names the main checkout of a worktree inside its app root, and refuses one made anywhere else', async () => {
    const repo = await repository();
    const worktree = join(appWorktreeRoot(repo), 'task');
    await git(repo, ['worktree', 'add', '-q', '-b', 'task', worktree]);
    expect(await appWorktreeMainCheckout(worktree, mainCheckoutOf)).toBe(repo);

    const elsewhere = join(await plainFolder(), 'task');
    await git(repo, ['worktree', 'add', '-q', '-b', 'elsewhere', elsewhere]);
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
