import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { permissionProtectedLocations, toolProtectedLocations } from './protectedLocations';

async function linked() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'b4m-protected-')));
  await mkdir(join(base, 'config', 'App'), { recursive: true });
  await mkdir(join(base, 'home', '.claude'), { recursive: true });
  await symlink(join(base, 'config'), join(base, 'cfg-link'));
  return { base, userData: join(base, 'cfg-link', 'App'), real: join(base, 'config', 'App') };
}

const logger = () => ({ warn: vi.fn() });

/** Makes every resolution under `prefix` fail with EACCES until the returned restore is called. */
function denyUnder(prefix: string) {
  const native = realpathSync.native;
  const spy = vi.spyOn(realpathSync, 'native').mockImplementation((path, options) => {
    if (String(path).startsWith(prefix)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return native(path, options);
  });
  return () => spy.mockRestore();
}

describe('protected locations', () => {
  it('lists the permission roots under their real paths as well as their given ones', async () => {
    const { base, userData, real } = await linked();
    const roots = permissionProtectedLocations(userData, join(base, 'home'), join(base, 'managed'), logger()).paths();
    expect(roots).toEqual([userData, real, join(base, 'home', '.claude'), join(base, 'managed')]);
  });

  it('lists the tool-protected path under its real path as well as its given one', async () => {
    const { userData, real } = await linked();
    const locations = toolProtectedLocations(userData, logger());
    expect(locations.paths()).toEqual([userData, real]);
    expect(locations.unresolved()).toEqual([]);
  });

  it('keeps an unresolvable location to the spellings it has, and retries it until it resolves', async () => {
    const { base, userData, real } = await linked();
    const log = logger();
    const locations = toolProtectedLocations(userData, log);
    const restore = denyUnder(join(base, 'cfg-link'));
    try {
      expect(locations.unresolved()).toEqual([userData]);
      expect(locations.paths()).toEqual([userData]);
      expect(locations.unresolved()).toEqual([userData]);
    } finally {
      restore();
    }
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toContain(userData);

    expect(locations.unresolved()).toEqual([]);
    expect(locations.paths()).toEqual([userData, real]);
  });

  it('keeps a resolution once it has one', async () => {
    const { base, userData, real } = await linked();
    const locations = toolProtectedLocations(userData, logger());
    const first = locations.paths();
    const restore = denyUnder(join(base, 'cfg-link'));
    try {
      expect(locations.paths()).toBe(first);
      expect(locations.unresolved()).toEqual([]);
    } finally {
      restore();
    }
    expect(first).toEqual([userData, real]);
  });

  it('never protects a volume root for the permission roots either', async () => {
    const { base, userData } = await linked();
    const locations = permissionProtectedLocations(userData, join(base, 'home'), join(base, 'managed'), logger());
    const restore = denyUnder(join(base, 'cfg-link'));
    try {
      expect(locations.paths()).not.toContain('/');
      expect(locations.paths()).toContain(join(base, 'home', '.claude'));
      expect(locations.unresolved()).toEqual([userData]);
    } finally {
      restore();
    }
  });
});
