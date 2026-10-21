/**
 * The project crawl behind `@` completion: gitignore rules must match the way git
 * applies them, the entry cap must bound the listing (not be spent on ignored
 * entries) and pick the same entries every time, and trees that are never wanted
 * are skipped whatever .gitignore says.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'os';
import path from 'path';
import { crawlDirectory, invalidateFileCache, searchFiles } from './fileSearch.js';

async function touch(root: string, ...relativePaths: string[]): Promise<void> {
  for (const relativePath of relativePaths) {
    const fullPath = path.join(root, relativePath);
    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    await fsp.writeFile(fullPath, '');
  }
}

/** Counts readdir calls per directory, relative to root ('' for root itself). */
function countReaddirs(root: string): Map<string, number> {
  const counts = new Map<string, number>();
  const realReaddir = fs.promises.readdir.bind(fs.promises);
  vi.spyOn(fs.promises, 'readdir').mockImplementation(((dir: fs.PathLike, options: unknown) => {
    const key = path.relative(root, String(dir));
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return realReaddir(dir, options as { withFileTypes: true });
  }) as typeof fs.promises.readdir);
  return counts;
}

describe('crawlDirectory', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'b4m-crawl-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('applies a root-anchored rule only at the root, not to nested folders of the same name', async () => {
    await fsp.writeFile(path.join(dir, '.gitignore'), '/build\n');
    await touch(dir, 'build/out.js', 'src/build/keep.ts');

    const paths = await crawlDirectory(dir);

    expect(paths).toContain('src/build/keep.ts');
    expect(paths).not.toContain('build/');
    expect(paths).not.toContain('build/out.js');
  });

  it('prunes an unanchored directory rule at every depth', async () => {
    await fsp.writeFile(path.join(dir, '.gitignore'), 'dist/\n*.log\n');
    await touch(dir, 'dist/a.js', 'pkg/dist/b.js', 'pkg/src/c.ts', 'pkg/debug.log');

    expect((await crawlDirectory(dir)).sort()).toEqual(['.gitignore', 'pkg/', 'pkg/src/', 'pkg/src/c.ts']);
  });

  it('applies a nested .gitignore relative to its own directory', async () => {
    await touch(dir, 'app/.next/cache.js', 'app/src/page.ts', '.next/root.js');
    await fsp.writeFile(path.join(dir, 'app/.gitignore'), '/.next/\n');

    const paths = await crawlDirectory(dir);

    expect(paths).toContain('app/src/page.ts');
    expect(paths).toContain('.next/root.js');
    expect(paths).not.toContain('app/.next/');
    expect(paths).not.toContain('app/.next/cache.js');
  });

  it('does not spend the entry cap on ignored files', async () => {
    await fsp.writeFile(path.join(dir, '.gitignore'), '*.log\n');
    await touch(dir, ...Array.from({ length: 50 }, (_, i) => `noise-${i}.log`), 'a.ts', 'b.ts');

    expect(await crawlDirectory(dir, { maxEntries: 3 })).toEqual(['.gitignore', 'a.ts', 'b.ts']);
  });

  it('keeps the shallowest entries in name order when capped, every time', async () => {
    await touch(dir, ...Array.from({ length: 8 }, (_, i) => `d${i}/deep/file.ts`), 'z.ts');

    const expected = ['d0/', 'd1/', 'd2/', 'd3/', 'd4/', 'd5/', 'd6/', 'd7/', 'z.ts', 'd0/deep/', 'd1/deep/'];
    for (let run = 0; run < 5; run++) {
      expect(await crawlDirectory(dir, { maxEntries: 11 })).toEqual(expected);
    }
  });

  it('stops reading directories once the cap is reached', async () => {
    // 'a/' is collected before the cap is hit, so only stopping keeps it unread.
    await touch(dir, 'a/deeper/file.ts', 'b.ts', 'c.ts');
    const readdirs = countReaddirs(dir);

    await crawlDirectory(dir, { maxEntries: 2 });

    expect([...readdirs.keys()]).toEqual(['']);
  });

  it('skips VCS internals, dependencies and nested worktrees without a .gitignore', async () => {
    await touch(
      dir,
      '.git/HEAD',
      'node_modules/dep/index.js',
      'pkg/node_modules/dep/index.js',
      '.claude/worktrees/feature/src/copy.ts',
      '.claude/settings.json',
      'src/index.ts'
    );

    expect((await crawlDirectory(dir)).sort()).toEqual([
      '.claude/',
      '.claude/settings.json',
      'pkg/',
      'src/',
      'src/index.ts',
    ]);
  });

  it('skips a .git file, as found in a worktree or submodule', async () => {
    await touch(dir, '.git', 'a.ts');

    expect(await crawlDirectory(dir)).toEqual(['a.ts']);
  });
});

describe('searchFiles - cached project listing', () => {
  let first: string;
  let second: string;

  beforeEach(async () => {
    first = await fsp.mkdtemp(path.join(os.tmpdir(), 'b4m-crawl-first-'));
    second = await fsp.mkdtemp(path.join(os.tmpdir(), 'b4m-crawl-second-'));
    await touch(first, 'alpha.ts');
    await touch(second, 'beta.ts');
    invalidateFileCache();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    invalidateFileCache();
    await fsp.rm(first, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(second, { recursive: true, force: true }).catch(() => {});
  });

  const names = (results: Awaited<ReturnType<typeof searchFiles>>) => results.map(r => r.path);

  it('lists root-level directories and files for an empty query', async () => {
    await touch(first, 'src/index.ts');
    vi.spyOn(process, 'cwd').mockReturnValue(first);

    expect(names(await searchFiles('')).sort()).toEqual(['alpha.ts', 'src/']);
  });

  it('serves concurrent searches from one crawl', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(first);
    const readdirs = countReaddirs(first);

    const [a, b] = await Promise.all([searchFiles('alpha'), searchFiles('alpha')]);

    expect(names(a)).toEqual(['alpha.ts']);
    expect(names(b)).toEqual(['alpha.ts']);
    expect(readdirs.get('')).toBe(1);
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

    await touch(first, 'gamma.ts');
    expect(names(await searchFiles(''))).toEqual(['alpha.ts']);

    invalidateFileCache();
    expect(names(await searchFiles('')).sort()).toEqual(['alpha.ts', 'gamma.ts']);
  });

  it('does not let a crawl superseded by invalidation overwrite the cache', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(first);
    const realReaddir = fs.promises.readdir.bind(fs.promises);
    let releaseStaleCrawl: () => void = () => {};
    const staleCrawlGate = new Promise<void>(resolve => (releaseStaleCrawl = resolve));
    const readdir = vi.spyOn(fs.promises, 'readdir').mockImplementationOnce((async (
      dir: fs.PathLike,
      options: unknown
    ) => {
      const listing = await realReaddir(dir, options as { withFileTypes: true });
      await staleCrawlGate;
      return listing;
    }) as typeof fs.promises.readdir);

    const staleSearch = searchFiles('');
    await vi.waitFor(() => expect(readdir).toHaveBeenCalled());
    invalidateFileCache();
    await touch(first, 'gamma.ts');
    expect(names(await searchFiles('')).sort()).toEqual(['alpha.ts', 'gamma.ts']);

    releaseStaleCrawl();
    expect(names(await staleSearch)).toEqual(['alpha.ts']);
    expect(names(await searchFiles('')).sort()).toEqual(['alpha.ts', 'gamma.ts']);
  });

  it('serves an expired listing while it refreshes in the background', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(first);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    expect(names(await searchFiles(''))).toEqual(['alpha.ts']);

    await touch(first, 'gamma.ts');
    now.mockReturnValue(1_000_000 + 60_000);
    expect(names(await searchFiles(''))).toEqual(['alpha.ts']);

    await vi.waitFor(async () => expect(names(await searchFiles('')).sort()).toEqual(['alpha.ts', 'gamma.ts']));
  });
});
