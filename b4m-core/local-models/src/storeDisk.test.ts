import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseSystemctlShow } from './ollamaInstall';
import { mountFor, parseMountinfo, passwdHome, resolveStorePath, storeDisk } from './storeDisk';

const MOUNTINFO = `22 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw,errors=remount-ro
24 22 0:22 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc rw
61 22 259:1 / /boot/efi rw,relatime shared:31 - vfat /dev/nvme0n1p1 rw
70 22 8:17 / /mnt/model\\040disk rw,relatime shared:40 - xfs /dev/sdb1 rw
71 22 8:33 / /usr/share/ollama/.ollama rw,relatime shared:41 - ext4 /dev/sdc1 rw
`;

const PASSWD = `root:x:0:0:root:/root:/bin/bash
ollama:x:998:998::/usr/share/ollama:/bin/false
me:x:1000:1000:Me,,,:/home/me:/bin/bash
`;

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'local-models-store-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const unit = (scope: 'system' | 'user', user = '') =>
  parseSystemctlShow(`LoadState=loaded\nActiveState=active\nUser=${user}\n`, scope);

describe('parseMountinfo and mountFor', () => {
  it('reads mount points with escapes and their filesystem types', () => {
    expect(parseMountinfo(MOUNTINFO)).toEqual([
      { mountPoint: '/', fsType: 'ext4' },
      { mountPoint: '/proc', fsType: 'proc' },
      { mountPoint: '/boot/efi', fsType: 'vfat' },
      { mountPoint: '/mnt/model disk', fsType: 'xfs' },
      { mountPoint: '/usr/share/ollama/.ollama', fsType: 'ext4' },
    ]);
  });

  it('picks the longest mount point that contains the path, by whole segments', () => {
    const mounts = parseMountinfo(MOUNTINFO);
    expect(mountFor('/usr/share/ollama/.ollama/models', mounts)?.mountPoint).toBe('/usr/share/ollama/.ollama');
    expect(mountFor('/mnt/model disk/blobs/', mounts)?.mountPoint).toBe('/mnt/model disk');
    expect(mountFor('/procfs/models', mounts)?.mountPoint).toBe('/');
    expect(mountFor('/x', [])).toBeNull();
  });
});

describe('passwdHome', () => {
  it('finds a user home', () => {
    expect(passwdHome(PASSWD, 'ollama')).toBe('/usr/share/ollama');
    expect(passwdHome(PASSWD, 'nobody')).toBeNull();
  });
});

describe('resolveStorePath', () => {
  it('prefers OLLAMA_MODELS', async () => {
    const installedStoreDir = vi.fn(async () => '/elsewhere');
    expect(
      await resolveStorePath({
        env: { OLLAMA_MODELS: '"/data/models"' },
        unit: unit('system', 'ollama'),
        installedStoreDir,
      })
    ).toEqual({ path: '/data/models', source: 'setting' });
    expect(installedStoreDir).not.toHaveBeenCalled();
  });

  it("uses the system unit user's home from /etc/passwd, root when the unit sets no user", async () => {
    const rootDir = tree({ 'etc/passwd': PASSWD });
    expect(await resolveStorePath({ env: {}, unit: unit('system', 'ollama'), rootDir })).toEqual({
      path: '/usr/share/ollama/.ollama/models',
      source: 'service-home',
    });
    expect(await resolveStorePath({ env: {}, unit: unit('system'), rootDir })).toEqual({
      path: '/root/.ollama/models',
      source: 'service-home',
    });
  });

  it("honours a unit's Environment=HOME= over the passwd home and this user's home", async () => {
    const rootDir = tree({ 'etc/passwd': PASSWD });
    const withHome = (scope: 'system' | 'user') =>
      parseSystemctlShow(
        `LoadState=loaded\nActiveState=active\nUser=ollama\nEnvironment=HOME=/srv/ollama PATH=/usr/bin\n`,
        scope
      );
    for (const scope of ['system', 'user'] as const) {
      const homed = withHome(scope);
      const input = { env: { ...homed.environment }, unit: homed, rootDir, homeDir: '/home/me' };
      expect(await resolveStorePath(input)).toEqual({ path: '/srv/ollama/.ollama/models', source: 'service-home' });
    }
  });

  it("uses this user's home for a user unit, then a process HOME, then an installed model", async () => {
    expect(await resolveStorePath({ env: {}, unit: unit('user'), homeDir: '/home/me' })).toEqual({
      path: '/home/me/.ollama/models',
      source: 'service-home',
    });
    expect(await resolveStorePath({ env: { HOME: '/home/other' }, unit: null })).toEqual({
      path: '/home/other/.ollama/models',
      source: 'process-home',
    });
    const missingPasswd = tree({});
    expect(
      await resolveStorePath({
        env: {},
        unit: unit('system', 'ollama'),
        rootDir: missingPasswd,
        installedStoreDir: async () => '/var/lib/ollama/models',
      })
    ).toEqual({ path: '/var/lib/ollama/models', source: 'installed-model' });
    expect(
      await resolveStorePath({
        env: {},
        unit: null,
        installedStoreDir: async () => {
          throw new Error('no models');
        },
      })
    ).toEqual({ path: null, source: null });
  });
});

describe('storeDisk', () => {
  const stats = { bavail: 1000, bsize: 4096 };

  it('measures at the mount point, which stays reachable when the store is not', async () => {
    const rootDir = tree({ 'proc/self/mountinfo': MOUNTINFO });
    const statfs = vi.fn(async (path: string) => {
      if (path !== '/usr/share/ollama/.ollama') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return stats;
    });
    const realpath = vi.fn(async () => {
      throw new Error('EACCES');
    });
    expect(await storeDisk('/usr/share/ollama/.ollama/models', { rootDir, statfs, realpath })).toEqual({
      mountPoint: '/usr/share/ollama/.ollama',
      freeBytes: 4096000,
      resolved: false,
    });
  });

  it('resolves symlinks before matching the mount', async () => {
    const rootDir = tree({ 'proc/self/mountinfo': MOUNTINFO });
    const statfs = vi.fn(async () => ({ bavail: 2n, bsize: 4096n }));
    const result = await storeDisk('/home/me/models', { rootDir, statfs, realpath: async () => '/mnt/model disk/m' });
    expect(result).toEqual({ mountPoint: '/mnt/model disk', freeBytes: 8192, resolved: true });
    expect(statfs).toHaveBeenCalledWith('/mnt/model disk');
  });

  it('falls back to the store itself without mountinfo or when the mount point fails, and to null', async () => {
    const noMountinfo = tree({});
    const realpath = async (path: string) => path;
    expect(await storeDisk('/data/models', { rootDir: noMountinfo, statfs: async () => stats, realpath })).toEqual({
      mountPoint: null,
      freeBytes: 4096000,
      resolved: true,
    });
    const rootDir = tree({ 'proc/self/mountinfo': MOUNTINFO });
    const statfs = vi.fn(async (path: string) => {
      if (path === '/') throw new Error('EIO');
      return stats;
    });
    expect(await storeDisk('/data/models', { rootDir, statfs, realpath })).toEqual({
      mountPoint: '/',
      freeBytes: 4096000,
      resolved: true,
    });
    const failing = async () => {
      throw new Error('ENOENT');
    };
    expect(await storeDisk('/data/models', { rootDir, statfs: failing, realpath })).toEqual({
      mountPoint: '/',
      freeBytes: null,
      resolved: true,
    });
  });
});
