import { randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ChatProject } from '@shared/chat';
import type {
  AppWorktree,
  WorkspaceOwner,
  WorktreeRemoval,
  WorktreeState,
  WorktreeSweepItem,
} from '@shared/worktreeRemoval';
import type { PhaseTimer } from '../PhaseTimer';
import { slugify } from './branchName';
import type { WorktreeEntry } from './git';
import {
  branchExists,
  containerDirectory,
  currentBranch,
  fetchRemoteFor,
  git,
  listWorktrees,
  resolveBaseRef,
} from './git';

/**
 * A branch's folder name under the app's worktree root.
 *
 * '/' becomes '+' so `fix/some-branch` is one directory entry rather than a nested pair, which
 * is the convention in the user's ~/.config/b4m/worktree.zsh.
 *
 * Nothing predicts a path from this any more, and nothing should: the branch a session runs on
 * is cut here, with a random suffix, so the only truthful answer before resolution is that
 * there is not one yet. The UI names the worktree from `project.workingDirectory` once it has
 * been resolved - see WorkingDirectoryLine and the worktree chip's tooltip.
 */
export function worktreeFolderName(branch: string): string {
  return branch.replaceAll('/', '+');
}

/** The app's own folder in a project container, beside `.claude` and `.manifold`. */
const APP_DIRECTORY = '.b4m';

/** Namespaces the branches this app cuts, so they read as such in `git branch`. */
const BRANCH_PREFIX = 'b4m/';

/** Three bytes of hex: short enough to read, wide enough that two sessions do not collide. */
const SUFFIX_BYTES = 3;

export type WorkspaceOutcome = 'created' | 'reused';

/**
 * What a session asks for when it wants somewhere isolated to run.
 *
 * `base` and `branch` are two different things and the split is the whole point: `base` is
 * what the user picked in the chip menu, and the session gets a branch of its OWN cut from it.
 * `branch` is that own branch once it exists, handed back on every later resolution so the
 * session lands in the worktree it already has rather than cutting another.
 */
export interface WorkspaceRequest {
  /** The branch the user picked. Empty when they picked none. */
  base?: string;
  /**
   * This session's own branch, when it has one. Set, nothing is derived. It is cut only when it
   * does not exist yet - from `base` when one is given, which a spawned session's worktree uses
   * to start from its parent's branch, and otherwise from the default base.
   */
  branch?: string;
  /** Seed for a derived branch name - the session's title. */
  name?: string;
  /** Told the branch as soon as it is decided, ahead of the fetch and checkout that take the time. */
  onBranch?: (branch: string) => void;
  timer?: PhaseTimer;
  /** Cut from the repository's spare when it has one, and renew it afterwards. */
  spares?: SpareWorktrees;
}

export interface WorkspaceResolution {
  /** Where the session's tools will run. */
  workingDirectory: string;
  /**
   * The branch checked out there, which is NOT the base it was cut from. Persist it on the
   * session: handing it back is what makes the next resolution reuse this worktree.
   */
  branch: string;
  outcome: WorkspaceOutcome;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The registered worktree sitting at `path`, if any.
 *
 * Both sides go through realpath first: git reports resolved paths, while `path` is built by
 * join from whatever the user picked, so /var vs /private/var and a differently-cased parent
 * folder would each defeat a plain string compare on macOS.
 */
async function registeredAt(entries: readonly WorktreeEntry[], path: string): Promise<WorktreeEntry | null> {
  const wanted = await canonical(path);
  if (!wanted) return null;
  for (const entry of entries) {
    if ((await canonical(entry.path)) === wanted) return entry;
  }
  return null;
}

async function canonical(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/**
 * Where this app's worktrees live: `<container>/.b4m/worktrees`, its own folder rather than the
 * container itself.
 *
 * Beside `.claude/worktrees` and `.manifold/worktrees`, which already solve this in the same
 * containers. Two things made the flat layout wrong. It collided with the user's own folders -
 * choosing `main` resolved to `<container>/main`, their primary checkout - and on an ordinary
 * clone `containerDirectory` is the REPOSITORY, so every worktree became an untracked sibling
 * in the repo root. Nothing the app creates now shares a parent with anything it did not.
 */
export function appWorktreeRoot(container: string): string {
  return join(container, APP_DIRECTORY, 'worktrees');
}

/**
 * Make the root, and keep it out of the user's index.
 *
 * On an ordinary clone this directory sits inside a tracked working tree, so without the
 * ignore every app worktree shows up as untracked noise in `git status`. The '*' file ignores
 * the folder it is in and is written INSIDE the app's own directory - the repository's own
 * .gitignore is the user's file and is never touched.
 */
async function ensureWorktreeRoot(container: string): Promise<void> {
  await mkdir(appWorktreeRoot(container), { recursive: true });
  const ignore = join(container, APP_DIRECTORY, '.gitignore');
  try {
    await stat(ignore);
  } catch {
    await writeFile(ignore, '*\n', 'utf8');
  }
}

/**
 * The branch a session cuts for itself.
 *
 * The random suffix carries the uniqueness, not the title: titles are generated, repeat across
 * conversations, and two sessions started from the same base would otherwise ask for the same
 * branch - which is refused rather than resolved, leaving the user a dead end to edit their way
 * out of. 'session' covers a conversation that has not been named yet.
 */
export function sessionBranchName(name?: string): string {
  const slug = slugify(name ?? '') || 'session';
  return `${BRANCH_PREFIX}${slug}-${randomBytes(SUFFIX_BYTES).toString('hex')}`;
}

/**
 * What to cut a new branch from, given the branch the user picked.
 *
 * Main-based tasks use verified upstream history, never local-only main commits. Local main
 * stays untouched. Explicit feature bases retain unpushed work and best-effort offline fetches.
 */
async function baseRefFor(directory: string, base: string): Promise<string> {
  const selected = base || (await resolveBaseRef(directory));
  const defaultMain = !base && selected === 'HEAD' && (await currentBranch(directory)) === 'main';
  if (selected === 'main' || selected === 'origin/main' || defaultMain) {
    const remotes = (await git(directory, ['remote'])).trim().split('\n');
    if (remotes.includes('origin')) {
      try {
        await fetchRemoteFor(directory, 'origin/main', true);
      } catch (err) {
        // The app's sandboxed git can fail where the user's terminal git works (repo-scoped
        // credential helpers and ssh commands are dropped, see hostGitArgs.ts), so name the fix.
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Could not update origin/main, so this session cannot start from upstream main: ${reason}. ` +
            'Check network access and credentials for this repository, or pick another base branch.'
        );
      }
      await git(directory, ['rev-parse', '--verify', '--quiet', 'origin/main^{commit}']);
      return 'origin/main';
    }
  }
  if (!base || base === 'HEAD') {
    const fallback = selected;
    await fetchRemoteFor(directory, fallback);
    return fallback;
  }
  const remote = remoteRefFor(base);
  try {
    await fetchRemoteFor(directory, remote);
    await git(directory, ['rev-parse', '--verify', '--quiet', `${remote}^{commit}`]);
    await git(directory, ['merge-base', '--is-ancestor', base, remote]);
    return remote;
  } catch {
    return base;
  }
}

function remoteRefFor(base: string): string {
  return `origin/${base}`;
}

/**
 * Start the fetch a branch cut from `base` will wait on, without waiting for it: the same ref
 * baseRefFor fetches, so the cut finds it fresh (see fetchRemoteFor). Called where a start is
 * about to be asked for - a spawn card drawn, a worktree toggle turned on.
 */
export function prefetchBase(directory: string, base: string): void {
  const target = !base || base === 'HEAD' ? (base ? Promise.resolve(base) : resolveBaseRef(directory)) : null;
  void (target ?? Promise.resolve(remoteRefFor(base)))
    .then(ref => fetchRemoteFor(directory, ref))
    .catch(() => undefined);
}

/** Where a repository's spare checkout waits: in the app's folder, beside the worktree root. */
function sparePath(container: string): string {
  return join(container, APP_DIRECTORY, 'spare');
}

/** Repositories that keep a spare at once; the least recently used one goes past this. */
const MAX_SPARES = 2;

/** A spare unused this long is removed, so a project left alone stops costing a checkout. */
const SPARE_IDLE_MS = 30 * 60_000;

/** After a cut, so the refill's checkout does not compete with the new session's first moments. */
const SPARE_REFILL_DELAY_MS = 10_000;

interface Spare {
  projectDirectory: string;
  path: string;
  idle: NodeJS.Timeout;
}

/**
 * One detached checkout kept ready per recently used repository, so cutting a session's
 * worktree is a rename plus a switch that rewrites only the files that differ, rather than a
 * checkout of every file - about 1.3s down to 0.2s on this monorepo.
 *
 * Bounded on every side: a repository gets one only after a worktree was cut in it this run,
 * at most MAX_SPARES exist, each goes after SPARE_IDLE_MS unused, and `dispose` removes them
 * all on quit. A spare left after a crash is recognised by its git metadata and original HEAD.
 * Changed or unowned checkouts are left alone, and the spare is simply not made.
 */
export class SpareWorktrees {
  /** By container, in order of last use. */
  private readonly ready = new Map<string, Spare>();
  private readonly refills = new Map<string, NodeJS.Timeout>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly generations = new Map<string, number>();
  private disposed = false;

  constructor(private readonly refillDelayMs = SPARE_REFILL_DELAY_MS) {}

  /**
   * Move this repository's spare to `path` on a new `branch` cut from `from`. False when there is
   * none or it could not be used, and then nothing is left at `path`.
   */
  async take(projectDirectory: string, container: string, branch: string, path: string, from: string) {
    // A fill already under way finishes sooner than a fresh checkout would.
    if (!this.ready.has(container)) await this.chains.get(container);
    const spare = this.ready.get(container);
    if (!spare) return false;
    this.ready.delete(container);
    clearTimeout(spare.idle);
    return this.serial(container, async () => {
      if (!(await isOwnedSpare(spare.path)) || !(await cleanDetachedWorktree(spare.path))) return false;
      try {
        await git(projectDirectory, ['worktree', 'move', spare.path, path]);
      } catch {
        await removeWorktree(projectDirectory, spare.path);
        return false;
      }
      try {
        await git(path, ['switch', '--quiet', '--no-track', '-c', branch, from]);
        return true;
      } catch {
        await removeWorktree(projectDirectory, path);
        return false;
      }
    });
  }

  /** Make or renew this repository's spare at `from`, shortly; a no-op once disposed. */
  refill(projectDirectory: string, container: string, from: string): void {
    if (this.disposed) return;
    clearTimeout(this.refills.get(container));
    const generation = this.generations.get(container) ?? 0;
    const timer = setTimeout(() => {
      this.refills.delete(container);
      void this.serial(container, () => this.fill(projectDirectory, container, from, generation));
    }, this.refillDelayMs);
    timer.unref();
    this.refills.set(container, timer);
  }

  /** Drop the spare of the repository at `projectDirectory`, if it has one. */
  async forget(projectDirectory: string): Promise<void> {
    const container = await containerDirectory(projectDirectory).catch(() => null);
    if (!container) return;
    clearTimeout(this.refills.get(container));
    this.refills.delete(container);
    this.generations.set(container, (this.generations.get(container) ?? 0) + 1);
    await this.chains.get(container);
    await this.discard(container);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const timer of this.refills.values()) clearTimeout(timer);
    this.refills.clear();
    await Promise.all([...this.ready.keys()].map(container => this.discard(container)));
    // A fill still running sees `disposed` and removes its own checkout; quit waits for that.
    await Promise.all(this.chains.values());
  }

  private async fill(projectDirectory: string, container: string, from: string, generation: number): Promise<void> {
    const cancelled = () => this.disposed || generation !== (this.generations.get(container) ?? 0);
    if (cancelled() || this.ready.has(container)) return;
    const path = sparePath(container);
    const occupant = await registeredAt(await listWorktrees(projectDirectory), path);
    if (occupant) {
      if (occupant.branch || !(await isOwnedSpare(path))) return;
      await removeWorktree(projectDirectory, path);
    } else if (await directoryExists(path)) {
      return;
    }
    try {
      const head = (await git(projectDirectory, ['rev-parse', '--verify', `${from}^{commit}`])).trim();
      await git(projectDirectory, ['worktree', 'add', '--quiet', '--detach', path, head]);
      const gitDirectory = (await git(path, ['rev-parse', '--absolute-git-dir'])).trim();
      await writeFile(join(gitDirectory, 'b4m-spare'), `bike4mind-spare:${head}\n`, 'utf8');
    } catch {
      return;
    }
    if (cancelled()) {
      await removeWorktree(projectDirectory, path);
      return;
    }
    const idle = setTimeout(() => void this.discard(container), SPARE_IDLE_MS);
    idle.unref();
    this.ready.set(container, { projectDirectory, path, idle });
    for (const oldest of [...this.ready.keys()].slice(0, Math.max(0, this.ready.size - MAX_SPARES))) {
      void this.discard(oldest);
    }
  }

  private discard(container: string): Promise<void> {
    const spare = this.ready.get(container);
    if (!spare) return Promise.resolve();
    this.ready.delete(container);
    clearTimeout(spare.idle);
    return this.serial(container, () => removeWorktree(spare.projectDirectory, spare.path));
  }

  /** One git operation at a time per repository, so a take never meets a fill half-done. */
  private serial<T>(container: string, work: () => Promise<T>): Promise<T> {
    const result = (this.chains.get(container) ?? Promise.resolve()).then(work);
    const tail = result.catch(() => undefined);
    this.chains.set(container, tail);
    void tail.then(() => {
      if (this.chains.get(container) === tail) this.chains.delete(container);
    });
    return result;
  }
}

async function isOwnedSpare(path: string): Promise<boolean> {
  try {
    const gitDirectory = (await git(path, ['rev-parse', '--absolute-git-dir'])).trim();
    const head = (await git(path, ['rev-parse', 'HEAD'])).trim();
    return (await readFile(join(gitDirectory, 'b4m-spare'), 'utf8')) === `bike4mind-spare:${head}\n`;
  } catch {
    return false;
  }
}

async function cleanDetachedWorktree(path: string): Promise<boolean> {
  try {
    return (
      (await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() === 'HEAD' &&
      (await git(path, ['status', '--porcelain', '--untracked-files=normal', '--ignored=matching'])).trim() === ''
    );
  } catch {
    return false;
  }
}

/** Refuse changed checkouts, including a spare someone has started using after a crash. */
async function removeWorktree(projectDirectory: string, path: string): Promise<void> {
  try {
    if (!(await isOwnedSpare(path)) || !(await cleanDetachedWorktree(path))) return;
    await git(projectDirectory, ['worktree', 'remove', path]);
  } catch {
    // Already gone, or held open; see above.
  }
}

type InspectedWorktreeRemoval = WorktreeRemoval & { preservedRef?: string };

type Inspection = { removal: InspectedWorktreeRemoval; state: WorktreeState };

function containsPath(directory: string, path: string): boolean {
  const within = relative(directory, path);
  return !isAbsolute(within) && within !== '..' && !within.startsWith(`..${sep}`);
}

/** Only a branch this app cut can have a removable worktree; a cheap gate before any sharing scan. */
export function hasAppWorkspaceBranch(
  project: ChatProject | undefined
): project is ChatProject & { workspaceBranch: string } {
  return !!project?.workspaceBranch?.startsWith(BRANCH_PREFIX);
}

/** The first conversation that uses this checkout, including folders granted as context. */
async function ownerOf(
  path: string,
  branch: string,
  container: string,
  projects: readonly (ChatProject | undefined)[],
  options: OrphanListOptions = {}
): Promise<string | null> {
  for (const owner of options.owners ?? []) {
    for (const directory of owner.directories) {
      const ownerPath = (await canonical(directory)) ?? resolve(directory);
      if (containsPath(path, ownerPath)) return owner.title;
    }
  }
  const allProjects = new Set([...projects, ...(options.owners ?? []).map(owner => owner.project)]);
  for (const other of allProjects) {
    if (!other) continue;
    const title =
      options.titles?.get(other) ??
      options.owners?.find(owner => owner.project === other)?.title ??
      'Another conversation';
    for (const directory of [other.workingDirectory, other.directory, ...other.contextDirectories]) {
      const ownerPath = (await canonical(directory)) ?? resolve(directory);
      if (containsPath(path, ownerPath)) return title;
    }
    if (other.workspaceBranch !== branch && other.branch !== branch) continue;
    // A matching branch name in another repository does not share this checkout.
    if ((await canonical(await containerDirectory(other.directory))) === (await canonical(container))) return title;
  }
  return null;
}

/**
 * Whether one app checkout can go: uncertainty always keeps it. `bases` are the branch names its
 * commits may be proven preserved on when it has no upstream.
 */
async function inspectCheckout(input: {
  path: string;
  branch: string;
  container: string;
  entries: readonly WorktreeEntry[];
  others: readonly (ChatProject | undefined)[];
  bases: readonly string[];
  options?: OrphanListOptions;
}): Promise<Inspection> {
  const { path, branch, container, entries, others, bases, options } = input;
  const result = (reason: string | null, state: WorktreeState): Inspection => ({
    removal: { path, branch, safe: reason === null, reason },
    state,
  });
  for (const other of entries) {
    const otherPath = (await canonical(other.path)) ?? resolve(other.path);
    if (otherPath !== path && containsPath(path, otherPath)) return result('Contains another worktree', 'nested');
  }
  if (await ownerOf(path, branch, container, others, options)) return result('Used by another conversation', 'owned');
  const held = options?.hold?.();
  if (held) return result(held, 'owned');
  // `git worktree remove` deletes ignored files too, so ignored local data (.env and the like) keeps
  // the checkout. An ignored `node_modules` is the installer's regenerable output and does not.
  const status = await git(path, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching', '-z']);
  if (status) {
    const records = status.split('\0');
    let count = 0;
    for (let index = 0; index < records.length - 1; index++) {
      const record = records[index];
      if (!(record.startsWith('!! ') && /(^|\/)node_modules\/?$/.test(record.slice(3)))) count++;
      if (/^[RC]|^.[RC]/.test(record)) index++;
    }
    if (count > 0) return result(`${count} uncommitted file${count === 1 ? '' : 's'}`, 'dirty');
  }
  const upstream = (await git(path, ['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`])).trim();
  // `branch -d` judges a branch with an upstream against that upstream alone, and a command-local
  // `-c branch.<name>.merge` only adds a second value rather than replacing it. So only the
  // upstream can prove preservation, or `-d` would refuse after the checkout is already gone.
  const references = upstream
    ? [upstream]
    : bases
        .filter(base => base && base !== branch)
        .flatMap(base => [`refs/heads/${base}`, `refs/remotes/origin/${base}`, `refs/remotes/${base}`]);
  let localOnly: number | null = null;
  for (const reference of references) {
    try {
      const count = Number((await git(path, ['rev-list', '--count', `${reference}..refs/heads/${branch}`])).trim());
      if (count === 0) {
        const clean = result(null, 'clean');
        return { ...clean, removal: { ...clean.removal, preservedRef: reference } };
      }
      if (Number.isSafeInteger(count) && count > 0) localOnly = Math.min(localOnly ?? count, count);
    } catch {
      // A deleted upstream or base cannot prove that the commits were preserved.
    }
  }
  return localOnly === null
    ? result('Cannot verify the upstream or base branch', 'unverified')
    : result(`${localOnly} commit${localOnly === 1 ? '' : 's'} not pushed or merged`, 'unpushed');
}

/** The container's app root when it is genuinely the canonical `<container>/.b4m/worktrees`. */
async function canonicalWorktreeRoot(directory: string): Promise<{ container: string; root: string } | null> {
  const container = await containerDirectory(directory);
  const root = await canonical(appWorktreeRoot(container));
  if (!root || root !== appWorktreeRoot(await realpath(container))) return null;
  return { container, root };
}

/** Shared by the delete dialog and execution: uncertainty always keeps the checkout. */
export async function inspectWorktreeRemoval(
  project: ChatProject | undefined,
  otherProjects: readonly (ChatProject | undefined)[],
  options: OrphanListOptions = {}
): Promise<InspectedWorktreeRemoval | null> {
  if (!hasAppWorkspaceBranch(project)) return null;
  const path = await canonical(project.workingDirectory);
  if (!path) return null;
  const location = await canonicalWorktreeRoot(project.directory);
  if (!location) return null;
  const { container, root } = location;
  if (root === path || !containsPath(root, path)) return null;
  const branch = project.workspaceBranch;
  const entries = await listWorktrees(project.directory);
  const entry = await registeredAt(entries, path);
  if (entry?.branch !== branch || (await canonical(project.directory)) === path) return null;
  const bases = project.branch ? [project.branch] : [];
  return (await inspectCheckout({ path, branch, container, entries, others: otherProjects, bases, options })).removal;
}

const FALLBACK_BASES = ['main', 'master'];

async function lastCommitOf(path: string): Promise<string | null> {
  try {
    return (await git(path, ['log', '-1', '--format=%cI'])).trim() || null;
  } catch {
    return null;
  }
}

/** The repository's default branch first, then the usual names; a checkout with no upstream is judged against these. */
async function orphanBases(directory: string): Promise<string[]> {
  try {
    const head = (await git(directory, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
    const name = head.replace(/^origin\//, '');
    if (name) return [name, ...FALLBACK_BASES.filter(base => base !== name)];
  } catch {
    // No origin/HEAD recorded; the usual names are all there is to go on.
  }
  return FALLBACK_BASES;
}

export type OrphanListOptions = {
  /** All referenced folders, including grants held by conversations without a project. */
  owners?: readonly WorkspaceOwner[];
  /** The title of each project's conversation, which is what an owner is called. */
  titles?: ReadonlyMap<ChatProject, string>;
  /** Evaluated per checkout; a reason makes it unsafe, e.g. a workspace is still being cut. */
  hold?: () => string | null;
};

type ListedWorktree = AppWorktree & { preservedRef: string | null };

async function inspectAppWorktree(
  location: { container: string; root: string },
  entries: readonly WorktreeEntry[],
  entry: WorktreeEntry,
  path: string,
  bases: readonly string[],
  projects: readonly (ChatProject | undefined)[],
  options: OrphanListOptions
): Promise<ListedWorktree> {
  const { container } = location;
  const ownerName = await ownerOf(path, entry.branch ?? '', container, projects, options);
  const lastCommit = await lastCommitOf(path);
  if (!entry.branch?.startsWith(BRANCH_PREFIX)) {
    return {
      path,
      branch: entry.branch ?? '',
      safe: false,
      reason: 'Not a branch this app created',
      owner: ownerName,
      lastCommit,
      state: 'foreign',
      preservedRef: null,
    };
  }
  const held = options.hold?.() ?? null;
  if (held) {
    return {
      path,
      branch: entry.branch,
      safe: false,
      reason: held,
      owner: ownerName,
      lastCommit,
      state: 'owned',
      preservedRef: null,
    };
  }
  const { removal, state } = await inspectCheckout({
    path,
    branch: entry.branch,
    container,
    entries,
    others: projects,
    bases,
    options,
  });
  const unverified = removal.safe && !removal.preservedRef;
  return {
    path,
    branch: removal.branch,
    safe: removal.safe && !unverified,
    reason: unverified ? 'No upstream, and no default branch to compare against' : removal.reason,
    owner: ownerName,
    lastCommit,
    state: unverified ? 'unverified' : state,
    preservedRef: removal.preservedRef ?? null,
  };
}

/**
 * Every checkout under the repository's app worktree root, with the conversation that uses it.
 * Anything outside the root is never listed. Read-only: a hand-deleted folder simply is not listed,
 * because `git worktree prune` would also drop registrations outside the root.
 */
export async function listAppWorktrees(
  directory: string,
  projects: readonly (ChatProject | undefined)[],
  options: OrphanListOptions = {}
): Promise<ListedWorktree[]> {
  const location = await canonicalWorktreeRoot(directory);
  if (!location) return [];
  const entries = await listWorktrees(directory);
  const bases = await orphanBases(directory);
  const listed: ListedWorktree[] = [];
  for (const entry of entries) {
    const path = await canonical(entry.path);
    if (!path || path === location.root || !containsPath(location.root, path)) continue;
    try {
      listed.push(await inspectAppWorktree(location, entries, entry, path, bases, projects, options));
    } catch (error) {
      listed.push({
        path,
        branch: entry.branch ?? '',
        safe: false,
        reason: `Could not inspect worktree: ${error instanceof Error ? error.message : String(error)}`,
        owner: null,
        lastCommit: null,
        state: 'unverified',
        preservedRef: null,
      });
    }
  }
  return listed;
}

export async function removeSessionWorktree(
  project: ChatProject,
  otherProjects: readonly (ChatProject | undefined)[],
  options: OrphanListOptions = {}
): Promise<void> {
  const inspection = await inspectWorktreeRemoval(project, otherProjects, options);
  if (!inspection?.safe || !inspection.preservedRef) {
    throw new Error(inspection?.reason ?? 'This is not an app-created worktree');
  }
  const held = options.hold?.();
  if (held) throw new Error(held);
  await removeWorktreeAt(project.directory, inspection.path, inspection.branch, inspection.preservedRef);
}

/** Removes the checkout, then its branch with `-d` only, judged against the ref that proved it preserved. */
async function removeWorktreeAt(directory: string, path: string, branch: string, preservedRef: string): Promise<void> {
  await git(directory, ['worktree', 'remove', path]);
  try {
    const upstream = (await git(directory, ['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`])).trim();
    // Without an upstream, use the proven base rather than this checkout's possibly stale HEAD.
    // With one, the inspection already proved against that upstream, which is what `-d` checks.
    // Command-local settings never persist.
    const comparison = upstream
      ? []
      : ['-c', `branch.${branch}.remote=.`, '-c', `branch.${branch}.merge=${preservedRef}`];
    await git(directory, [...comparison, 'branch', '-d', '--', branch]);
  } catch (err) {
    throw new Error(
      `Worktree removed, but branch ${branch} was kept: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Re-inspects only the named checkout at call time, so one that became owned, dirty or unpushed since listing is skipped. */
export async function removeOrphanWorktree(
  directory: string,
  path: string,
  projects: readonly (ChatProject | undefined)[],
  options: OrphanListOptions = {}
): Promise<WorktreeSweepItem> {
  let branch = '';
  try {
    const wanted = (await canonical(path)) ?? resolve(path);
    const location = await canonicalWorktreeRoot(directory);
    const entries = location ? await listWorktrees(directory) : [];
    let entry: WorktreeEntry | null = null;
    if (location && containsPath(location.root, wanted) && wanted !== location.root) {
      entry = await registeredAt(entries, wanted);
    }
    if (!location || !entry) return { path, branch, status: 'skipped', message: 'No longer listed' };
    branch = entry.branch ?? '';
    const current = await inspectAppWorktree(
      location,
      entries,
      entry,
      wanted,
      await orphanBases(directory),
      projects,
      options
    );
    const { preservedRef } = current;
    if (!current.safe || !preservedRef) {
      return {
        path,
        branch,
        status: 'skipped',
        message: current.reason ?? 'Cannot verify the upstream or base branch',
      };
    }
    // Preparation can start during the inspection's Git awaits; check again at the deletion boundary.
    const held = options.hold?.();
    if (held) return { path, branch, status: 'skipped', message: held };
    await removeWorktreeAt(directory, current.path, branch, preservedRef);
    return { path, branch, status: 'removed', message: null };
  } catch (err) {
    return { path, branch, status: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}

/** Removes every safe orphan; the rest are reported as skipped with their reason. */
export async function sweepSafeOrphans(
  directory: string,
  projects: readonly (ChatProject | undefined)[],
  options: OrphanListOptions = {}
): Promise<WorktreeSweepItem[]> {
  const results: WorktreeSweepItem[] = [];
  for (const item of await listAppWorktrees(directory, projects, options)) {
    results.push(
      item.safe
        ? await removeOrphanWorktree(directory, item.path, projects, options)
        : { path: item.path, branch: item.branch, status: 'skipped', message: item.reason }
    );
  }
  return results;
}

/**
 * The worktree a Code session with the workspace toggle ON runs in, creating one only when the
 * session does not already have it.
 *
 * The branch the user picks is a BASE, not a target: the session is given a branch of its own,
 * cut from it. Picking a branch something else already has checked out used to hand back that
 * checkout, so "worktree" claimed an isolation the session did not get - and the one branch a
 * user is most likely to pick, `main`, is the one always already checked out. Claude Code's own
 * entries in these containers show the same shape: a folder named for a branch nothing else
 * holds.
 *
 * One rule covers both halves of what the chip menu can send. A name that IS a branch is a base
 * and the session's branch is derived; a name that is NOT names the session's branch, which is
 * then cut from the default base. Either way the session ends up alone on a branch of its own.
 * A caller naming both - a spawned session, whose branch the user approved by name - has it cut
 * from `base`.
 *
 * Idempotence is the caller's half: `branch` comes back in the resolution and goes onto the
 * session, and handing it in again short-circuits both the derivation and the cut. Without it
 * every restart and every re-read of a project would cut another branch.
 *
 * Nothing here writes to a '../' path, which would scatter sibling folders that read as
 * separate projects, and nothing touches a worktree this app did not create: a path already
 * occupied is refused, never adopted or cleared.
 */
export async function resolveWorkspace(
  projectDirectory: string,
  request: WorkspaceRequest
): Promise<WorkspaceResolution> {
  const { timer } = request;
  const registered = await listWorktrees(projectDirectory);
  timer?.lap('worktreeList');
  const base = (request.base ?? '').trim();

  let branch = (request.branch ?? '').trim();
  let cutFrom = '';
  if (!branch) {
    // The single lookup that decides which half of the rule applies.
    if (base && (await branchExists(projectDirectory, base))) {
      cutFrom = base;
      branch = sessionBranchName(request.name);
    } else {
      branch = base || sessionBranchName(request.name);
    }
  } else {
    cutFrom = base;
  }

  request.onBranch?.(branch);

  // Keyed on the session's OWN branch, so this hits only for a worktree this session already
  // has - never for the user's checkout of the base.
  const existingForBranch = registered.find(entry => entry.branch === branch);
  if (existingForBranch) return { workingDirectory: existingForBranch.path, branch, outcome: 'reused' };

  const container = await containerDirectory(projectDirectory);
  const path = join(appWorktreeRoot(container), worktreeFolderName(branch));

  const occupant = await registeredAt(registered, path);
  if (occupant) {
    const holds = occupant.branch ? `the branch ${occupant.branch}` : 'a detached HEAD';
    throw new Error(
      `${path} is a git worktree holding ${holds}, not ${branch}. Pick a different branch for this ` +
        `session, or move that worktree with 'git worktree move' - plain mv would leave git ` +
        `pointing at a path that no longer exists.`
    );
  }

  // Something is at the path but git does not know it as a worktree. Refusing beats both
  // clobbering it and adopting a directory whose contents nobody has vouched for.
  if (await directoryExists(path)) {
    throw new Error(`${path} already exists but is not a git worktree. Move it aside, or pick a different branch.`);
  }

  await ensureWorktreeRoot(container);

  if (await branchExists(projectDirectory, branch)) {
    timer?.lap('checks');
    await git(projectDirectory, ['worktree', 'add', path, branch]);
    timer?.lap('worktreeAdd');
    return { workingDirectory: path, branch, outcome: 'created' };
  }

  timer?.lap('checks');
  const from = await baseRefFor(projectDirectory, cutFrom);
  timer?.lap('fetch');
  const { spares } = request;
  const fromSpare = (await spares?.take(projectDirectory, container, branch, path, from)) ?? false;
  // --no-track for the reason the shell helper gives: a feature branch should not track the
  // base it forked from, or a later `git push` would aim at the wrong ref.
  if (!fromSpare) await git(projectDirectory, ['worktree', 'add', '--no-track', '-b', branch, path, from]);
  timer?.lap(fromSpare ? 'spareSwitch' : 'worktreeAdd');
  spares?.refill(projectDirectory, container, from);
  return { workingDirectory: path, branch, outcome: 'created' };
}
