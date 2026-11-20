import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gitOutput = vi.hoisted(() => ({ value: '' }));
vi.mock('../project/git', () => ({ git: () => Promise.resolve(gitOutput.value) }));

import { globFiles } from './fileTools';
import type { ToolContext } from './types';

describe('glob_files over a listing it is handed', () => {
  let root: string;
  let context: ToolContext;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-listing-')));
    context = { roots: [root], signal: new AbortController().signal };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('finds folders in a listing spelled with backslashes', async () => {
    gitOutput.value = ['sub\\deep.txt', 'sub\\inner\\a.txt', 'sub\\inner\\b.txt'].join('\0');
    const result = await globFiles.run({ pattern: 'sub', path: root }, context);
    expect(result).toContain('Folders matching sub:\n  sub/ (3 files)');
    await expect(globFiles.run({ pattern: '*', path: root }, context)).resolves.toContain('  sub/ (3 files)');
  });

  it('never lists a folder that lies outside the searched folder', async () => {
    gitOutput.value = ['../out/a.txt', 'in/b.txt'].join('\0');
    const result = await globFiles.run({ pattern: '../out', path: root }, context);
    expect(result).not.toContain('Folders matching');
    expect(result).toContain('No files matched');
  });
});
