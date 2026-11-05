import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { permissionProtectedRoots, toolProtectedPaths } from './protectedLocations';

async function linked() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'b4m-protected-')));
  await mkdir(join(base, 'config', 'App'), { recursive: true });
  await mkdir(join(base, 'home', '.claude'), { recursive: true });
  await symlink(join(base, 'config'), join(base, 'cfg-link'));
  return { base, userData: join(base, 'cfg-link', 'App'), real: join(base, 'config', 'App') };
}

describe('protected locations', () => {
  it('lists the permission roots under their real paths as well as their given ones', async () => {
    const { base, userData, real } = await linked();
    const roots = permissionProtectedRoots(userData, join(base, 'home'), join(base, 'managed'));
    expect(roots).toEqual([userData, real, join(base, 'home', '.claude'), join(base, 'managed')]);
  });

  it('lists the tool-protected path under its real path as well as its given one', async () => {
    const { userData, real } = await linked();
    expect(toolProtectedPaths(userData)).toEqual([userData, real]);
  });

  it('protects the whole volume when a protected location cannot be resolved', async () => {
    const { base, userData } = await linked();
    const native = realpathSync.native;
    const spy = vi.spyOn(realpathSync, 'native').mockImplementation((path, options) => {
      if (String(path).startsWith(join(base, 'cfg-link'))) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return native(path, options);
    });
    try {
      expect(toolProtectedPaths(userData)).toEqual([userData, '/']);
      expect(permissionProtectedRoots(userData, join(base, 'home'), join(base, 'managed'))).toContain('/');
    } finally {
      spy.mockRestore();
    }
  });
});
