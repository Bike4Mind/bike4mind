import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { privateFile } from './privateFile';

describe('privateFile', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'private-file-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('treats a missing file as absent', async () => {
    expect(await privateFile(join(directory, 'missing.json')).read()).toBeNull();
  });

  it('propagates read failures instead of pretending credentials are absent', async () => {
    const path = join(directory, 'not-a-file');
    await mkdir(path);
    await expect(privateFile(path).read()).rejects.toThrow();
  });

  it('replaces the document atomically with owner-only permissions', async () => {
    const path = join(directory, 'nested', 'secret.json');
    const file = privateFile(path);
    await file.write('first');
    await file.write('replacement');
    expect(await readFile(path, 'utf8')).toBe('replacement');
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(stat(`${path}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
