import { posix } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Run the containment arithmetic as it runs on Windows, whatever the host.
vi.mock('node:path', async importOriginal => {
  const { win32 } = await importOriginal<typeof import('node:path')>();
  return { ...win32, default: win32 };
});

const realpaths = new Map<string, string | null>();
const asked: string[] = [];

vi.mock('../../wsl/wslPath', async importOriginal => {
  const actual = await importOriginal<typeof import('../../wsl/wslPath')>();
  return {
    ...actual,
    wslLocation: (directory: string) => actual.parseWslPath(directory),
    wslRealpath: async (distro: string, linuxPath: string) => {
      asked.push(`${distro}:${linuxPath}`);
      return realpaths.has(linuxPath) ? (realpaths.get(linuxPath) ?? null) : posix.normalize(linuxPath);
    },
  };
});

const { PathAccessDenied, isWithin, resolveWithinRoots, resolveWithinRootsPhysically } = await import('./paths');

const REPO = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';
const denied = (promise: Promise<unknown>) => expect(promise).rejects.toBeInstanceOf(PathAccessDenied);

describe('paths in a WSL folder', () => {
  beforeEach(() => {
    realpaths.clear();
    asked.length = 0;
  });

  it('resolves a shell argument inside the distro, by Linux rules, against the Linux folder', async () => {
    realpaths.set('/home/me/repo/docs/notes', '/home/me/notes');
    await denied(resolveWithinRootsPhysically('docs/notes', [REPO], REPO));
    expect(asked).toContain('Ubuntu:/home/me/repo/docs/notes');
    expect(await resolveWithinRootsPhysically('src/file', [REPO], REPO)).toBe(`${REPO}\\src\\file`);

    realpaths.set('/home/me/repo/src/up/../../x', '/home/x');
    await denied(resolveWithinRootsPhysically('src/up/../../x', [REPO], REPO));
    expect(asked).toContain('Ubuntu:/home/me/repo/src/up/../../x');
    realpaths.set('/home/me/repo/src/in/../x', '/home/me/repo/x');
    expect(await resolveWithinRootsPhysically('src/in/../x', [REPO], REPO)).toBe(`${REPO}\\x`);

    await denied(resolveWithinRootsPhysically('/etc/passwd', [REPO], REPO));
    expect(asked).toContain('Ubuntu:/etc/passwd');
    expect(await resolveWithinRootsPhysically('/home/me/repo/a.ts', [REPO], REPO)).toBe(`${REPO}\\a.ts`);
  });

  it('treats a path the distro cannot resolve as outside', async () => {
    realpaths.set('/home/me/repo/broken/x', null);
    await denied(resolveWithinRootsPhysically('broken/x', [REPO], REPO));
    expect(await resolveWithinRootsPhysically('fine/x', [REPO], REPO)).toBe(`${REPO}\\fine\\x`);

    realpaths.set('/home/me/repo/a.txt', null);
    await denied(resolveWithinRoots(`${REPO}\\a.txt`, [REPO]));
    expect(await resolveWithinRoots(`${REPO}\\b.txt`, [REPO])).toBe(`${REPO}\\b.txt`);

    // The scan's own check against the filesystem root of the share.
    await denied(resolveWithinRootsPhysically('broken/x', ['\\\\wsl.localhost\\Ubuntu\\'], REPO));
  });

  it('refuses a path in a distro no root is in without asking that distro', async () => {
    await denied(resolveWithinRootsPhysically('\\\\wsl.localhost\\Debian\\home\\me\\repo', [REPO], REPO));
    expect(asked).toEqual(['Ubuntu:/home/me/repo']);
    asked.length = 0;
    await denied(resolveWithinRoots('\\\\wsl.localhost\\Debian\\etc\\hosts', [REPO]));
    await denied(resolveWithinRoots('\\\\wsl$\\Debian\\etc\\hosts', ['C:\\Users\\me\\proj']));
    await denied(resolveWithinRootsPhysically('src', ['C:\\Users\\me\\proj'], REPO));
    expect(asked).toEqual([]);
  });

  it('accepts a path to the same folder under the other share name, distro case or long form', async () => {
    expect(await resolveWithinRoots('\\\\wsl$\\ubuntu\\home\\me\\repo\\src', [REPO])).toBe(
      '\\\\wsl$\\ubuntu\\home\\me\\repo\\src'
    );
    expect(asked).toEqual(['Ubuntu:/home/me/repo', 'ubuntu:/home/me/repo/src']);
    expect(
      await resolveWithinRootsPhysically('\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\me\\repo\\src', [REPO], REPO)
    ).toBe(`${REPO}\\src`);
    await denied(resolveWithinRoots('\\\\wsl$\\ubuntu\\home\\me\\repository', [REPO]));
    expect(isWithin(REPO, '\\\\wsl$\\UBUNTU\\home\\me\\repo\\x')).toBe(true);
    expect(isWithin(REPO, '\\\\wsl$\\Ubuntu\\home\\me\\Repo\\x')).toBe(false);
  });

  it('reads a Linux absolute path from a WSL folder as a path in its distro', async () => {
    expect(await resolveWithinRoots('/home/me/repo/src/a.ts', [REPO], REPO)).toBe(`${REPO}\\src\\a.ts`);
    expect(asked).toContain('Ubuntu:/home/me/repo/src/a.ts');
    await denied(resolveWithinRoots('/etc/passwd', [REPO], REPO));
    expect(asked).toContain('Ubuntu:/etc/passwd');
  });
});
