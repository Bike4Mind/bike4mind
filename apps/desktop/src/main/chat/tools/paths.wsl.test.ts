import { posix } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Run the containment arithmetic as it runs on Windows, whatever the host.
vi.mock('node:path', async importOriginal => {
  const { win32 } = await importOriginal<typeof import('node:path')>();
  return { ...win32, default: win32 };
});

const realpaths = new Map<string, string | null>();
const asked: string[] = [];
const onShare = new Set<string>();

vi.mock('node:fs/promises', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  stat: async (path: string) => {
    if (onShare.has(path)) return {};
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  },
}));

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

const {
  PathAccessDenied,
  hostPhysicalTarget,
  hostRealpath,
  isWithin,
  resolveOperand,
  resolveWithinRoots,
  resolveWithinRootsPhysically,
} = await import('./paths');
const { shareName } = await import('../../wsl/wslPath');

const REPO = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';
const denied = (promise: Promise<unknown>) => expect(promise).rejects.toBeInstanceOf(PathAccessDenied);

describe('paths in a WSL folder', () => {
  beforeEach(() => {
    realpaths.clear();
    onShare.clear();
    asked.length = 0;
  });

  it('resolves a path in the distro to its share path only when it exists there', async () => {
    onShare.add(`${REPO}\\src`);
    realpaths.set('/home/me/repo/link', '/home/me/other');
    onShare.add('\\\\wsl.localhost\\Ubuntu\\home\\me\\other');

    expect(await hostRealpath(`${REPO}\\src`)).toBe(`${REPO}\\src`);
    expect(await hostRealpath(`${REPO}\\link`)).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\other');
    await expect(hostRealpath(`${REPO}\\missing`)).rejects.toThrow('ENOENT');
    realpaths.set('/home/me/repo/broken', null);
    await expect(hostRealpath(`${REPO}\\broken`)).rejects.toThrow('Cannot resolve');
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

  it('keeps a backslash in a Linux name inside that name, spelled as the share spells it', async () => {
    await denied(resolveWithinRootsPhysically('../repo\\x/notes', [REPO], REPO));
    expect(asked).toContain('Ubuntu:/home/me/repo/../repo\\x/notes');

    expect(await resolveWithinRootsPhysically('a\\nb.txt', [REPO], REPO)).toBe(`${REPO}\\a\u{f05c}nb.txt`);
    realpaths.set('/home/me/repo/link', '/home/me/repo/a\\b');
    expect(await resolveWithinRootsPhysically('link', [REPO], REPO)).toBe(`${REPO}\\a\u{f05c}b`);
    onShare.add(`${REPO}\\a\u{f05c}b`);
    expect(await hostRealpath(`${REPO}\\link`)).toBe(`${REPO}\\a\u{f05c}b`);

    asked.length = 0;
    expect(await resolveWithinRoots(`${REPO}\\a\u{f05c}b`, [REPO])).toBe(`${REPO}\\a\u{f05c}b`);
    expect(asked).toContain('Ubuntu:/home/me/repo/a\\b');
  });

  it('refuses a path in a distro no root is in without asking that distro', async () => {
    await denied(resolveWithinRootsPhysically('\\\\wsl.localhost\\Debian\\home\\me\\repo', [REPO], REPO));
    expect(asked).toEqual(['Ubuntu:/home/me/repo', 'Ubuntu:/home/me/repo/\\\\wsl.localhost\\Debian\\home\\me\\repo']);
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
    // To bash it is a name in the folder; the share place it also names is checked too.
    const long = '\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\me\\repo\\src';
    expect(await resolveWithinRootsPhysically(long, [REPO], REPO)).toBe(`${REPO}\\${shareName(long)}`);
    await denied(resolveWithinRootsPhysically('\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\me\\other', [REPO], REPO));
    await denied(resolveWithinRoots('\\\\wsl$\\ubuntu\\home\\me\\repository', [REPO]));
    expect(isWithin(REPO, '\\\\wsl$\\UBUNTU\\home\\me\\repo\\x')).toBe(true);
    expect(isWithin(REPO, '\\\\wsl$\\Ubuntu\\home\\me\\Repo\\x')).toBe(false);
  });

  it('reads a share path given to a command as the Linux name bash takes it for, and as the share place', async () => {
    await denied(resolveWithinRootsPhysically('//wsl.localhost/Ubuntu/home/me/repo/x', [REPO], REPO));
    expect(asked).toContain('Ubuntu:/wsl.localhost/Ubuntu/home/me/repo/x');
    await denied(resolveWithinRootsPhysically('\\\\wsl.localhost\\Ubuntu\\home\\me\\notes.txt', [REPO], REPO));

    const named = '\\\\wsl.localhost\\Ubuntu\\home\\me\\notes.txt';
    expect(await resolveWithinRootsPhysically(named, [REPO], REPO, 'shell')).toBe(`${REPO}\\${shareName(named)}`);
  });

  it("reads a Windows program's operand as Windows would as well, from the folder's share path", async () => {
    await denied(resolveWithinRootsPhysically('C:\\Users\\me\\notes.txt', [REPO], REPO, 'windows'));
    await denied(resolveWithinRootsPhysically('..\\notes.txt', [REPO], REPO, 'windows'));
    await denied(resolveWithinRootsPhysically('C:notes.txt', [REPO], REPO, 'windows'));
    expect(await resolveWithinRootsPhysically('src\\a.ts', [REPO], REPO, 'windows')).toBe(`${REPO}\\src\u{f05c}a.ts`);
    expect(await resolveWithinRootsPhysically('C:\\Users\\me\\notes.txt', [REPO], REPO)).toBe(
      `${REPO}\\C\u{f03a}\u{f05c}Users\u{f05c}me\u{f05c}notes.txt`
    );
  });

  it('reads a Linux absolute path from a WSL folder as a path in its distro', async () => {
    expect(await resolveWithinRoots('/home/me/repo/src/a.ts', [REPO], REPO)).toBe(`${REPO}\\src\\a.ts`);
    expect(asked).toContain('Ubuntu:/home/me/repo/src/a.ts');
    await denied(resolveWithinRoots('/etc/passwd', [REPO], REPO));
    expect(asked).toContain('Ubuntu:/etc/passwd');
  });

  it('asks the distro about a Linux name holding a share spelling character under that name', async () => {
    const odd = 'x\u{f05c}';
    realpaths.set(`/home/me/repo/${odd}/notes.txt`, '/home/me/notes.txt');

    await denied(resolveWithinRootsPhysically(`${odd}/notes.txt`, [REPO], REPO));
    expect(asked).toContain(`Ubuntu:/home/me/repo/${odd}/notes.txt`);
    const entered = resolveOperand(REPO, odd);
    await denied(resolveWithinRootsPhysically('notes.txt', [REPO], entered));
    expect(await hostPhysicalTarget(`${entered}\\notes.txt`)).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\notes.txt');
    expect(await resolveWithinRootsPhysically('x\\/notes.txt', [REPO], REPO)).toBe(`${REPO}\\x\u{f05c}\\notes.txt`);
  });
});
