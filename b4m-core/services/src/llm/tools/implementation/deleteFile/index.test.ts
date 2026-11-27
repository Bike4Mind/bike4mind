import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { deleteFileTool } from './index';

const logger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };

function deleteTool(allowedDirectories: string[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the tool reads only logger and allowedDirectories
  return deleteFileTool.implementation({ logger, allowedDirectories } as any);
}

const dirs: string[] = [];
async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'b4m-delete-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop() as string, { recursive: true, force: true });
});

describe('deleteFile', () => {
  it('deletes a directory tree without a git directory', async () => {
    const allowed = await freshDir();
    await mkdir(join(allowed, 'build', 'nested'), { recursive: true });
    await writeFile(join(allowed, 'build', 'nested', 'out.js'), '');

    await deleteTool([allowed]).toolFn({ path: join(allowed, 'build'), recursive: true });
    expect(existsSync(join(allowed, 'build'))).toBe(false);
  });

  it('refuses to delete .git/config', async () => {
    const allowed = await freshDir();
    await mkdir(join(allowed, '.git'));
    await writeFile(join(allowed, '.git', 'config'), '');

    await expect(deleteTool([allowed]).toolFn({ path: join(allowed, '.git', 'config') })).rejects.toThrow(
      /inside a \.git directory/
    );
    expect(existsSync(join(allowed, '.git', 'config'))).toBe(true);
  });

  it('refuses to recursively delete a directory that contains a git directory', async () => {
    const allowed = await freshDir();
    const vendored = join(allowed, 'vendor', 'lib');
    await mkdir(join(vendored, '.git'), { recursive: true });
    await writeFile(join(vendored, '.git', 'config'), '');

    await expect(deleteTool([allowed]).toolFn({ path: join(allowed, 'vendor'), recursive: true })).rejects.toThrow(
      /contains a \.git directory/
    );
    expect(existsSync(join(vendored, '.git', 'config'))).toBe(true);
  });
});
