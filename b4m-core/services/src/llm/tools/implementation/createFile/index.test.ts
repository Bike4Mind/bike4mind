import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createFileTool } from './index';

const logger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };

function createTool(allowedDirectories: string[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the tool reads only logger and allowedDirectories
  return createFileTool.implementation({ logger, allowedDirectories } as any);
}

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop() as string, { recursive: true, force: true });
});

describe('createFile', () => {
  it('creates a file inside an allowed directory', async () => {
    const allowed = await mkdtemp(join(tmpdir(), 'b4m-create-'));
    dirs.push(allowed);
    await createTool([allowed]).toolFn({ path: join(allowed, 'a.txt'), content: 'hi' });
    expect(await readFile(join(allowed, 'a.txt'), 'utf8')).toBe('hi');
  });

  it('refuses to overwrite .git/config and leaves it unchanged', async () => {
    const allowed = await mkdtemp(join(tmpdir(), 'b4m-create-'));
    dirs.push(allowed);
    await mkdir(join(allowed, '.git'));
    await writeFile(join(allowed, '.git', 'config'), 'original');

    await expect(
      createTool([allowed]).toolFn({ path: join(allowed, '.git', 'config'), content: 'replaced' })
    ).rejects.toThrow(/inside a \.git directory/);
    expect(await readFile(join(allowed, '.git', 'config'), 'utf8')).toBe('original');
  });

  it('refuses to create a new hook file', async () => {
    const allowed = await mkdtemp(join(tmpdir(), 'b4m-create-'));
    dirs.push(allowed);
    const hook = join(allowed, '.git', 'hooks', 'pre-commit');

    await expect(createTool([allowed]).toolFn({ path: hook, content: 'x' })).rejects.toThrow(
      /inside a \.git directory/
    );
    expect(existsSync(hook)).toBe(false);
  });
});
