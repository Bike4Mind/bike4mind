import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import { PathAccessDenied, resolveWithinRoots, resolveWithinRootsPhysically } from './paths';

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
