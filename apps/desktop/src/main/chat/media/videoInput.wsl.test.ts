import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaStore } from './MediaStore';

const reached = vi.hoisted(() => ({ real: '' }));

vi.mock('../tools/paths', async importOriginal => {
  const actual = await importOriginal<typeof import('../tools/paths')>();
  return {
    ...actual,
    resolveWithinRoots: async (requested: string) => requested,
    physicalTarget: async () => reached.real,
  };
});

const { resolveInputImage } = await import('./videoInput');

const APP = 'C:\\Users\\me\\AppData\\Roaming\\App';

describe('video input on Windows, for an image that resolves through the WSL share', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  beforeEach(() => Object.defineProperty(process, 'platform', { value: 'win32' }));
  afterEach(() => {
    if (platform) Object.defineProperty(process, 'platform', platform);
  });

  const upload = (real: string) => {
    reached.real = real;
    return resolveInputImage(
      undefined,
      'D:\\notes\\frame.png',
      { roots: ['D:\\notes'], signal: new AbortController().signal, protectedPaths: [APP] },
      {} as MediaStore
    );
  };

  it.each([
    '\\\\wsl$\\Ubuntu\\mnt\\c\\Users\\me\\AppData\\Roaming\\App\\x',
    '\\\\wsl.localhost\\Ubuntu\\mnt\\C\\users\\me\\appdata\\roaming\\app\\x',
    'c:\\USERS\\ME\\APPDATA\\ROAMING\\APP\\x',
  ])('refuses the app folder reached as %s', async real => {
    await expect(upload(real)).rejects.toThrow(/protected location/);
  });
});
