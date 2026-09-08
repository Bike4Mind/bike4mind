/**
 * Absolute-path listing (the `@`/path-completion source) has to classify symlinked entries
 * by their TARGET.
 *
 * `fs.readdirSync(withFileTypes)` builds each Dirent from the entry itself, so a symlink
 * answers false to both `isDirectory()` and `isFile()`. Left unresolved, a symlinked
 * directory was reported as a file - so completion stopped offering to descend into it -
 * and a symlinked file reported no size. That is the normal on-disk layout wherever a
 * dotfile manager (nix home-manager, chezmoi) materializes paths as links into its store.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { searchFiles } from './fileSearch.js';

describe('searchFiles - symlinked entries in an absolute-path listing', () => {
  let dir: string;
  let store: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'b4m-filesearch-'));
    store = await fsp.mkdtemp(path.join(os.tmpdir(), 'b4m-filesearch-store-'));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(store, { recursive: true, force: true }).catch(() => {});
  });

  const find = (results: Awaited<ReturnType<typeof searchFiles>>, name: string) =>
    results.find(r => path.basename(r.path) === name);

  it('reports a symlinked directory as a directory', async () => {
    await fsp.mkdir(path.join(store, 'real-dir'));
    await fsp.symlink(path.join(store, 'real-dir'), path.join(dir, 'linked-dir'));

    const entry = find(await searchFiles(dir), 'linked-dir');

    expect(entry).toBeDefined();
    // Was false, which is what made path completion refuse to descend into it.
    expect(entry?.isDirectory).toBe(true);
  });

  it('reports a symlinked file as a file, with its size', async () => {
    await fsp.writeFile(path.join(store, 'real.txt'), 'hello world');
    await fsp.symlink(path.join(store, 'real.txt'), path.join(dir, 'linked.txt'));

    const entry = find(await searchFiles(dir), 'linked.txt');

    expect(entry?.isDirectory).toBe(false);
    expect(entry?.size).toBe('hello world'.length);
  });

  it('still lists a broken symlink instead of dropping or crashing on it', async () => {
    await fsp.writeFile(path.join(dir, 'real.txt'), 'x');
    await fsp.symlink(path.join(store, 'gone.txt'), path.join(dir, 'dangling'));

    const results = await searchFiles(dir);

    // A dangling link is still a real directory entry the user can see and type.
    expect(find(results, 'dangling')).toBeDefined();
    expect(find(results, 'dangling')?.isDirectory).toBe(false);
    expect(find(results, 'real.txt')).toBeDefined();
  });

  it('classifies plain files and directories unchanged', async () => {
    await fsp.mkdir(path.join(dir, 'plain-dir'));
    await fsp.writeFile(path.join(dir, 'plain.txt'), 'abc');

    const results = await searchFiles(dir);

    expect(find(results, 'plain-dir')?.isDirectory).toBe(true);
    expect(find(results, 'plain.txt')?.isDirectory).toBe(false);
    expect(find(results, 'plain.txt')?.size).toBe(3);
  });

  it('resolves a symlink that survives a filtered listing', async () => {
    await fsp.mkdir(path.join(store, 'skills'));
    await fsp.symlink(path.join(store, 'skills'), path.join(dir, 'skills'));
    await fsp.writeFile(path.join(dir, 'unrelated.txt'), 'x');

    // Typing a partial name routes through the filter branch, not the whole-dir branch.
    const results = await searchFiles(path.join(dir, 'skil'));

    expect(find(results, 'skills')?.isDirectory).toBe(true);
    expect(find(results, 'unrelated.txt')).toBeUndefined();
  });
});
