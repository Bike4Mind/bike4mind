import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { globFilesTool } from './index';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('globFiles', () => {
  let testDir: string;
  let originalCwd: string;

  const mockContext = {
    logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
  };

  beforeAll(async () => {
    originalCwd = process.cwd();
    testDir = await mkdtemp(join(tmpdir(), 'glob-test-'));
    await mkdir(join(testDir, 'src'));
    await writeFile(join(testDir, 'src', 'a.ts'), 'export const a = 1;');
    await writeFile(join(testDir, 'src', 'b.ts'), 'export const b = 2;');
    process.chdir(testDir);
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    await rm(testDir, { recursive: true, force: true });
  });

  it('matches a relative pattern within the working directory', async () => {
    const tool = globFilesTool.implementation(mockContext);
    const result = await tool.toolFn({ pattern: 'src/**/*.ts' });
    expect(result).toContain('a.ts');
    expect(result).toContain('b.ts');
  });

  it('rejects an absolute pattern that would enumerate outside the directory', async () => {
    const tool = globFilesTool.implementation(mockContext);
    await expect(tool.toolFn({ pattern: '/etc/**/*' })).rejects.toThrow('Access denied');
  });

  it('rejects a pattern that climbs out with ..', async () => {
    const tool = globFilesTool.implementation(mockContext);
    await expect(tool.toolFn({ pattern: '../**/*' })).rejects.toThrow('Access denied');
  });
});
