import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModelFileBusyError, RuntimeStorageError } from './errors';
import { lockFile, onDisk } from './fileLock';

let dir: string;
let count = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'file-lock-test-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const target = () => join(dir, `model-${++count}.gguf`);

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  return child.pid as number;
}

describe('lockFile', () => {
  it('writes the holder into <path>.lock, refuses a second holder, and removes the lock on release', async () => {
    const path = target();
    const lock = await lockFile(path, 'test');
    expect(JSON.parse(await readFile(`${path}.lock`, 'utf8'))).toEqual({ pid: process.pid, host: hostname() });
    const busy = await lockFile(path, 'test').catch((caught: unknown) => caught);
    expect(busy).toBeInstanceOf(ModelFileBusyError);
    expect(busy).toMatchObject({ path, pid: process.pid, runtimeId: 'test' });
    await lock.release();
    await lock.release();
    await expect(stat(`${path}.lock`)).rejects.toThrow();
    await (await lockFile(path, 'test')).release();
  });

  it('takes over a lock left by a process on this host that has died', async () => {
    const path = target();
    await writeFile(`${path}.lock`, JSON.stringify({ pid: deadPid(), host: hostname() }));
    const lock = await lockFile(path, 'test');
    expect(JSON.parse(await readFile(`${path}.lock`, 'utf8'))).toMatchObject({ pid: process.pid });
    await lock.release();
  });

  it('treats a lock from another host as live', async () => {
    const path = target();
    await writeFile(`${path}.lock`, JSON.stringify({ pid: deadPid(), host: `${hostname()}-elsewhere` }));
    await expect(lockFile(path, 'test')).rejects.toBeInstanceOf(ModelFileBusyError);
  });

  it('takes over an unreadable lock only once it is a minute old', async () => {
    const path = target();
    await writeFile(`${path}.lock`, '');
    await expect(lockFile(path, 'test')).rejects.toMatchObject({ name: 'ModelFileBusyError', pid: null });
    const old = new Date(Date.now() - 120_000);
    await utimes(`${path}.lock`, old, old);
    await (await lockFile(path, 'test')).release();
  });

  it('reports a directory that does not exist as a storage error', async () => {
    const error = await lockFile(join(dir, 'missing', 'x.gguf'), 'test').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeStorageError);
    expect(error).toMatchObject({ code: 'ENOENT' });
  });
});

describe('onDisk', () => {
  it('wraps errno failures and passes other errors through', async () => {
    await expect(onDisk('test', '/x', () => readFile(join(dir, 'absent')))).rejects.toMatchObject({
      name: 'RuntimeStorageError',
      code: 'ENOENT',
      path: '/x',
    });
    const plain = new Error('plain');
    await expect(
      onDisk('test', '/x', async () => {
        throw plain;
      })
    ).rejects.toBe(plain);
  });
});
