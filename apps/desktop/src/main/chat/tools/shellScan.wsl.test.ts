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

    expect(scan?.directories).toEqual(['\\\\wsl.localhost\\Debian\\etc']);
    expect(inDebian(touched)).toEqual([]);
    expect(inDebian(asked)).toEqual([]);
  });
});
