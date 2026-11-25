import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadHostId } from './hostIdentity';

const dataDirectory = () => mkdtemp(join(tmpdir(), 'b4m-host-id-'));

describe('loadHostId', () => {
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
    const { chmod } = await import('node:fs/promises');
    await chmod(join(directory, 'host-id'), 0o644);
    await loadHostId(directory);

    expect((await stat(join(directory, 'host-id'))).mode & 0o777).toBe(0o600);
  });

  it('gives every concurrent caller the one id that was written', async () => {
    const directory = await dataDirectory();

    const ids = await Promise.all(Array.from({ length: 8 }, () => loadHostId(directory)));

    expect(new Set(ids).size).toBe(1);
  });

  it('refuses a file that does not hold an id rather than replacing it', async () => {
    const directory = await dataDirectory();
    await writeFile(join(directory, 'host-id'), 'not-an-id');

    await expect(loadHostId(directory)).rejects.toThrow(/does not hold a host id/);
  });
});
