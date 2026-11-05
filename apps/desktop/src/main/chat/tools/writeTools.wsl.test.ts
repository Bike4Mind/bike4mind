import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reached = vi.hoisted(() => ({ real: '' }));

vi.mock('./paths', async importOriginal => {
  const actual = await importOriginal<typeof import('./paths')>();
  return {
    ...actual,
    resolveWithinRoots: async (requested: string) => requested,
    physicalTarget: async () => reached.real,
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
});
