import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('resolveUserPath on Windows', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  afterEach(() => {
    if (platform) Object.defineProperty(process, 'platform', platform);
    vi.unstubAllEnvs();
    vi.doUnmock('node:child_process');
  });

  it('uses the inherited PATH as it is, with no shell probe and no Homebrew or Nix folders', async () => {
    vi.resetModules();
    const execFile = vi.fn();
    vi.doMock('node:child_process', () => ({ execFile }));
    vi.stubEnv('PATH', 'C:\\Windows\\System32;C:\\Tools');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { resolveUserPath } = await import('./userPath');

    expect(await resolveUserPath()).toBe('C:\\Windows\\System32;C:\\Tools');
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('findOnPath', () => {
  it('takes the first absolute Windows PATH folder with <name>.exe and never looks up a relative one', async () => {
    const { findOnPath } = await import('./userPath');
    const checked: string[] = [];
    const isExecutable = async (file: string) => {
      checked.push(file);
      return file === 'C:\\Program Files\\GitHub CLI\\gh.exe';
    };

    const found = await findOnPath('gh', '.;bin;;D:\\Tools;"C:\\Program Files\\GitHub CLI"', 'win32', isExecutable);

    expect(found).toBe('C:\\Program Files\\GitHub CLI\\gh.exe');
    expect(checked).toEqual(['D:\\Tools\\gh.exe', 'C:\\Program Files\\GitHub CLI\\gh.exe']);
    expect(await findOnPath('gh', '.;bin', 'win32', isExecutable)).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('skips relative and non-executable entries on POSIX', async () => {
    const { findOnPath } = await import('./userPath');
    const directory = await mkdtemp(join(tmpdir(), 'b4m-on-path-'));
    try {
      for (const [folder, mode] of [
        ['here', 0o755],
        ['plain', 0o644],
        ['bin', 0o755],
      ] as const) {
        await mkdir(join(directory, folder));
        await writeFile(join(directory, folder, 'gh'), '#!/bin/sh\n', { mode });
      }
      const path = ['.', '', 'here', join(directory, 'plain'), join(directory, 'bin')].join(':');

      expect(await findOnPath('gh', path, 'linux')).toBe(join(directory, 'bin', 'gh'));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('hostProgram', () => {
  it('gives the bare name off Windows', async () => {
    const { hostProgram } = await import('./userPath');
    const isExecutable = vi.fn(async () => true);

    expect(await hostProgram('git', '/usr/bin', 'linux', isExecutable)).toBe('git');
    expect(await hostProgram('rg', '/opt/homebrew/bin', 'darwin', isExecutable)).toBe('rg');
    expect(isExecutable).not.toHaveBeenCalled();
  });

  it('gives the absolute Windows path, keeps it while it exists and finds none when it is gone', async () => {
    const { hostProgram } = await import('./userPath');
    const present = new Set(['C:\\Git\\cmd\\git.exe']);
    const checked: string[] = [];
    const isExecutable = async (file: string) => {
      checked.push(file);
      return present.has(file);
    };
    const path = '.;D:\\bin;C:\\Git\\cmd';

    expect(await hostProgram('git', path, 'win32', isExecutable)).toBe('C:\\Git\\cmd\\git.exe');
    checked.length = 0;
    expect(await hostProgram('git', path, 'win32', isExecutable)).toBe('C:\\Git\\cmd\\git.exe');
    expect(checked).toEqual(['C:\\Git\\cmd\\git.exe']);

    present.clear();
    expect(await hostProgram('git', path, 'win32', isExecutable)).toBeNull();
    present.add('D:\\bin\\git.exe');
    expect(await hostProgram('git', path, 'win32', isExecutable)).toBe('D:\\bin\\git.exe');
  });
});

describe.skipIf(process.platform === 'win32')('resolveUserPath', () => {
  let directory: string;

  beforeEach(async () => {
    vi.resetModules();
    directory = await mkdtemp(join(tmpdir(), 'b4m-user-path-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it('recovers the shell PATH, including Nix profiles, despite startup output', async () => {
    const shell = join(directory, 'shell');
    await writeFile(
      shell,
      '#!/bin/sh\nprintf "Shell startup output\\n"\nexport PATH="/etc/profiles/per-user/test/bin:/usr/bin:/bin"\nexec /bin/sh -c "$2"\n',
      { mode: 0o755 }
    );
    vi.stubEnv('SHELL', shell);
    vi.stubEnv('PATH', '/usr/bin:/bin');
    const { resolveUserPath } = await import('./userPath');

    const path = await resolveUserPath();

    expect(path.split(delimiter)[0]).toBe('/etc/profiles/per-user/test/bin');
    expect(path).not.toContain('__B4M_PATH__');
    expect(path.split(delimiter)).toContain('/opt/homebrew/bin');
  });

  it('kills a slow probe with SIGKILL, which an interactive shell cannot ignore like SIGTERM', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const execFile = vi.fn(actual.execFile);
    vi.doMock('node:child_process', () => ({ ...actual, execFile }));
    vi.stubEnv('SHELL', join(directory, 'missing-shell'));
    const { resolveUserPath } = await import('./userPath');

    await resolveUserPath();

    expect(execFile.mock.calls[0][2]).toMatchObject({ killSignal: 'SIGKILL' });
    vi.doUnmock('node:child_process');
  });

  it('keeps the inherited PATH plus Homebrew and Nix locations when the shell cannot start', async () => {
    vi.stubEnv('SHELL', join(directory, 'missing-shell'));
    vi.stubEnv('PATH', '/custom/bin:/usr/bin');
    vi.stubEnv('HOME', '/Users/test');
    vi.stubEnv('USER', 'test');
    const { resolveUserPath } = await import('./userPath');

    const path = await resolveUserPath();

    expect(path.split(delimiter)).toEqual([
      '/custom/bin',
      '/usr/bin',
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/Users/test/.nix-profile/bin',
      '/etc/profiles/per-user/test/bin',
      '/run/current-system/sw/bin',
      '/nix/var/nix/profiles/default/bin',
    ]);
  });
});
