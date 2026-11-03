import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listDistroFiles = vi.hoisted(() => vi.fn());
const ripgrepSearch = vi.hoisted(() => vi.fn());
vi.mock('./wslFiles', () => ({ listDistroFiles }));
vi.mock('./ripgrep', () => ({ ripgrepSearch }));
vi.mock('../project/git', () => ({ git: () => Promise.reject(new Error('not a repository')) }));

import { globFiles, grepSearch } from './fileTools';
import type { ToolContext } from './types';

describe('file search in a WSL folder without ripgrep or git', () => {
  let root: string;
  let context: ToolContext;

  beforeEach(async () => {
    listDistroFiles.mockReset();
    ripgrepSearch.mockReset().mockResolvedValue('unavailable');
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-wslfiles-')));
    context = { roots: [root], signal: new AbortController().signal };
  });

  it('lists with the distro and takes sizes and times from that listing instead of statting the share', async () => {
    listDistroFiles.mockResolvedValue({
      complete: true,
      files: [
        { path: 'repo-a/readme.md', size: 2048, modified: Date.UTC(2026, 0, 2) },
        { path: 'notes.txt', size: 5, modified: Date.UTC(2026, 0, 3) },
      ],
    });

    const result = await globFiles.run({ pattern: '**/*', path: root }, context);

    expect(listDistroFiles).toHaveBeenCalledWith(root, expect.any(Set), expect.any(Number), context.signal);
    expect(result).toContain('2 file(s)');
    expect(result).toMatch(/2\.0 ?KB\s+2026-01-02\s+repo-a\/readme\.md/);
    expect(result.indexOf('notes.txt')).toBeLessThan(result.indexOf('repo-a/readme.md'));
  });

  it('summarises the top level from the distro listing', async () => {
    listDistroFiles.mockResolvedValue({
      complete: true,
      files: [
        { path: 'repo-a/one.ts', size: 1, modified: 1 },
        { path: 'repo-a/two.ts', size: 1, modified: 1 },
        { path: 'repo-b/three.ts', size: 1, modified: 1 },
      ],
    });

    const result = await globFiles.run({ pattern: '*', path: root }, context);

    expect(result).toContain('Folders:');
    expect(result).toMatch(/repo-a\/.*2/);
    expect(result).toMatch(/repo-b\/.*1/);
  });

  it('says so when the distro list stopped at the limit', async () => {
    listDistroFiles.mockResolvedValue({ complete: false, files: [{ path: 'a.ts', size: 1, modified: 1 }] });
    await expect(globFiles.run({ pattern: '**/*.ts', path: root }, context)).resolves.toContain('Only the first');
  });

  it('walks the folder itself when the distro cannot list it', async () => {
    listDistroFiles.mockResolvedValue(null);
    await writeFile(join(root, 'local.txt'), 'x', 'utf8');
    await expect(globFiles.run({ pattern: '*.txt', path: root }, context)).resolves.toContain('local.txt');
  });

  it('greps the files the distro listed when ripgrep is missing, and no others', async () => {
    await writeFile(join(root, 'listed.txt'), 'needle here\n', 'utf8');
    await writeFile(join(root, 'unlisted.txt'), 'needle here too\n', 'utf8');
    listDistroFiles.mockResolvedValue({ complete: true, files: [{ path: 'listed.txt', size: 12, modified: 1 }] });

    const result = await grepSearch.run({ pattern: 'needle', path: root }, context);

    expect(result).toContain('listed.txt');
    expect(result).not.toContain('unlisted.txt');
  });
});
