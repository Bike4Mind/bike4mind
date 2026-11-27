import { describe, expect, it, vi } from 'vitest';

// Joined and compared as on Windows, whatever the host.
vi.mock('node:path', async importOriginal => {
  const { win32 } = await importOriginal<typeof import('node:path')>();
  return { ...win32, default: win32 };
});

/** Files as Windows opens them, by path. */
const files = new Map<string, string>();

vi.mock('node:fs/promises', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  lstat: async (path: string) => {
    if (!files.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return { isFile: () => true };
  },
  open: async (path: string) => {
    const bytes = Buffer.from(files.get(path) ?? '');
    return {
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const slice = bytes.subarray(position, position + length);
        slice.copy(buffer, offset);
        return { bytesRead: slice.length };
      },
      close: async () => undefined,
    };
  },
}));

vi.mock('../../wsl/wslPath', async importOriginal => {
  const actual = await importOriginal<typeof import('../../wsl/wslPath')>();
  return { ...actual, wslLocation: (directory: string) => actual.parseWslPath(directory) };
});

const { countUntrackedFile } = await import('./workspaceChanges');

describe('counting an untracked file git listed', () => {
  it('opens a Linux name from a WSL folder at the share spelling of it', async () => {
    const project = '\\\\wsl$\\Ubuntu\\home\\me\\proj';
    files.set('\\\\wsl$\\Ubuntu\\home\\me\\outside.txt', 'one\ntwo\nthree\n');
    files.set(`${project}\\a\u{f05c}..\u{f05c}..\u{f05c}outside.txt`, 'one\n');

    const counted = await countUntrackedFile(project, 'a\\..\\..\\outside.txt');

    expect(counted).toMatchObject({ file: { path: 'a\\..\\..\\outside.txt', added: 1 }, bytesRead: 4 });
  });

  it('leaves uncounted a Linux name no Windows path reaches, rather than the name the share gives it', async () => {
    const project = '\\\\wsl$\\Ubuntu\\home\\me\\proj';
    files.set(`${project}\\a\u{f05c}b`, 'one\ntwo\n');

    const counted = await countUntrackedFile(project, 'a\u{f05c}b');

    expect(counted).toEqual({ file: { path: 'a\u{f05c}b', added: 0, removed: 0, untracked: true }, bytesRead: 0 });
  });

  it('counts a listed name only when joining it stays below the folder', async () => {
    files.set('C:\\outside.txt', 'one\ntwo\n');

    const counted = await countUntrackedFile('C:\\proj', '..\\outside.txt');

    expect(counted).toEqual({ file: { path: '..\\outside.txt', added: 0, removed: 0, untracked: true }, bytesRead: 0 });
  });
});
