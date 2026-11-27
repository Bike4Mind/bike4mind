import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadHostId } from './hostIdentity';

const linkSpy = vi.hoisted(() => ({ reject: null as Error | null }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: (...args: Parameters<typeof actual.link>) =>
      linkSpy.reject ? Promise.reject(linkSpy.reject) : actual.link(...args),
  };
});

const directories: string[] = [];
const dataDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'b4m-host-id-'));
  directories.push(directory);
  return directory;
};

afterEach(async () => {
  linkSpy.reject = null;
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('loadHostId', () => {
  it('still makes the id where the filesystem has no hard links, leaving no temp file', async () => {
    const directory = await dataDirectory();
    linkSpy.reject = Object.assign(new Error('not supported'), { code: 'ENOTSUP' });

    const id = await loadHostId(directory);

    expect(await loadHostId(directory)).toBe(id);
    expect(await readdir(directory)).toEqual(['host-id']);
  });

  it('makes a random UUID once and returns the same one after a restart', async () => {
    const directory = await dataDirectory();

    const first = await loadHostId(directory);
    const again = await loadHostId(directory);

    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(again).toBe(first);
    expect((await readFile(join(directory, 'host-id'), 'utf8')).trim()).toBe(first);
  });

  it('keeps the file owner-only, tightening one left looser', async () => {
    const directory = await dataDirectory();
    const id = await loadHostId(directory);
    expect((await stat(join(directory, 'host-id'))).mode & 0o777).toBe(0o600);

    await writeFile(join(directory, 'host-id'), id, { mode: 0o644 });
    await chmod(join(directory, 'host-id'), 0o644);
    await loadHostId(directory);

    expect((await stat(join(directory, 'host-id'))).mode & 0o777).toBe(0o600);
  });

  it('gives every concurrent caller the one id that was written', async () => {
    const directory = await dataDirectory();

    const ids = await Promise.all(Array.from({ length: 8 }, () => loadHostId(directory)));

    expect(new Set(ids).size).toBe(1);
  });

  it('leaves only the id file behind, never a half-written one or a temp copy', async () => {
    const directory = await dataDirectory();

    await Promise.all(Array.from({ length: 8 }, () => loadHostId(directory)));

    expect(await readdir(directory)).toEqual(['host-id']);
  });

  it('surfaces a read error other than a missing file', async () => {
    const directory = await dataDirectory();
    await mkdir(join(directory, 'host-id'));

    await expect(loadHostId(directory)).rejects.toThrow(/EISDIR/);
  });

  it('refuses a file that does not hold an id rather than replacing it', async () => {
    const directory = await dataDirectory();
    await writeFile(join(directory, 'host-id'), 'not-an-id');

    await expect(loadHostId(directory)).rejects.toThrow(/does not hold a host id/);
  });
});
