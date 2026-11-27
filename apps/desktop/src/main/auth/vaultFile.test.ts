import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createVaultFile } from './vaultFile';

const POSIX = process.platform !== 'win32';

async function scratchDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vault-file-'));
}

describe('createVaultFile', () => {
  it('reads a missing file as null', async () => {
    const file = createVaultFile(join(await scratchDirectory(), 'auth-vault.json'));
    expect(await file.read()).toBeNull();
  });

  it('creates missing parent directories on write and reads the contents back', async () => {
    const path = join(await scratchDirectory(), 'nested', 'auth-vault.json');
    const file = createVaultFile(path);

    await file.write('{"version":1}');

    expect(await file.read()).toBe('{"version":1}');
  });

  it('replaces the file whole, leaving no temporary file behind', async () => {
    const directory = await scratchDirectory();
    const path = join(directory, 'auth-vault.json');
    const file = createVaultFile(path);

    await file.write('first contents that are longer');
    await file.write('second');

    expect(await readFile(path, 'utf8')).toBe('second');
    expect(await readdir(directory)).toEqual(['auth-vault.json']);
  });

  it.skipIf(!POSIX)('writes the file readable by its owner only, even over a looser existing file', async () => {
    const path = join(await scratchDirectory(), 'auth-vault.json');
    await writeFile(path, 'old', { mode: 0o644 });

    await createVaultFile(path).write('new');

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('surfaces a read failure other than a missing file', async () => {
    const directory = await scratchDirectory();
    // Reading a directory as a file fails with EISDIR, which must not be mistaken for "no vault".
    await expect(createVaultFile(directory).read()).rejects.toThrow();
  });
});
