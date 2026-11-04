import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RUN_ROOT_ENV,
  RUN_ROOT_PREFIX,
  STALE_ROOT_AGE_MS,
  removeDeadRunRoots,
  removeRoot,
  startRootHeartbeat,
} from '../../vitest.tempRoot';

// A read-only directory blocks deletion only for a non-root user on POSIX.
const canLockDirs = process.platform !== 'win32' && process.getuid?.() !== 0;

describe('test temp root', () => {
  it("points every tmpdir and homedir variable at this file's own directories", () => {
    const root = tmpdir();
    expect(basename(root)).toMatch(/^b4m-desktop-test-/);
    expect(basename(dirname(root))).toMatch(new RegExp(`^${RUN_ROOT_PREFIX}\\d+-`));
    expect(dirname(root)).toBe(process.env[RUN_ROOT_ENV]);
    expect([process.env.TMPDIR, process.env.TEMP, process.env.TMP]).toEqual([root, root, root]);

    const home = join(root, 'home');
    expect(homedir()).toBe(home);
    expect([process.env.HOME, process.env.USERPROFILE]).toEqual([home, home]);
  });

  it('hands the redirected directories to child processes', () => {
    const script = "const os = require('node:os'); console.log(os.tmpdir() + '\\n' + os.homedir())";
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    expect(child.stdout.trim().split('\n')).toEqual([tmpdir(), homedir()]);
  });
});

describe('removeDeadRunRoots', () => {
  let parent: string;
  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'dead-run-roots-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(parent, { recursive: true, force: true });
  });

  const age = (name: string, ms: number) => {
    const then = new Date(Date.now() - ms);
    return utimes(join(parent, name), then, then);
  };

  it('removes the old roots of dead runs and keeps live, unnamed and unrelated ones', async () => {
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    const dead = `${RUN_ROOT_PREFIX}${deadPid}-abc123`;
    const keep = [`${RUN_ROOT_PREFIX}${process.pid}-abc123`, `${RUN_ROOT_PREFIX}abc123`, 'unrelated-dir'];
    await Promise.all([dead, ...keep].map(name => mkdir(join(parent, name, 'nested'), { recursive: true })));
    await Promise.all([dead, ...keep].map(name => age(name, STALE_ROOT_AGE_MS + 60_000)));

    await removeDeadRunRoots(parent);

    expect(existsSync(join(parent, dead))).toBe(false);
    expect(keep.map(name => existsSync(join(parent, name)))).toEqual([true, true, true]);
  });

  it('keeps the root of a dead pid until its mtime is old', async () => {
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    const fresh = `${RUN_ROOT_PREFIX}${deadPid}-fresh1`;
    const old = `${RUN_ROOT_PREFIX}${deadPid}-old123`;
    await Promise.all([fresh, old].map(name => mkdir(join(parent, name, 'nested'), { recursive: true })));
    await age(fresh, STALE_ROOT_AGE_MS - 60_000);
    await age(old, STALE_ROOT_AGE_MS + 60_000);

    await removeDeadRunRoots(parent);

    expect([fresh, old].map(name => existsSync(join(parent, name)))).toEqual([true, false]);
  });

  it.skipIf(!canLockDirs)('warns and carries on when an old root cannot be removed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    const stuck = `${RUN_ROOT_PREFIX}${deadPid}-stuck1`;
    const gone = `${RUN_ROOT_PREFIX}${deadPid}-gone12`;
    const locked = join(parent, stuck, 'locked');
    await mkdir(locked, { recursive: true });
    await writeFile(join(locked, 'file'), '');
    await chmod(locked, 0o555);
    await mkdir(join(parent, gone, 'nested'), { recursive: true });
    await Promise.all([stuck, gone].map(name => age(name, STALE_ROOT_AGE_MS + 60_000)));
    try {
      await removeDeadRunRoots(parent);

      expect([stuck, gone].map(name => existsSync(join(parent, name)))).toEqual([true, false]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(stuck));
    } finally {
      await chmod(locked, 0o755);
    }
  });
});

describe('removeRoot', () => {
  afterEach(() => {
    vi.doUnmock('node:fs/promises');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  const removeRootFailingWith = async (code: string) => {
    const failure = Object.assign(new Error(code), { code });
    vi.resetModules();
    vi.doMock('node:fs/promises', async importOriginal => ({
      ...(await importOriginal<typeof import('node:fs/promises')>()),
      rm: vi.fn().mockRejectedValue(failure),
    }));
    return (await import('../../vitest.tempRoot')).removeRoot('/some/dir');
  };

  it('removes a tree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'remove-root-'));
    await mkdir(join(dir, 'nested'));
    await writeFile(join(dir, 'nested', 'file'), '');

    await removeRoot(dir);

    expect(existsSync(dir)).toBe(false);
  });

  it.each(['EBUSY', 'EPERM', 'ENOTEMPTY'])('warns and resolves when removal fails with %s', async code => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(removeRootFailingWith(code)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('/some/dir'));
  });

  it('rejects when removal fails with any other error', async () => {
    await expect(removeRootFailingWith('EACCES')).rejects.toMatchObject({ code: 'EACCES' });
  });

  it.skipIf(!canLockDirs)('rejects and leaves the tree when a subdirectory is read-only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'remove-root-'));
    const locked = join(dir, 'locked');
    await mkdir(locked);
    await writeFile(join(locked, 'file'), '');
    await chmod(locked, 0o555);
    try {
      await expect(removeRoot(dir)).rejects.toMatchObject({ code: 'EACCES' });
      expect(existsSync(join(locked, 'file'))).toBe(true);
    } finally {
      await chmod(locked, 0o755);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('startRootHeartbeat', () => {
  it('refreshes the root mtime until stopped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'heartbeat-'));
    const old = new Date(Date.now() - STALE_ROOT_AGE_MS - 60_000);
    await utimes(dir, old, old);
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const stop = startRootHeartbeat(dir, 20);
    try {
      try {
        await vi.waitUntil(async () => (await stat(dir)).mtimeMs > old.getTime() + 60_000, {
          timeout: 2000,
          interval: 10,
        });
      } finally {
        stop();
      }

      // A utimes issued by the last tick can land after stop(); let it settle before resetting.
      await sleep(50);
      await utimes(dir, old, old);
      await sleep(100);
      expect((await stat(dir)).mtimeMs).toBeLessThan(old.getTime() + 1000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
