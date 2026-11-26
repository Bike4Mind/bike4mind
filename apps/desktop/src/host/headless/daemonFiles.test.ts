import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  acquireDaemonLock,
  DaemonAlreadyRunningError,
  daemonPaths,
  type DaemonLock,
  type LockRecord,
} from './daemonFiles';

const hooks = vi.hoisted(() => ({ beforeRename: null as null | (() => Promise<void>) }));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const hook = hooks.beforeRename;
      hooks.beforeRename = null;
      await hook?.();
      return actual.rename(...args);
    },
  };
});

const describePosix = process.platform === 'win32' ? describe.skip : describe;

const scratch: string[] = [];

afterAll(async () => {
  for (const directory of scratch) await rm(directory, { recursive: true, force: true });
});

// The runner's TMPDIR is too deep for a unix socket path, so these live directly under /tmp.
async function dataDirectory(): Promise<string> {
  const root = await mkdtemp('/tmp/b4mh-');
  scratch.push(root);
  const directory = join(root, 'host');
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

/** The pid of a process that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(child.stdout);
}

const lockText = (record: LockRecord) => `${JSON.stringify(record)}\n`;

async function race(directory: string) {
  const paths = daemonPaths(directory);
  const results = await Promise.allSettled([acquireDaemonLock(paths, 'a'), acquireDaemonLock(paths, 'b')]);
  const won = results.filter((result): result is PromiseFulfilledResult<DaemonLock> => result.status === 'fulfilled');
  const lost = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  return { paths, won, lost };
}

describePosix('acquireDaemonLock', () => {
  it('lets exactly one of two concurrent starters take a free lock', async () => {
    const { paths, won, lost } = await race(await dataDirectory());

    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBeInstanceOf(DaemonAlreadyRunningError);
    expect(JSON.parse(await readFile(paths.lock, 'utf8'))).toEqual(won[0].value.record);
    await won[0].value.release();
  });

  it('lets exactly one of two concurrent starters replace a stale lock', async () => {
    const directory = await dataDirectory();
    await writeFile(daemonPaths(directory).lock, lockText({ pid: deadPid(), version: '0.9.0', startedAt: Date.now() }));

    const { paths, won, lost } = await race(directory);

    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBeInstanceOf(DaemonAlreadyRunningError);
    expect(JSON.parse(await readFile(paths.lock, 'utf8'))).toEqual(won[0].value.record);
    await won[0].value.release();
  });

  it('puts back a fresh lock that replaced the stale one before it could be removed', async () => {
    const directory = await dataDirectory();
    const paths = daemonPaths(directory);
    await writeFile(paths.lock, lockText({ pid: deadPid(), version: '0.9.0', startedAt: Date.now() }));
    const fresh = lockText({ pid: process.pid, version: '2.0.0', startedAt: Date.now() });
    hooks.beforeRename = () => writeFile(paths.lock, fresh);

    await expect(acquireDaemonLock(paths, '1.0.0')).rejects.toThrow(DaemonAlreadyRunningError);

    expect(await readFile(paths.lock, 'utf8')).toBe(fresh);
    expect(await readdir(directory)).toEqual(['host.lock']);
  });
});
