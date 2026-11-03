import { posix } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Joined and compared as on Windows, whatever the host.
vi.mock('node:path', async importOriginal => {
  const { win32 } = await importOriginal<typeof import('node:path')>();
  return { ...win32, default: win32 };
});

/** Files as Windows opens them, by path, and the folders that hold them. */
const files = new Map<string, string>();
const folders = new Set<string>();

const missing = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
const info = (path: string) => {
  if (folders.has(path)) return { isFile: () => false, isDirectory: () => true, size: 0, mtimeMs: 0 };
  const text = files.get(path);
  if (text === undefined) throw missing(path);
  return { isFile: () => true, isDirectory: () => false, size: text.length, mtimeMs: 1 };
};

vi.mock('node:fs/promises', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  stat: async (path: string) => info(path),
  lstat: async (path: string) => info(path),
  realpath: async (path: string) => (info(path), path),
  readFile: async (path: string) => {
    const text = files.get(path);
    if (text === undefined) throw missing(path);
    return Buffer.from(text);
  },
}));

vi.mock('../../wsl/wslPath', async importOriginal => {
  const actual = await importOriginal<typeof import('../../wsl/wslPath')>();
  return {
    ...actual,
    wslLocation: (directory: string) => actual.parseWslPath(directory),
    wslRealpath: async (_distro: string, linuxPath: string) => posix.normalize(linuxPath),
  };
});

const listDistroFiles = vi.hoisted(() => vi.fn());
const ripgrepSearch = vi.hoisted(() => vi.fn());
const listed = vi.hoisted(() => ({ tracked: '', ignored: '' }));
vi.mock('./wslFiles', () => ({ listDistroFiles }));
vi.mock('./ripgrep', () => ({ ripgrepSearch }));
vi.mock('../project/git', () => ({
  git: async (_directory: string, args: readonly string[]) => {
    const output = args.includes('--ignored') ? listed.ignored : listed.tracked;
    if (!output) throw new Error('not a repository');
    return output;
  },
}));

const { globFiles, grepSearch } = await import('./fileTools');

const PROJECT = '\\\\wsl$\\Ubuntu\\home\\me\\proj';
const ABOVE = '\\\\wsl$\\Ubuntu\\home\\me\\outside.txt';
/** The Linux name `a\..\..\outside.txt` in the project, as the share spells it. */
const SPELLED = `${PROJECT}\\a\u{f05c}..\u{f05c}..\u{f05c}outside.txt`;
const context = () => ({ roots: [PROJECT], signal: new AbortController().signal });

describe('names listed in a WSL folder, opened over the share', () => {
  beforeEach(() => {
    files.clear();
    folders.clear();
    folders.add(PROJECT);
    listed.tracked = '';
    listed.ignored = '';
    listDistroFiles.mockReset().mockResolvedValue(null);
    ripgrepSearch.mockReset().mockResolvedValue('unavailable');
    files.set(ABOVE, 'needle above the folder\n');
  });

  it('greps a name from the distro listing that holds a backslash at the share spelling of it', async () => {
    files.set(SPELLED, 'needle in the folder\n');
    listDistroFiles.mockResolvedValue({
      complete: true,
      files: [{ path: 'a\\..\\..\\outside.txt', size: 21, modified: 1 }],
    });

    const result = await grepSearch.run({ pattern: 'needle', path: PROJECT }, context());

    expect(result).toContain('needle in the folder');
    expect(result).not.toContain('above the folder');
  });

  it('lists and greps a name holding a character Windows names cannot, at a spelling that opens', async () => {
    const shown = 'x\u{f03f}y.txt';
    files.set(`${PROJECT}\\${shown}`, 'needle\n');
    listDistroFiles.mockResolvedValue({ complete: true, files: [{ path: 'x?y.txt', size: 7, modified: 1 }] });

    const grep = await grepSearch.run({ pattern: 'needle', path: PROJECT }, context());
    const glob = await globFiles.run({ pattern: '*', path: PROJECT }, context());

    expect(grep).toContain(shown);
    expect(glob).toContain(shown);
    expect(glob).not.toContain('x?y.txt');
  });

  it('greps a tracked name that holds a backslash at the share spelling of it', async () => {
    files.set(SPELLED, 'needle tracked in the folder\n');
    listed.tracked = 'a\\..\\..\\outside.txt\0';

    const result = await grepSearch.run({ pattern: 'needle', path: PROJECT }, context());

    expect(result).toContain('needle tracked in the folder');
    expect(result).not.toContain('above the folder');
  });

  it('greps a tracked and ignored name that holds a backslash at the share spelling of it', async () => {
    files.set(SPELLED, 'needle ignored in the folder\n');
    ripgrepSearch.mockResolvedValue('done');
    listed.ignored = 'a\\..\\..\\outside.txt\0';

    const result = await grepSearch.run({ pattern: 'needle', path: PROJECT }, context());

    expect(result).toContain('needle ignored in the folder');
    expect(result).not.toContain('above the folder');
  });

  it('shows a path ripgrep printed in the distro at the share spelling of it', async () => {
    ripgrepSearch.mockImplementation(async ({ onFile }) => {
      onFile({ path: 'c:d.txt', matches: 1, lines: [{ number: 1, text: 'needle', match: true }] });
      return 'done';
    });

    const result = await grepSearch.run({ pattern: 'needle', path: PROJECT, outputMode: 'files' }, context());

    expect(result).toContain('c\u{f03a}d.txt');
    expect(result).not.toContain('c:d.txt');
  });
});

describe('names a listing gives for a folder', () => {
  const FOLDER = 'C:\\proj';
  const local = () => ({ roots: [FOLDER], signal: new AbortController().signal });

  beforeEach(() => {
    files.clear();
    folders.clear();
    folders.add(FOLDER);
    listed.tracked = '';
    listed.ignored = '';
    listDistroFiles.mockReset().mockResolvedValue(null);
    ripgrepSearch.mockReset().mockResolvedValue('unavailable');
    files.set('C:\\outside.txt', 'needle above the folder\n');
    files.set(`${FOLDER}\\in.txt`, 'needle in the folder\n');
  });

  it('are searched only when joining them stays below the folder', async () => {
    listed.tracked = '..\\outside.txt\0in.txt\0';

    const result = await grepSearch.run({ pattern: 'needle', path: FOLDER }, local());

    expect(result).toContain('needle in the folder');
    expect(result).not.toContain('above the folder');
  });

  it('are searched only when joining them stays below the folder, for tracked and ignored ones too', async () => {
    ripgrepSearch.mockResolvedValue('done');
    listed.ignored = '..\\outside.txt\0in.txt\0';

    const result = await grepSearch.run({ pattern: 'needle', path: FOLDER }, local());

    expect(result).toContain('needle in the folder');
    expect(result).not.toContain('above the folder');
  });

  it('are listed only when joining them stays below the folder', async () => {
    listed.tracked = '..\\outside.txt\0in.txt\0';

    const result = await globFiles.run({ pattern: '{../*.txt,*.txt}', path: FOLDER }, local());

    expect(result).toContain('in.txt');
    expect(result).not.toContain('outside.txt');
  });
});
