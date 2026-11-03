import { posix } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseBash } from './bashParser';

// The parser finds its wasm by this host's path rules, so it is loaded before Windows rules are mocked in.
(await parseBash('true'))?.delete();

const touched: string[] = [];
const asked: string[] = [];

vi.doMock('node:path', async () => {
  const { win32 } = await vi.importActual<typeof import('node:path')>('node:path');
  return { ...win32, default: win32 };
});
vi.doMock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const recorded = Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value === 'function'
        ? async (...args: unknown[]) => {
            touched.push(...args.filter((arg): arg is string => typeof arg === 'string'));
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          }
        : value,
    ])
  );
  return { ...recorded, default: recorded };
});
vi.doMock('../../wsl/wslPath', async () => {
  const actual = await vi.importActual<typeof import('../../wsl/wslPath')>('../../wsl/wslPath');
  return {
    ...actual,
    wslLocation: (directory: string) => actual.parseWslPath(directory),
    wslUserEnvironment: async () => ({ path: '/usr/bin', home: '/home/me' }),
    wslRealpath: async (distro: string, linuxPath: string) => {
      asked.push(`${distro}:${linuxPath}`);
      return posix.normalize(linuxPath);
    },
  };
});

const { scanShell } = await import('./shellScan');

const OTHER = '\\\\wsl.localhost\\Debian\\etc\\hosts';
const inDebian = (paths: string[]) => paths.filter(path => /debian/i.test(path));

describe('a path in a distro no root is in', () => {
  it.each([
    ['a WSL project', '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'],
    ['a Windows project', 'C:\\repo'],
  ])('is outside in %s, named without reading it over the share', async (_kind, root) => {
    touched.length = 0;
    asked.length = 0;

    const scan = await scanShell(`cat '${OTHER}'`, root, [root]);

    expect(scan?.ungranted).toEqual([OTHER]);
    expect(scan?.paths ?? []).not.toContain(OTHER);
    expect(inDebian(touched)).toEqual([]);
    expect(inDebian(asked)).toEqual([]);
  });

  it.each([
    ['a file', OTHER],
    ['a folder', '\\\\wsl.localhost\\Debian\\home\\me\\notes'],
    ['the distro root', '\\\\wsl.localhost\\Debian\\'],
  ])('offers no folder grant for %s', async (_kind, operand) => {
    const root = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';

    const scan = await scanShell(`ls '${operand}'`, root, [root]);

    expect(scan?.ungranted).toHaveLength(1);
    expect(scan?.directories).toEqual([]);
  });

  it.each([
    ['a WSL project', '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'],
    ['a Windows project', 'C:\\repo'],
  ])('is named, not read, as the operand of a program that does not open files, in %s', async (_kind, root) => {
    touched.length = 0;
    asked.length = 0;

    const scan = await scanShell(`sed -n p '${OTHER}'`, root, [root]);

    expect(scan?.ungranted).toEqual([OTHER]);
    expect(inDebian(touched)).toEqual([]);
    expect(inDebian(asked)).toEqual([]);
  });

  it.each(['node build.js C:/out', 'node build.js --base=//cdn.example.com/x', 'node build.js /usr/lib/x'])(
    'scans %s from a WSL project as an ordinary command',
    async command => {
      const root = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';

      const scan = await scanShell(command, root, [root]);

      expect(scan?.commands.map(entry => entry.coverable)).toEqual([true]);
      expect(scan?.ungranted).toEqual([]);
    }
  );
});

describe('the folders a command in a WSL project may reach unasked', () => {
  const root = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';

  it("takes the distro's /tmp as the temp folder", async () => {
    const scan = await scanShell('cat /tmp/out.txt', root, [root]);

    expect(scan?.directories).toEqual([]);
    expect(scan?.ungranted).toEqual([]);
  });

  it('still asks about another folder of the distro', async () => {
    const scan = await scanShell('cat /var/log/out.txt', root, [root]);

    expect(scan?.directories).toEqual(['\\\\wsl.localhost\\Ubuntu\\var\\log']);
  });

  it("lets a read-only probe look at the distro user's toolchain folder, and asks about a secret in it", async () => {
    const toolchain = await scanShell('ls ~/.cargo/bin', root, [root]);
    const secret = await scanShell('ls ~/.cargo/credentials.toml', root, [root]);

    expect(toolchain?.directories).toEqual([]);
    expect(secret?.directories).toEqual(['\\\\wsl.localhost\\Ubuntu\\home\\me\\.cargo']);
  });
});
