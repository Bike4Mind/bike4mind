import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reached = vi.hoisted(() => ({ real: '', inDistro: null as string | null }));

vi.mock('./paths', async importOriginal => {
  const actual = await importOriginal<typeof import('./paths')>();
  return {
    ...actual,
    resolveWithinRoots: async (requested: string) => requested,
    physicalTarget: async () => reached.real,
    hostPhysicalTarget: async (target: string) => {
      if (reached.inDistro === null) throw new Error(`Cannot resolve ${target} in its WSL distro`);
      return reached.inDistro;
    },
  };
});

const { resolveWritablePath } = await import('./writeTools');

const APP = 'C:\\Users\\me\\AppData\\Roaming\\App';

describe('writing on Windows, to a target that resolves through the WSL share', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  beforeEach(() => Object.defineProperty(process, 'platform', { value: 'win32' }));
  afterEach(() => {
    if (platform) Object.defineProperty(process, 'platform', platform);
  });

  const write = (real: string) => {
    reached.real = real;
    return resolveWritablePath('D:\\notes\\link.json', {
      roots: ['D:\\notes'],
      signal: new AbortController().signal,
      protectedPaths: [APP],
    });
  };

  it.each([
    '\\\\wsl$\\Ubuntu\\mnt\\c\\Users\\me\\AppData\\Roaming\\App\\x',
    '\\\\wsl.localhost\\Ubuntu\\mnt\\C\\users\\me\\appdata\\roaming\\app\\x',
    'c:\\USERS\\ME\\APPDATA\\ROAMING\\APP\\x',
  ])('refuses the app folder reached as %s', async real => {
    await expect(write(real)).rejects.toThrow(/protected location/);
  });

  it('allows a path beside the app folder', async () => {
    await expect(write('C:\\Users\\me\\AppData\\Roaming\\App2\\x')).resolves.toBe('D:\\notes\\link.json');
  });

  describe('for a target in a WSL folder', () => {
    const TARGET = '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj\\link.json';
    const writeInDistro = (inDistro: string | null) => {
      reached.real = TARGET;
      reached.inDistro = inDistro;
      return resolveWritablePath(TARGET, {
        roots: ['\\\\wsl.localhost\\Ubuntu\\home\\me\\proj'],
        signal: new AbortController().signal,
        protectedPaths: [APP],
      });
    };

    it('refuses a Linux link the distro resolves into the app folder', async () => {
      await expect(
        writeInDistro('\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\me\\AppData\\Roaming\\App\\x')
      ).rejects.toThrow(/protected location/);
    });

    it('refuses a target the distro cannot resolve', async () => {
      await expect(writeInDistro(null)).rejects.toThrow(/cannot be written to/);
    });

    it('allows a target the distro resolves elsewhere', async () => {
      await expect(writeInDistro('\\\\wsl.localhost\\Ubuntu\\home\\me\\proj\\real.json')).resolves.toBe(TARGET);
    });
  });
});
