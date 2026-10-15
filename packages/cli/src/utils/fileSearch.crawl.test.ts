/**
 * The project crawl behind `@` completion: gitignore rules must match the way git
 * applies them, the entry cap must bound the listing (not be spent on ignored
 * entries), and trees that are never wanted are skipped whatever .gitignore says.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { invalidateFileCache, searchFiles, walkDirectory } from './fileSearch.js';

describe('walkDirectory - project crawl', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'b4m-crawl-'));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  async function touch(...relativePaths: string[]): Promise<void> {
    for (const relativePath of relativePaths) {
      const fullPath = path.join(dir, relativePath);
      await fsp.mkdir(path.dirname(fullPath), { recursive: true });
      await fsp.writeFile(fullPath, '');
    }
  }

  const crawledPaths = async (maxEntries?: number) =>
    (await walkDirectory(dir, undefined, maxEntries)).map(entry => entry.path).sort();

  it('applies a root-anchored rule only at the root, not to nested folders of the same name', async () => {
    await fsp.writeFile(path.join(dir, '.gitignore'), '/build\n');
    await touch('build/out.js', 'src/build/keep.ts');

    const paths = await crawledPaths();

    expect(paths).toContain('src/build/keep.ts');
    expect(paths).not.toContain('build/');
    expect(paths).not.toContain('build/out.js');
  });

  it('prunes an unanchored directory rule at every depth', async () => {
    await fsp.writeFile(path.join(dir, '.gitignore'), 'dist/\n*.log\n');
    await touch('dist/a.js', 'pkg/dist/b.js', 'pkg/src/c.ts', 'pkg/debug.log');

    expect(await crawledPaths()).toEqual(['.gitignore', 'pkg/', 'pkg/src/', 'pkg/src/c.ts']);
  });

  it('does not spend the entry cap on ignored files', async () => {
    await fsp.writeFile(path.join(dir, '.gitignore'), '*.log\n');
    await touch(...Array.from({ length: 50 }, (_, i) => `noise-${i}.log`), 'a.ts', 'b.ts');

    expect(await crawledPaths(3)).toEqual(['.gitignore', 'a.ts', 'b.ts']);
  });

  it('stops at the entry cap', async () => {
    await touch(...Array.from({ length: 20 }, (_, i) => `file-${i}.ts`));

    expect(await crawledPaths(5)).toHaveLength(5);
  });

  it('skips VCS internals, dependencies and nested worktrees without a .gitignore', async () => {
    await touch(
      '.git/HEAD',
      'node_modules/dep/index.js',
      'pkg/node_modules/dep/index.js',
      '.claude/worktrees/feature/src/copy.ts',
      '.claude/settings.json',
      'src/index.ts'
    );

    expect(await crawledPaths()).toEqual(['.claude/', '.claude/settings.json', 'pkg/', 'src/', 'src/index.ts']);
  });

  it('never lists the project root itself', async () => {
    await touch('a.ts');

    expect(await crawledPaths()).toEqual(['a.ts']);
  });
});

describe('searchFiles - cached project listing', () => {
  let first: string;
  let second: string;

  beforeEach(async () => {
    first = await fsp.mkdtemp(path.join(os.tmpdir(), 'b4m-crawl-first-'));
    second = await fsp.mkdtemp(path.join(os.tmpdir(), 'b4m-crawl-second-'));
    await fsp.writeFile(path.join(first, 'alpha.ts'), '');
    await fsp.writeFile(path.join(second, 'beta.ts'), '');
    invalidateFileCache();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    invalidateFileCache();
    await fsp.rm(first, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(second, { recursive: true, force: true }).catch(() => {});
  });

  const names = (results: Awaited<ReturnType<typeof searchFiles>>) => results.map(r => r.path);

  it('answers concurrent searches that share one in-flight crawl', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(first);

    const [a, b] = await Promise.all([searchFiles('alpha'), searchFiles('alpha')]);

    expect(names(a)).toEqual(['alpha.ts']);
    expect(names(b)).toEqual(['alpha.ts']);
  });

  it('does not serve one project root from another root cache', async () => {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(first);
    expect(names(await searchFiles(''))).toEqual(['alpha.ts']);

    cwd.mockReturnValue(second);
    expect(names(await searchFiles(''))).toEqual(['beta.ts']);
  });

  it('picks up new files after invalidation', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(first);
    expect(names(await searchFiles(''))).toEqual(['alpha.ts']);

    await fsp.writeFile(path.join(first, 'gamma.ts'), '');
    expect(names(await searchFiles(''))).toEqual(['alpha.ts']);

    invalidateFileCache();
    expect(names(await searchFiles('')).sort()).toEqual(['alpha.ts', 'gamma.ts']);
  });
});
