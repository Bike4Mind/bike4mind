import { promises as fsPromises, type Stats } from 'fs';
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LockLostError, withLockDir, type LockDirOptions } from './lockDir.js';

const STALE_MS = 300;
const opts = (waitMs = 2_000): LockDirOptions => ({ waitMs, staleMs: STALE_MS, pollMs: 5, heldMessage: 'held' });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let dir: string;
let lockPath: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'b4m-lock-dir-'));
  lockPath = path.join(dir, 'config.json.lock');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>(resolve => {
    open = resolve;
  });
  return { wait, open };
}

/** The next stat of the live lock path reports it long untouched, as a contender that misjudges it would see. */
function misjudgeNextStat(): void {
  const realStat = fsPromises.stat.bind(fsPromises);
  let faked = false;
  vi.spyOn(fsPromises, 'stat').mockImplementation((async (...args: Parameters<typeof realStat>) => {
    const stats = (await realStat(...args)) as Stats;
    if (faked || String(args[0]) !== lockPath) return stats;
    faked = true;
    return Object.assign(Object.create(Object.getPrototypeOf(stats) as object) as Stats, stats, {
      mtimeMs: Date.now() - 60_000,
    });
  }) as typeof fsPromises.stat);
}

async function staleLockAt(target: string): Promise<void> {
  await mkdir(target);
  await writeFile(path.join(target, 'owner'), JSON.stringify({ pid: 1, hostname: 'elsewhere', nonce: 'gone' }));
  const old = new Date(Date.now() - 60_000);
  await utimes(target, old, old);
}

describe('withLockDir', () => {
  it('a holder whose lock a contender wrongly breaks finds it lost before its write, so only one writes', async () => {
    // Hard links play no part in this scheme; a filesystem without them changes nothing.
    vi.spyOn(fsPromises, 'link').mockRejectedValue(Object.assign(new Error('not supported'), { code: 'EPERM' }));
    const holderIn = gate();
    const contenderDone = gate();
    const writes: string[] = [];

    const holder = withLockDir(
      lockPath,
      async held => {
        holderIn.open();
        await contenderDone.wait;
        await held.assertHeld();
        writes.push('holder');
      },
      opts()
    );
    await holderIn.wait;
    misjudgeNextStat();
    await withLockDir(
      lockPath,
      async held => {
        await held.assertHeld();
        writes.push('contender');
      },
      opts()
    );
    contenderDone.open();

    await expect(holder).rejects.toBeInstanceOf(LockLostError);
    expect(writes).toEqual(['contender']);
  });

  it('keeps out a contender that finishes breaking a stale lock after another process already took the lock', async () => {
    await staleLockAt(lockPath);
    const realRename = fsPromises.rename.bind(fsPromises);
    const thirdIn = gate();
    let parked = false;
    vi.spyOn(fsPromises, 'rename').mockImplementation((async (...args: Parameters<typeof realRename>) => {
      await realRename(...args);
      if (!parked && String(args[0]) === lockPath) {
        parked = true;
        await thirdIn.wait;
      }
    }) as typeof fsPromises.rename);
    let inside = 0;
    let most = 0;
    const work = (name: string, order: string[]) => async () => {
      inside++;
      most = Math.max(most, inside);
      order.push(name);
      await sleep(50);
      inside--;
    };
    const order: string[] = [];

    const breaker = withLockDir(lockPath, work('breaker', order), opts());
    await vi.waitFor(() => expect(parked).toBe(true));
    const third = withLockDir(
      lockPath,
      async () => {
        thirdIn.open();
        await work('third', order)();
      },
      opts()
    );
    await Promise.all([breaker, third]);

    expect(most).toBe(1);
    expect(order).toEqual(['third', 'breaker']);
  });

  it('leaves no lock behind when its holder releases while a contender is moving it aside', async () => {
    const holderIn = gate();
    const holderOut = gate();
    const realRename = fsPromises.rename.bind(fsPromises);
    let moved = false;
    const holder = withLockDir(
      lockPath,
      async () => {
        holderIn.open();
        await holderOut.wait;
      },
      opts()
    ).catch((error: unknown) => error);
    await holderIn.wait;
    misjudgeNextStat();
    vi.spyOn(fsPromises, 'rename').mockImplementation((async (...args: Parameters<typeof realRename>) => {
      await realRename(...args);
      if (!moved && String(args[0]) === lockPath) {
        moved = true;
        holderOut.open();
        await holder;
      }
    }) as typeof fsPromises.rename);

    await withLockDir(lockPath, async () => 'ran', opts());

    expect(await holder).toBeInstanceOf(LockLostError);
    await expect(stat(lockPath)).rejects.toThrow();
    expect(await withLockDir(lockPath, async () => 'again', opts(50))).toBe('again');
  });

  it('is not broken while its holder works longer than the stale limit', async () => {
    const holderIn = gate();
    const contender = vi.fn(async () => 'ran');
    const holder = withLockDir(
      lockPath,
      async held => {
        holderIn.open();
        await sleep(STALE_MS * 3);
        await held.assertHeld();
        return 'held';
      },
      opts()
    );
    await holderIn.wait;

    await expect(withLockDir(lockPath, contender, opts(STALE_MS * 2))).rejects.toThrow('held');
    expect(contender).not.toHaveBeenCalled();
    expect(await holder).toBe('held');
  });

  it('breaks a lock whose holder stopped touching it, and one left by a holder on this host that exited', async () => {
    await staleLockAt(lockPath);
    expect(await withLockDir(lockPath, async () => 'ran', opts(100))).toBe('ran');

    await mkdir(lockPath);
    await writeFile(
      path.join(lockPath, 'owner'),
      JSON.stringify({ pid: 2_147_483_646, hostname: os.hostname(), nonce: 'exited' })
    );
    expect(await withLockDir(lockPath, async () => 'ran', opts(100))).toBe('ran');
  });

  it('breaks an old-style lock file once it is past the stale limit, and waits on a fresh one', async () => {
    await writeFile(lockPath, JSON.stringify({ pid: 1, at: Date.now(), nonce: 'old-style' }));
    await expect(withLockDir(lockPath, async () => 'ran', opts(50))).rejects.toThrow('held');

    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    expect(await withLockDir(lockPath, async () => 'ran', opts(100))).toBe('ran');
  });

  it('sweeps aside locks and old *.aside files past the stale limit, and keeps fresh ones', async () => {
    const oldAside = `${lockPath}.a.stale`;
    const oldFile = `${lockPath}.b.aside`;
    const freshAside = `${lockPath}.c.stale`;
    await staleLockAt(oldAside);
    await writeFile(oldFile, '{}');
    const old = new Date(Date.now() - 60_000);
    await utimes(oldFile, old, old);
    await mkdir(freshAside);

    await withLockDir(lockPath, async () => undefined, opts());

    expect((await readdir(dir)).sort()).toEqual([path.basename(freshAside)]);
  });

  it('retries a release Windows refuses for a moment', async () => {
    const realRm = fsPromises.rm.bind(fsPromises);
    let refused = 0;
    vi.spyOn(fsPromises, 'rm').mockImplementation((async (...args: Parameters<typeof realRm>) => {
      if (String(args[0]) === lockPath && refused < 2) {
        refused++;
        throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
      }
      return realRm(...args);
    }) as typeof fsPromises.rm);

    await withLockDir(lockPath, async () => undefined, opts());

    expect(refused).toBe(2);
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it('on Windows, waits out a lock still being deleted instead of failing', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const realMkdir = fsPromises.mkdir.bind(fsPromises);
    let refused = false;
    vi.spyOn(fsPromises, 'mkdir').mockImplementation((async (...args: Parameters<typeof realMkdir>) => {
      if (!refused && String(args[0]) === lockPath) {
        refused = true;
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      }
      return realMkdir(...args);
    }) as typeof fsPromises.mkdir);
    try {
      expect(await withLockDir(lockPath, async () => 'ran', opts())).toBe('ran');
      expect(refused).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('rejects after its work when another process took the lock over meanwhile', async () => {
    await expect(
      withLockDir(
        lockPath,
        async () => {
          await rm(lockPath, { recursive: true, force: true });
          await staleLockAt(lockPath);
          return 'ran';
        },
        opts()
      )
    ).rejects.toBeInstanceOf(LockLostError);
  });
});
