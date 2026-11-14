import { mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureScratchDirectory,
  isScratchDirectory,
  removeScratchDirectory,
  scratchDirectory,
} from './scratchDirectory';

describe('scratch directory', () => {
  let temp: string;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'b4m-scratch-test-'));
    vi.stubEnv('TMPDIR', temp);
    vi.stubEnv('TMP', temp);
    vi.stubEnv('TEMP', temp);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(temp, { recursive: true, force: true });
  });

  it('makes a private folder for the session under the physical temp folder, and removes it', async () => {
    const path = await ensureScratchDirectory('session-1');
    expect(path).toBe(join(await realpath(temp), 'b4m-scratch', 'session-1'));
    expect(isScratchDirectory(path as string)).toBe(true);
    if (process.platform !== 'win32') expect((await stat(path as string)).mode & 0o777).toBe(0o700);
    await writeFile(join(path as string, 'migrate.py'), 'print(1)');
    await removeScratchDirectory('session-1');
    await expect(stat(path as string)).rejects.toThrow();
  });

  it('refuses a session id that would leave the scratch folder', async () => {
    expect(scratchDirectory('../x')).toBeNull();
    expect(await ensureScratchDirectory('a/b')).toBeNull();
  });

  it('is not a project folder', () => {
    expect(isScratchDirectory(join(temp, 'repo'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'gives no folder when the scratch parent is a link someone else placed',
    async () => {
      const elsewhere = await mkdtemp(join(temp, 'elsewhere-'));
      const parent = dirname(scratchDirectory('session-2') as string);
      await symlink(elsewhere, parent);
      expect(await ensureScratchDirectory('session-2')).toBeNull();
    }
  );
});
