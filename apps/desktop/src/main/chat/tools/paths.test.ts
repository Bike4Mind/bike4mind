import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PathAccessDenied,
  resolveWithinRoots,
  resolveWithinRootsPhysically,
  withinGuarded,
  realpathSyncNearest,
  withRealPath,
} from './paths';

describe('resolveWithinRoots', () => {
  let base: string;
  let granted: string;

  beforeEach(async () => {
    // realpath because macOS puts tmpdir behind /private, and a root that is itself a symlink
    // would otherwise make every comparison here test the wrong thing.
    base = await realpath(await mkdtemp(join(tmpdir(), 'b4m-paths-')));
    granted = join(base, 'granted');
    await mkdir(granted, { recursive: true });
  });

  it('denies everything when no folder has been granted', async () => {
    await expect(resolveWithinRoots(join(granted, 'a.txt'), [])).rejects.toBeInstanceOf(PathAccessDenied);
  });

  it('allows a file inside a granted root', async () => {
    const file = join(granted, 'a.txt');
    await writeFile(file, 'hi', 'utf8');
    await expect(resolveWithinRoots(file, [granted])).resolves.toBe(file);
  });

  it('allows the granted root itself', async () => {
    await expect(resolveWithinRoots(granted, [granted])).resolves.toBe(granted);
  });

  it('allows a path that does not exist yet, so a file can be created inside a root', async () => {
    const target = join(granted, 'nested', 'new.txt');
    await expect(resolveWithinRoots(target, [granted])).resolves.toBe(target);
  });

  // writeFile follows a dangling link to create its target, so the target is what must be inside.
  it('denies a dangling symlink that points outside every root', async () => {
    const link = join(granted, 'later.txt');
    await symlink(join(base, 'outside', 'new.txt'), link);
    await expect(resolveWithinRoots(link, [granted])).rejects.toBeInstanceOf(PathAccessDenied);
  });

  it('resolves symlinks before parent components inside a dangling link target', async () => {
    const outside = join(base, 'outside');
    await mkdir(join(outside, 'child'), { recursive: true });
    await symlink(join(outside, 'child'), join(granted, 'hop'));
    const link = join(granted, 'pending.txt');
    await symlink('hop/../new.txt', link);
    await expect(resolveWithinRoots(link, [granted])).rejects.toBeInstanceOf(PathAccessDenied);
  });

  it('allows a chain of dangling links whose final target stays inside a root', async () => {
    await symlink('new.txt', join(granted, 'middle'));
    const link = join(granted, 'pending.txt');
    await symlink('middle', link);
    await expect(resolveWithinRoots(link, [granted])).resolves.toBe(link);
  });

  it('allows a dangling target with symlink parent traversal that stays inside a root', async () => {
    await mkdir(join(granted, 'nested', 'child'), { recursive: true });
    await symlink(join(granted, 'nested', 'child'), join(granted, 'hop'));
    const link = join(granted, 'pending.txt');
    await symlink('hop/../new.txt', link);
    await expect(resolveWithinRoots(link, [granted])).resolves.toBe(link);
    await writeFile(link, 'inside', 'utf8');
    await expect(realpath(link)).resolves.toBe(join(granted, 'nested', 'new.txt'));
  });

  it('canonicalizes existing parent casing before checking a new file', async () => {
    const directory = join(granted, 'Workspace');
    await mkdir(directory);
    const alternate = join(granted, 'workspace');
    // Case-sensitive volumes correctly treat the alternate spelling as a different directory.
    if ((await realpath(alternate).catch(() => null)) !== directory) return;
    const target = join(alternate, 'new.txt');
    await expect(resolveWithinRoots(target, [directory])).resolves.toBe(target);
  });

  it('denies cyclic symlinks instead of accepting an unresolved path', async () => {
    const link = join(granted, 'cycle');
    await symlink('cycle', link);
    await expect(resolveWithinRoots(link, [granted])).rejects.toBeInstanceOf(PathAccessDenied);
  });

  it('denies a sibling folder that merely shares the granted prefix', async () => {
    const sibling = join(base, 'granted-secret');
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, 'a.txt'), 'no', 'utf8');

    await expect(resolveWithinRoots(join(sibling, 'a.txt'), [granted])).rejects.toBeInstanceOf(PathAccessDenied);
  });

  it('denies a traversal out of the root', async () => {
    await expect(resolveWithinRoots(join(granted, '..', 'escape.txt'), [granted])).rejects.toBeInstanceOf(
      PathAccessDenied
    );
  });

  // The lexical check alone passes here, which is exactly why realpath resolution exists.
  it('denies a symlink inside the root that points outside it', async () => {
    const outside = join(base, 'outside.txt');
    await writeFile(outside, 'secret', 'utf8');
    const link = join(granted, 'link.txt');
    await symlink(outside, link);

    await expect(resolveWithinRoots(link, [granted])).rejects.toBeInstanceOf(PathAccessDenied);
  });

  it('allows a symlink that stays inside the root', async () => {
    const real = join(granted, 'real.txt');
    await writeFile(real, 'fine', 'utf8');
    const link = join(granted, 'link.txt');
    await symlink(real, link);

    await expect(resolveWithinRoots(link, [granted])).resolves.toBe(link);
  });

  it('accepts a path under any one of several granted roots', async () => {
    const second = join(base, 'second');
    await mkdir(second, { recursive: true });
    const file = join(second, 'b.txt');
    await writeFile(file, 'hi', 'utf8');

    await expect(resolveWithinRoots(file, [granted, second])).resolves.toBe(file);
  });

  it('names only the requested path, never what exists behind the denial', async () => {
    const error = await resolveWithinRoots('/etc/passwd', [granted]).then(
      () => null,
      (err: unknown) => err as Error
    );
    expect(error?.message).toContain('/etc/passwd');
    expect(error?.message).not.toContain(granted);
  });
});

/**
 * The resolver for paths the KERNEL will walk rather than ones the caller will open. The pair
 * below is the whole difference: `path.resolve` applies `..` to the name on its left, and the
 * kernel applies it to whatever the components before it resolved to.
 */
describe('resolveWithinRootsPhysically', () => {
  let base: string;
  let granted: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'b4m-physical-')));
    granted = join(base, 'granted');
    await mkdir(join(granted, 'sub'), { recursive: true });
    await writeFile(join(granted, 'in.txt'), 'hi', 'utf8');
    await writeFile(join(base, 'out.txt'), 'secret', 'utf8');
    await symlink(granted, join(granted, 'self'));
  });

  it('allows a path inside a granted root', async () => {
    await expect(resolveWithinRootsPhysically('in.txt', [granted], granted)).resolves.toBe(join(granted, 'in.txt'));
  });

  it('allows a dot-dot that stays inside once resolved', async () => {
    await expect(resolveWithinRootsPhysically('../in.txt', [granted], join(granted, 'sub'))).resolves.toBe(
      join(granted, 'in.txt')
    );
  });

  it('denies a dot-dot that leaves the root through a link back to it', async () => {
    await expect(resolveWithinRootsPhysically('self/../out.txt', [granted], granted)).rejects.toBeInstanceOf(
      PathAccessDenied
    );
  });

  /** The lexical resolver is the one that gets this wrong, and is left alone for its own callers. */
  it('is the case path.resolve reads the other way', async () => {
    await expect(resolveWithinRoots('self/../out.txt', [granted], granted)).resolves.toBe(join(granted, 'out.txt'));
  });

  it('follows a link into the root rather than refusing it', async () => {
    await expect(resolveWithinRootsPhysically('self/in.txt', [granted], granted)).resolves.toBe(
      join(granted, 'in.txt')
    );
  });

  /** Nothing can hide under a name that does not exist, so the rest is appended as written. */
  it('resolves a path that does not exist yet against its nearest real ancestor', async () => {
    await expect(resolveWithinRootsPhysically('sub/new/deeper.txt', [granted], granted)).resolves.toBe(
      join(granted, 'sub', 'new', 'deeper.txt')
    );
  });

  it('denies everything when no folder has been granted', async () => {
    await expect(resolveWithinRootsPhysically('in.txt', [], granted)).rejects.toBeInstanceOf(PathAccessDenied);
  });
});

describe('withinGuarded', () => {
  const APP = 'C:\\Users\\me\\AppData\\Roaming\\App';

  it('on Windows, reads a WSL /mnt/<x> share path as its drive path, ignoring case', () => {
    for (const path of [
      '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\me\\AppData\\Roaming\\App\\vault.json',
      '\\\\wsl$\\Ubuntu\\mnt\\c\\Users\\me\\AppData\\Roaming\\App',
      '\\\\wsl.localhost\\Ubuntu\\mnt\\C\\users\\me\\appdata\\roaming\\app\\x',
      'c:/users/me/appdata/roaming/app/x',
    ]) {
      expect(withinGuarded([APP], ['/elsewhere', path], 'win32')).toBe(true);
    }
    expect(withinGuarded([APP], ['\\\\wsl.localhost\\Ubuntu\\home\\me\\AppData\\Roaming\\App'], 'win32')).toBe(false);
    expect(
      withinGuarded([APP], ['\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\me\\AppData\\Roaming\\App2'], 'win32')
    ).toBe(false);
  });

  it('maps nothing and keeps case elsewhere', () => {
    expect(withinGuarded([APP], ['\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\me\\AppData\\Roaming\\App'], 'linux')).toBe(
      false
    );
    expect(withinGuarded(['/home/me/App'], ['/home/me/App/x'], 'linux')).toBe(true);
    expect(withinGuarded(['/home/me/App'], ['/home/me/app/x'], 'linux')).toBe(false);
    expect(withinGuarded(['/Users/me/App'], ['/users/me/app/x'], 'darwin')).toBe(true);
  });
});

describe('withRealPath', () => {
  it('adds the real path when the given one runs through a symlink, and only then', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'b4m-paths-')));
    await mkdir(join(base, 'config', 'App'), { recursive: true });
    await symlink(join(base, 'config'), join(base, 'cfg-link'));

    expect(withRealPath(join(base, 'cfg-link', 'App'))).toEqual([
      join(base, 'cfg-link', 'App'),
      join(base, 'config', 'App'),
    ]);
    expect(withRealPath(join(base, 'config', 'App'))).toEqual([join(base, 'config', 'App')]);
    expect(withRealPath(join(base, 'missing'))).toEqual([join(base, 'missing')]);
    expect(withRealPath(join(base, 'cfg-link', 'new', 'file'))).toEqual([
      join(base, 'cfg-link', 'new', 'file'),
      join(base, 'config', 'new', 'file'),
    ]);
  });
});

describe('realpathSyncNearest', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns null when resolution fails for a reason other than a missing path', () => {
    vi.spyOn(realpathSync, 'native').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    expect(realpathSyncNearest(join(tmpdir(), 'a', 'b'))).toBeNull();
    expect(withRealPath(join(tmpdir(), 'a', 'b'))).toEqual([join(tmpdir(), 'a', 'b')]);
  });

  it('walks up past a component over 255 characters and a NUL-containing name', () => {
    const base = join(tmpdir(), 'b4m-missing-codes');
    const native = realpathSync.native;
    const toolong = 'x'.repeat(256);
    vi.spyOn(realpathSync, 'native').mockImplementation((path, options) => {
      const text = String(path);
      if (text.includes(toolong)) throw Object.assign(new Error('long'), { code: 'ENAMETOOLONG' });
      if (text.includes('\0')) throw Object.assign(new Error('nul'), { code: 'ERR_INVALID_ARG_VALUE' });
      return native(path, options);
    });
    const long = join(tmpdir(), toolong, 'x');
    expect(realpathSyncNearest(long)).toBe(join(native(tmpdir()), toolong, 'x'));
    expect(realpathSyncNearest(`${base}\0x`)).toBe(join(native(tmpdir()), 'b4m-missing-codes\0x'));
  });

  it('walks up past a multibyte component under 255 units but over 255 bytes on POSIX', () => {
    const native = realpathSync.native;
    const wide = '中'.repeat(100);
    vi.spyOn(realpathSync, 'native').mockImplementation((path, options) => {
      if (String(path).includes(wide)) throw Object.assign(new Error('long'), { code: 'ENAMETOOLONG' });
      return native(path, options);
    });
    expect(realpathSyncNearest(join(tmpdir(), wide, 'x'))).toBe(join(native(tmpdir()), wide, 'x'));
  });

  it('counts UTF-16 units on win32, so the same multibyte component is not skipped', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const native = realpathSync.native;
      const wide = '中'.repeat(100);
      vi.spyOn(realpathSync, 'native').mockImplementation((path, options) => {
        if (String(path).includes(wide)) throw Object.assign(new Error('long'), { code: 'ENAMETOOLONG' });
        return native(path, options);
      });
      expect(realpathSyncNearest(join(tmpdir(), wide, 'x'))).toBeNull();
    } finally {
      Object.defineProperty(process, 'platform', platform!);
    }
  });

  it('keeps backslashes inside a POSIX component when measuring it', () => {
    const native = realpathSync.native;
    const name = 'ab\\'.repeat(100);
    vi.spyOn(realpathSync, 'native').mockImplementation((path, options) => {
      if (String(path).includes(name)) throw Object.assign(new Error('long'), { code: 'ENAMETOOLONG' });
      return native(path, options);
    });
    expect(realpathSyncNearest(join(tmpdir(), name, 'x'))).toBe(join(native(tmpdir()), name, 'x'));
  });

  it('follows a dangling link past PATH_MAX reached through links that shrink the path', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'b4m-paths-')));
    const loop = 'L'.repeat(250);
    await mkdir(join(base, 'prot'));
    await symlink('.', join(base, loop));
    await symlink(join('prot', 'new'), join(base, 'dang'));
    const long = join(base, ...Array.from({ length: 17 }, () => loop), 'dang');
    expect(Buffer.byteLength(long)).toBeGreaterThan(4096);
    expect(realpathSyncNearest(long)).toBe(join(base, 'prot', 'new'));
    expect(withRealPath(long)).toEqual([long, join(base, 'prot', 'new')]);
  });

  it('returns null on ENAMETOOLONG from total length with short components', () => {
    const native = realpathSync.native;
    const deep = join(tmpdir(), ...Array.from({ length: 40 }, () => 'd'.repeat(100)));
    vi.spyOn(realpathSync, 'native').mockImplementation((path, options) => {
      if (String(path).length > 1000) throw Object.assign(new Error('long'), { code: 'ENAMETOOLONG' });
      return native(path, options);
    });
    expect(realpathSyncNearest(deep)).toBeNull();
    expect(withRealPath(deep)).toEqual([deep]);
  });

  it('retries with the JS realpath on win32 when native throws EISDIR', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      vi.spyOn(realpathSync, 'native').mockImplementation(() => {
        throw Object.assign(new Error('is a directory'), { code: 'EISDIR' });
      });
      expect(realpathSyncNearest(tmpdir())).toBe(realpathSync(tmpdir()));
    } finally {
      Object.defineProperty(process, 'platform', platform!);
    }
  });

  it('still returns null on EISDIR off win32', () => {
    vi.spyOn(realpathSync, 'native').mockImplementation(() => {
      throw Object.assign(new Error('is a directory'), { code: 'EISDIR' });
    });
    expect(realpathSyncNearest(tmpdir())).toBeNull();
  });

  it('returns null when a missing path sits under a parent that cannot be resolved', () => {
    const native = realpathSync.native;
    const locked = join(tmpdir(), 'locked');
    vi.spyOn(realpathSync, 'native').mockImplementation((path, options) => {
      if (String(path) === locked) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      if (String(path).startsWith(locked)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return native(path, options);
    });
    expect(realpathSyncNearest(join(locked, 'new', 'file'))).toBeNull();
  });

  it('returns null for a symlink loop', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'b4m-paths-')));
    await symlink(join(base, 'loop-a'), join(base, 'loop-b'));
    await symlink(join(base, 'loop-b'), join(base, 'loop-a'));
    expect(realpathSyncNearest(join(base, 'loop-a', 'x'))).toBeNull();
    expect(realpathSyncNearest(join(base, 'missing', 'x'))).toBe(join(base, 'missing', 'x'));
  });
});
