import { beforeEach, describe, expect, it, vi } from 'vitest';

const realpaths = new Map<string, string | null>();
const asked: string[] = [];

// Containment itself is Windows path arithmetic; here only what is asked of the distro, and what a failed answer means.
vi.mock('../../wsl/wslPath', async importOriginal => {
  const actual = await importOriginal<typeof import('../../wsl/wslPath')>();
  return {
    ...actual,
    wslLocation: (directory: string) => actual.parseWslPath(directory),
    wslRealpath: async (distro: string, linuxPath: string) => {
      asked.push(`${distro}:${linuxPath}`);
      return realpaths.has(linuxPath) ? (realpaths.get(linuxPath) ?? null) : linuxPath;
    },
  };
});

const { PathAccessDenied, resolveWithinRoots, resolveWithinRootsPhysically } = await import('./paths');

const REPO = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';

describe('paths in a WSL folder', () => {
  beforeEach(() => {
    realpaths.clear();
    asked.length = 0;
  });

  it('resolves a shell argument inside the distro, by Linux rules, against the Linux folder', async () => {
    realpaths.set('/home/me/repo/docs/notes', '/home/me/notes');
    await expect(resolveWithinRootsPhysically('docs/notes', [REPO], REPO)).rejects.toBeInstanceOf(PathAccessDenied);
    expect(asked).toContain('Ubuntu:/home/me/repo/docs/notes');

    asked.length = 0;
    await expect(resolveWithinRootsPhysically('/etc/passwd', [REPO], REPO)).rejects.toBeInstanceOf(PathAccessDenied);
    expect(asked).toContain('Ubuntu:/etc/passwd');

    asked.length = 0;
    await expect(resolveWithinRootsPhysically('src/up/../../x', [REPO], REPO)).rejects.toBeInstanceOf(PathAccessDenied);
    expect(asked).toContain('Ubuntu:/home/me/repo/src/up/../../x');
  });

  it('treats a path the distro cannot resolve as outside', async () => {
    realpaths.set('/home/me/repo/broken/x', null);
    await expect(resolveWithinRootsPhysically('broken/x', [REPO], REPO)).rejects.toBeInstanceOf(PathAccessDenied);
    realpaths.set('/home/me/repo/a.txt', null);
    await expect(resolveWithinRoots(`${REPO}\\a.txt`, [REPO])).rejects.toBeInstanceOf(PathAccessDenied);
  });

  it('never resolves a share path of another distro in this one', async () => {
    await expect(
      resolveWithinRootsPhysically('\\\\wsl.localhost\\Debian\\home\\me\\repo', [REPO], REPO)
    ).rejects.toBeInstanceOf(PathAccessDenied);
    expect(asked.filter(entry => entry.startsWith('Debian:') || entry.includes('/home/me/repo/\\'))).toEqual([]);
  });

  it('reads a share path to the same distro as the Linux path it names', async () => {
    await resolveWithinRootsPhysically('\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\me\\repo\\src', [REPO], REPO).catch(
      () => undefined
    );
    expect(asked).toContain('Ubuntu:/home/me/repo/src');
  });
});
