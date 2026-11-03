import { spawnSync } from 'node:child_process';
import { chmod, link, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, uptime } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link) };
});
import { ModelFileBusyError, RuntimeStorageError } from './errors';
import { LOCK_STALE_MS, lockFile, onDisk } from './fileLock';

let dir: string;
let count = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'file-lock-test-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const target = () => join(dir, `model-${++count}.gguf`);
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  return child.pid as number;
}

async function age(path: string, ms: number): Promise<void> {
  const then = new Date(Date.now() - ms);
  await utimes(path, then, then);
}

describe('lockFile', () => {
  it('writes the holder with a nonce, refuses a second holder, and removes the lock on release', async () => {
    const path = target();
    const lock = await lockFile(path, 'test');
    expect(JSON.parse(await readFile(`${path}.lock`, 'utf8'))).toEqual({
      pid: process.pid,
      host: hostname(),
      nonce: expect.stringMatching(/^[0-9a-f]{24}$/),
    });
    const busy = await lockFile(path, 'test').catch((caught: unknown) => caught);
    expect(busy).toBeInstanceOf(ModelFileBusyError);
    expect(busy).toMatchObject({ path, pid: process.pid, runtimeId: 'test' });
    await lock.verify();
    await lock.release();
    await lock.release();
    await expect(stat(`${path}.lock`)).rejects.toThrow();
    await (await lockFile(path, 'test')).release();
  });

  it('judges a lock by its refresh time, whatever pid or host it names', async () => {
    const path = target();
    await writeFile(`${path}.lock`, JSON.stringify({ pid: deadPid(), host: hostname() }));
    await expect(lockFile(path, 'test')).rejects.toBeInstanceOf(ModelFileBusyError);
    await age(`${path}.lock`, LOCK_STALE_MS + 5_000);
    const lock = await lockFile(path, 'test');
    expect(JSON.parse(await readFile(`${path}.lock`, 'utf8'))).toMatchObject({ pid: process.pid });
    await lock.release();

    const other = target();
    await writeFile(`${other}.lock`, JSON.stringify({ pid: process.pid, host: 'elsewhere', nonce: 'x' }));
    await age(`${other}.lock`, LOCK_STALE_MS + 5_000);
    await (await lockFile(other, 'test')).release();
  });

  it('takes over a lock last refreshed before the machine booted', async () => {
    const path = target();
    await writeFile(`${path}.lock`, '');
    await expect(lockFile(path, 'test', { staleMs: Infinity })).rejects.toMatchObject({ pid: null });
    await age(`${path}.lock`, uptime() * 1000 + 60_000);
    await (await lockFile(path, 'test', { staleMs: Infinity })).release();
  });

  it('refreshes a held lock, notices a takeover, and leaves the new holder alone on release', async () => {
    const path = target();
    const first = await lockFile(path, 'test', { refreshMs: 40 });
    await age(`${path}.lock`, 60_000);
    await wait(150);
    expect(Date.now() - (await stat(`${path}.lock`)).mtimeMs).toBeLessThan(5_000);
    first.assertHeld();

    const second = await lockFile(path, 'test', { force: true });
    await expect(first.verify()).rejects.toBeInstanceOf(ModelFileBusyError);
    await wait(150);
    expect(() => first.assertHeld()).toThrow(ModelFileBusyError);
    await first.release();
    await expect(lockFile(path, 'test')).rejects.toBeInstanceOf(ModelFileBusyError);
    await second.release();
    await expect(stat(`${path}.lock`)).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'rides out a lock it cannot read for a while, and gives it up only after the stale window',
    async () => {
      const path = target();
      const lock = await lockFile(path, 'test', { refreshMs: 20, staleMs: 400 });
      await chmod(`${path}.lock`, 0o000);
      await wait(100);
      lock.assertHeld();
      await lock.check();
      await expect(lock.verify()).rejects.toMatchObject({ name: 'RuntimeStorageError', code: 'EACCES' });
      // verify() retries: a lock readable again within its retries passes.
      const verified = lock.verify();
      setTimeout(() => void chmod(`${path}.lock`, 0o644), 50);
      await verified;
      await chmod(`${path}.lock`, 0o000);
      await wait(600);
      expect(() => lock.assertHeld()).toThrow(ModelFileBusyError);
      await chmod(`${path}.lock`, 0o644);
      await lock.release();
      expect(JSON.parse(await readFile(`${path}.lock`, 'utf8'))).toMatchObject({ pid: process.pid });
    }
  );

  it('sweeps aside files a crash left behind once they are past the stale window', async () => {
    const path = target();
    await writeFile(`${path}.lock.stale-0123`, '{}');
    await writeFile(`${path}.lock.takeover.stale-4567`, '');
    await writeFile(`${path}.lock.takeover.new-89ab`, '89ab');
    await writeFile(`${path}.other`, '');
    const fresh = await lockFile(path, 'test', { staleMs: 60_000 });
    await fresh.release();
    await expect(stat(`${path}.lock.stale-0123`)).resolves.toBeTruthy();
    await wait(80);
    await (await lockFile(path, 'test', { staleMs: 50 })).release();
    await expect(stat(`${path}.lock.stale-0123`)).rejects.toThrow();
    await expect(stat(`${path}.lock.takeover.stale-4567`)).rejects.toThrow();
    await expect(stat(`${path}.lock.takeover.new-89ab`)).rejects.toThrow();
    await expect(stat(`${path}.other`)).resolves.toBeTruthy();
  });

  it('clears a takeover guard left by a process that died during a takeover', async () => {
    const path = target();
    await writeFile(`${path}.lock`, '{}');
    await writeFile(`${path}.lock.takeover`, '');
    await age(`${path}.lock`, LOCK_STALE_MS + 5_000);
    await expect(lockFile(path, 'test')).rejects.toBeInstanceOf(ModelFileBusyError);
    await age(`${path}.lock.takeover`, LOCK_STALE_MS + 5_000);
    await (await lockFile(path, 'test')).release();
    await expect(stat(`${path}.lock.takeover`)).rejects.toThrow();
  });

  it('clears a takeover guard dated before the machine booted at once', async () => {
    const path = target();
    await writeFile(`${path}.lock`, '{}');
    await writeFile(`${path}.lock.takeover`, '');
    await age(`${path}.lock`, uptime() * 1000 + 60_000);
    await age(`${path}.lock.takeover`, uptime() * 1000 + 60_000);
    await (await lockFile(path, 'test', { staleMs: 3_600_000_000 })).release();
    await expect(stat(`${path}.lock.takeover`)).rejects.toThrow();
  });

  it('gives a stale lock behind a stale guard to exactly one of many contenders', async () => {
    for (let trial = 0; trial < 300; trial++) {
      const path = target();
      await writeFile(`${path}.lock`, '{}');
      await writeFile(`${path}.lock.takeover`, '');
      await age(`${path}.lock`, LOCK_STALE_MS + 5_000);
      await age(`${path}.lock.takeover`, LOCK_STALE_MS + 5_000);
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => lockFile(path, 'test')));
      const won = results.filter(result => result.status === 'fulfilled');
      expect(won).toHaveLength(1);
      expect(results.filter(result => result.status === 'rejected').map(result => result.reason)).toEqual(
        Array(5).fill(expect.any(ModelFileBusyError))
      );
      await (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof lockFile>>>).value.release();
      await expect(stat(`${path}.lock.takeover`)).rejects.toThrow();
    }
  });

  it('takes over with a guard that is never empty and leaves no draft behind', async () => {
    const path = join(await mkdtemp(join(dir, 'guard-')), 'model.gguf');
    await writeFile(`${path}.lock`, '{}');
    await age(`${path}.lock`, LOCK_STALE_MS + 5_000);
    // A guard that cannot be written blocks only the takeover that failed, not the next one.
    await chmod(dirname(path), 0o555);
    try {
      if (process.platform !== 'win32' && process.getuid?.() !== 0)
        await expect(lockFile(path, 'test')).rejects.toMatchObject({ name: 'RuntimeStorageError' });
    } finally {
      await chmod(dirname(path), 0o755);
    }
    await (await lockFile(path, 'test')).release();
    const left = (await readdir(dirname(path))).filter(name => name.startsWith(`${basename(path)}.lock.`));
    expect(left).toEqual([]);
  });

  it('takes over without hard links, as on FAT32 and exFAT', async () => {
    const noLinks = Object.assign(new Error('operation not permitted, link'), { code: 'EPERM' });
    vi.mocked(link).mockRejectedValue(noLinks);
    try {
      const path = join(await mkdtemp(join(dir, 'fat-')), 'model.gguf');
      await writeFile(`${path}.lock`, '{}');
      await writeFile(`${path}.lock.takeover`, '');
      await age(`${path}.lock`, LOCK_STALE_MS + 5_000);
      await age(`${path}.lock.takeover`, LOCK_STALE_MS + 5_000);
      const lock = await lockFile(path, 'test');
      expect(JSON.parse(await readFile(`${path}.lock`, 'utf8'))).toMatchObject({ pid: process.pid });
      await lock.release();
      expect(await readdir(dirname(path))).toEqual([]);
      expect(vi.mocked(link)).toHaveBeenCalled();
    } finally {
      vi.mocked(link).mockReset();
      vi.mocked(link).mockImplementation(
        (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).link
      );
    }
  });

  it('reports a directory that does not exist as a storage error', async () => {
    const error = await lockFile(join(dir, 'missing', 'x.gguf'), 'test').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeStorageError);
    expect(error).toMatchObject({ code: 'ENOENT', operation: 'write' });
  });
});

describe('onDisk', () => {
  it('wraps errno failures with the failing path and operation, and passes other errors through', async () => {
    const absent = join(dir, 'absent');
    await expect(onDisk('test', '/x', () => readFile(absent), 'read')).rejects.toMatchObject({
      name: 'RuntimeStorageError',
      code: 'ENOENT',
      path: absent,
      operation: 'read',
      message: expect.stringMatching(/^test could not read /),
    });
    const plain = new Error('plain');
    await expect(
      onDisk('test', '/x', async () => {
        throw plain;
      })
    ).rejects.toBe(plain);
  });
});
