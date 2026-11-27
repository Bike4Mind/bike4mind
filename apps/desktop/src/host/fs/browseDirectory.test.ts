import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { browseDirectory } from './browseDirectory';

let home: string;

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'b4m-browse-')));
});

afterEach(async () => {
  await chmod(join(home, 'locked'), 0o755).catch(() => undefined);
  await rm(home, { recursive: true, force: true });
});

const names = (result: Awaited<ReturnType<typeof browseDirectory>>) =>
  result.ok ? result.listing.entries.map(entry => entry.name) : [];

describe('browseDirectory', () => {
  it('lists the sub-directories of home when no path is given, visible ones first', async () => {
    await mkdir(join(home, 'beta'));
    await mkdir(join(home, 'Alpha'));
    await mkdir(join(home, '.config'));
    await writeFile(join(home, 'notes.txt'), 'not listed');

    const result = await browseDirectory(undefined, { homeDirectory: home });

    expect(result).toMatchObject({ ok: true, listing: { path: home, truncated: false } });
    expect(names(result)).toEqual(['Alpha', 'beta', '.config']);
    expect(result.ok && result.listing.entries.find(entry => entry.name === '.config')).toMatchObject({
      isHidden: true,
      path: join(home, '.config'),
    });
  });

  it('reads a nested path, with `~` and relative paths taken from home, and flags repositories', async () => {
    await mkdir(join(home, 'code', 'app', '.git'), { recursive: true });
    await mkdir(join(home, 'code', 'worktree'));
    await writeFile(join(home, 'code', 'worktree', '.git'), 'gitdir: elsewhere');
    await mkdir(join(home, 'code', 'plain'));

    for (const path of [join(home, 'code'), '~/code', 'code']) {
      const result = await browseDirectory(path, { homeDirectory: home });
      expect(result).toMatchObject({ ok: true, listing: { path: join(home, 'code'), parent: home } });
      expect(result.ok && result.listing.entries.map(entry => [entry.name, entry.isGitRepository])).toEqual([
        ['app', true],
        ['plain', false],
        ['worktree', true],
      ]);
    }
  });

  it('reports a missing path and a file as typed failures', async () => {
    await writeFile(join(home, 'file.txt'), 'x');

    await expect(browseDirectory(join(home, 'gone'), { homeDirectory: home })).resolves.toEqual({
      ok: false,
      reason: 'notFound',
      path: join(home, 'gone'),
    });
    await expect(browseDirectory(join(home, 'file.txt'), { homeDirectory: home })).resolves.toMatchObject({
      ok: false,
      reason: 'notDirectory',
    });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports an unreadable directory as permission denied',
    async () => {
      await mkdir(join(home, 'locked'));
      await chmod(join(home, 'locked'), 0o000);

      await expect(browseDirectory(join(home, 'locked'), { homeDirectory: home })).resolves.toMatchObject({
        ok: false,
        reason: 'permissionDenied',
      });
    }
  );

  it('stops at the entry cap and says the listing was cut', async () => {
    await Promise.all(['a', 'b', 'c', 'd'].map(name => mkdir(join(home, name))));

    const result = await browseDirectory(home, { homeDirectory: home, limit: 3 });

    expect(names(result)).toEqual(['a', 'b', 'c']);
    expect(result).toMatchObject({ ok: true, listing: { truncated: true } });
    await expect(browseDirectory(home, { homeDirectory: home, limit: 4 })).resolves.toMatchObject({
      listing: { truncated: false },
    });
  });

  it('follows a symbolic link to a directory, resolves it when browsed, and drops a dangling one', async () => {
    await mkdir(join(home, 'real', 'inside'), { recursive: true });
    await symlink(join(home, 'real'), join(home, 'link'));
    await symlink(join(home, 'missing'), join(home, 'dangling'));

    const listing = await browseDirectory(home, { homeDirectory: home });
    expect(listing.ok && listing.listing.entries.map(entry => [entry.name, entry.isSymlink])).toEqual([
      ['link', true],
      ['real', false],
    ]);

    const through = await browseDirectory(join(home, 'link'), { homeDirectory: home });
    expect(through).toMatchObject({ ok: true, listing: { path: join(home, 'real') } });
    expect(names(through)).toEqual(['inside']);
  });

  it('gives the filesystem root no parent', async () => {
    await expect(browseDirectory('/', { homeDirectory: home, limit: 1 })).resolves.toMatchObject({
      ok: true,
      listing: { path: '/', parent: null },
    });
  });
});
