import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { posix } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatProject } from '@shared/chat';

// A WSL project as Windows sees it, emulated on this host: Windows path rules, a share whose
// paths are this host's own, and the distro's commands run here directly.
vi.mock('node:path', async importOriginal => {
  const { win32 } = await importOriginal<typeof import('node:path')>();
  return { ...win32, default: win32 };
});

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const SHARE = /^\\\\wsl\.localhost\\Ubuntu((?:\\.*)?)$/i;
  const onShare = (path: unknown): string | null => {
    const match = typeof path === 'string' ? SHARE.exec(path) : null;
    return match ? (match[1] as string).replaceAll('\\', '/') || '/' : null;
  };
  const toHost = (arg: unknown): unknown => {
    const linux = onShare(arg);
    if (linux) return linux;
    // A Windows path this host cannot reach; refused so it never lands in the working directory.
    if (typeof arg === 'string' && arg.includes('\\')) {
      throw Object.assign(new Error(`ENOENT: ${arg}`), { code: 'ENOENT' });
    }
    return arg;
  };
  const shared = Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value === 'function'
        ? async (...args: unknown[]) => (value as (...rest: unknown[]) => unknown)(...args.map(toHost))
        : value,
    ])
  );
  // Windows reaches a share path without following the Linux symlinks in it.
  const realpath = async (path: string) => {
    const linux = onShare(path);
    if (!linux) return actual.realpath(path);
    await actual.lstat(linux);
    return path;
  };
  return { ...shared, realpath, default: { ...shared, realpath } };
});

vi.mock('../../wsl/wslPath', async importOriginal => {
  const actual = await importOriginal<typeof import('../../wsl/wslPath')>();
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    wslLocation: (directory: string) => actual.parseWslPath(directory),
    wslCommand: (...args: Parameters<typeof actual.wslCommand>) => {
      const [, , , shell, ...rest] = actual.wslCommand(...args).args;
      return { file: shell as string, args: rest };
    },
    wslCommandEnv: async () => ({ ...process.env }),
    wslRealpath: async (_distro: string, linuxPath: string) =>
      fs.realpath(linuxPath).catch(() => posix.normalize(linuxPath)),
  };
});

const { wslUncPath } = await import('../../wsl/wslPath');
const { branchCheckouts, git } = await import('./git');
const { SpareWorktrees, inspectWorktreeRemoval, removeSessionWorktree, resolveWorkspace, worktreeFolderName } =
  await import('./workspace');

const share = (linuxPath: string) => wslUncPath({ host: 'wsl.localhost', distro: 'Ubuntu' }, linuxPath);
const exists = (linuxPath: string) =>
  stat(linuxPath).then(
    () => true,
    () => false
  );

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function repository(): Promise<{ root: string; repo: string }> {
  const root = await realpath(await mkdtemp(posix.join(tmpdir(), 'b4m-wsl-')));
  roots.push(root);
  const repo = posix.join(root, 'data', 'proj');
  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '-q', '--initial-branch=main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test']);
  await writeFile(posix.join(repo, '.gitignore'), '.b4m/\n');
  await git(repo, ['add', '.gitignore']);
  await git(repo, ['commit', '-qm', 'initial']);
  return { root, repo };
}

const projectFor = (directory: string, workingDirectory: string, workspaceBranch: string): ChatProject => ({
  directory,
  name: 'proj',
  branch: 'main',
  workspace: true,
  workspaceBranch,
  workingDirectory,
  contextDirectories: [],
});

describe('worktrees of a WSL project', () => {
  it('gives Linux git Linux paths and reads its answers back onto the share', async () => {
    const { repo } = await repository();
    const project = share(repo);
    const worktrees = posix.join(repo, '.b4m', 'worktrees');
    const spareReady = async () => {
      const link = await readFile(posix.join(repo, '.b4m', 'spare', '.git'), 'utf8').catch(() => '');
      const gitDirectory = link.replace(/^gitdir: /, '').trim();
      expect(gitDirectory && (await exists(posix.join(gitDirectory, 'b4m-spare')))).toBe(true);
    };
    const spares = new SpareWorktrees(0);

    const first = await resolveWorkspace(project, { base: 'main', name: 'first', spares });
    const firstLinux = posix.join(worktrees, worktreeFolderName(first.branch));
    expect(first.workingDirectory).toBe(share(firstLinux));
    expect(await exists(firstLinux)).toBe(true);

    await vi.waitFor(spareReady, { timeout: 10_000 });
    const second = await resolveWorkspace(project, { base: 'main', name: 'second', spares });
    const secondLinux = posix.join(worktrees, worktreeFolderName(second.branch));
    expect(second.workingDirectory).toBe(share(secondLinux));
    expect(await readFile(posix.join(secondLinux, '.git'), 'utf8')).toContain('/worktrees/spare');

    await vi.waitFor(spareReady, { timeout: 10_000 });
    await spares.dispose();
    expect(await exists(posix.join(repo, '.b4m', 'spare'))).toBe(false);

    await git(repo, ['branch', 'b4m/existing']);
    const third = await resolveWorkspace(project, { branch: 'b4m/existing' });
    expect(await exists(posix.join(worktrees, 'b4m+existing'))).toBe(true);
    expect(third.outcome).toBe('created');

    await removeSessionWorktree(projectFor(project, first.workingDirectory, first.branch), []);
    expect(await exists(firstLinux)).toBe(false);

    expect((await readdir(repo)).filter(name => name.includes('\\'))).toEqual([]);
  });

  it('follows a Linux symlink to the project inside the distro', async () => {
    const { root, repo } = await repository();
    const link = posix.join(root, 'home', 'proj');
    await mkdir(posix.dirname(link), { recursive: true });
    await symlink(repo, link);
    const project = share(link);

    expect(await branchCheckouts(project)).toEqual({});

    const session = await resolveWorkspace(project, { base: 'main', name: 'linked' });
    const viaLink = share(posix.join(link, '.b4m', 'worktrees', worktreeFolderName(session.branch)));
    expect(await inspectWorktreeRemoval(projectFor(project, viaLink, session.branch), [])).toMatchObject({
      safe: true,
    });
  });
});
