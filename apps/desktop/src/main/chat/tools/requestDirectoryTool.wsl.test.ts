import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const picked = vi.hoisted(() => ({ real: '' }));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: async (path: string) => (path === '/picked' ? picked.real : actual.realpath(path)),
    stat: async (path: string) => (path === picked.real ? { isDirectory: () => true } : actual.stat(path)),
  };
});

const { inspectDirectory } = await import('./requestDirectoryTool');

const APP = 'C:\\Users\\me\\AppData\\Roaming\\App';

describe('request_directory on Windows, for a folder picked through the WSL share', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  beforeEach(() => Object.defineProperty(process, 'platform', { value: 'win32' }));
  afterEach(() => {
    if (platform) Object.defineProperty(process, 'platform', platform);
  });

  const inspect = (real: string) => {
    picked.real = real;
    return inspectDirectory('/picked', { roots: [], declined: [], home: '/home/me', protectedPaths: [APP] });
  };

  it.each([
    '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\me\\AppData\\Roaming\\App',
    '\\\\wsl$\\Ubuntu\\mnt\\c\\Users\\me\\AppData\\Roaming\\App\\sessions',
    '\\\\wsl.localhost\\Ubuntu\\mnt\\C\\users\\me\\appdata\\roaming\\app',
  ])('refuses the app folder reached as %s', async real => {
    await expect(inspect(real)).resolves.toMatchObject({ kind: 'refused', message: /belongs to this app/ });
  });

  it('asks for a folder in the distro itself', async () => {
    await expect(inspect('\\\\wsl.localhost\\Ubuntu\\home\\me\\AppData\\Roaming\\App')).resolves.toMatchObject({
      kind: 'ask',
    });
  });
});
