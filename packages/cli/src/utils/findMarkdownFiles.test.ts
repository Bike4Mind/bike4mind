import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { findMarkdownFiles } from './findMarkdownFiles.js';

describe('findMarkdownFiles', () => {
  let root: string;
  let store: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'find-md-'));
    store = await fs.mkdtemp(path.join(os.tmpdir(), 'find-md-store-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(store, { recursive: true, force: true });
  });

  it('finds plain .md files recursively and ignores other extensions', async () => {
    await fs.mkdir(path.join(root, 'nested'));
    await fs.writeFile(path.join(root, 'top.md'), 'top');
    await fs.writeFile(path.join(root, 'nested', 'deep.md'), 'deep');
    await fs.writeFile(path.join(root, 'notes.txt'), 'ignored');

    const found = await findMarkdownFiles(root);

    expect(found.sort()).toEqual([path.join(root, 'nested', 'deep.md'), path.join(root, 'top.md')].sort());
  });

  // The real-world case: nix home-manager / chezmoi symlink SKILL.md into an
  // immutable store, and a Dirent for a symlink is neither file nor directory.
  it('follows a symlinked .md file', async () => {
    const target = path.join(store, 'SKILL.md');
    await fs.writeFile(target, '# skill');
    await fs.mkdir(path.join(root, 'ship'));
    await fs.symlink(target, path.join(root, 'ship', 'SKILL.md'));

    const found = await findMarkdownFiles(root);

    expect(found).toEqual([path.join(root, 'ship', 'SKILL.md')]);
  });

  it('follows a symlinked directory', async () => {
    await fs.writeFile(path.join(store, 'work.md'), '# work');
    await fs.symlink(store, path.join(root, 'linked'));

    const found = await findMarkdownFiles(root);

    expect(found).toEqual([path.join(root, 'linked', 'work.md')]);
  });

  it('skips broken symlinks without throwing', async () => {
    await fs.writeFile(path.join(root, 'real.md'), 'real');
    await fs.symlink(path.join(store, 'gone.md'), path.join(root, 'dangling.md'));

    const found = await findMarkdownFiles(root);

    expect(found).toEqual([path.join(root, 'real.md')]);
  });

  it('terminates on a self-referential directory symlink', async () => {
    await fs.writeFile(path.join(root, 'a.md'), 'a');
    await fs.symlink(root, path.join(root, 'loop'));

    const found = await findMarkdownFiles(root);

    expect(found).toEqual([path.join(root, 'a.md')]);
  });

  it('returns an empty list for a missing directory', async () => {
    const found = await findMarkdownFiles(path.join(root, 'does-not-exist'));

    expect(found).toEqual([]);
  });
});
