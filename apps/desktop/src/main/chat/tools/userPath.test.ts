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

  it('counts a Windows PATH folder only with a drive or UNC prefix', async () => {
    const { findOnPath } = await import('./userPath');
    const checked: string[] = [];
    const isExecutable = async (file: string) => {
      checked.push(file);
      return false;
    };

    await findOnPath('gh', '\\Tools;/usr/bin;C:tools;C:\\bin;D:/bin;\\\\server\\share\\bin', 'win32', isExecutable);

    expect(checked).toEqual(['C:\\bin\\gh.exe', 'D:\\bin\\gh.exe', '\\\\server\\share\\bin\\gh.exe']);
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
    expect(path).not.toContain('__B4M_ENV__');
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

  it("captures the login shell's exported variables, leaving out PATH, session variables and functions", async () => {
    const shell = join(directory, 'shell');
    await writeFile(
      shell,
      [
        '#!/bin/bash',
        'printf "Shell startup output\\n"',
        'export PATH="/login/bin:/usr/bin:/bin"',
        'export B4M_TEST_SECRET="secret value"',
        "export MULTILINE='line one",
        "line two'",
        'export SHLVL=7 COLUMNS=80 LINES=24 OLDPWD=/tmp',
        'exported_function() { :; }',
        'export -f exported_function',
        'exec /bin/bash -c "$2"',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    vi.stubEnv('SHELL', shell);
    const { resolveLoginShellVariables, resolveUserPath } = await import('./userPath');

    const variables = await resolveLoginShellVariables();

    expect(variables.B4M_TEST_SECRET).toBe('secret value');
    expect(variables.MULTILINE).toBe('line one\nline two');
    for (const name of ['PATH', 'PWD', 'OLDPWD', 'SHLVL', '_', 'TERM', 'COLUMNS', 'LINES']) {
      expect(variables).not.toHaveProperty(name);
    }
    expect(Object.keys(variables).filter(name => name.includes('exported_function'))).toEqual([]);
    expect((await resolveUserPath()).split(delimiter)[0]).toBe('/login/bin');
  });

  it('keeps the login PATH but adds no variables when env cannot list with -0', async () => {
    const shell = join(directory, 'shell');
    // What an `env` without -0 (macOS before 12.3) leaves: the PATH segment and an empty listing.
    await writeFile(shell, '#!/bin/sh\nprintf "__B4M_PATH__/login/bin__B4M_PATH____B4M_ENV____B4M_ENV__"\n', {
      mode: 0o755,
    });
    vi.stubEnv('SHELL', shell);
    const { resolveLoginShellVariables, resolveUserPath } = await import('./userPath');

    expect(await resolveLoginShellVariables()).toEqual({});
    expect((await resolveUserPath()).split(delimiter)[0]).toBe('/login/bin');
  });

  it('falls back when the probe output overflows its cap', async () => {
    const shell = join(directory, 'shell');
    await writeFile(
      shell,
      '#!/bin/sh\nprintf "__B4M_PATH__/login/bin__B4M_PATH____B4M_ENV__A=1"\n' +
        "head -c 5242880 /dev/zero | tr '\\0' a\nprintf __B4M_ENV__\n",
      { mode: 0o755 }
    );
    vi.stubEnv('SHELL', shell);
    const { resolveLoginShellVariables, resolveUserPath } = await import('./userPath');

    expect(await resolveLoginShellVariables()).toEqual({});
    expect((await resolveUserPath()).split(delimiter)).not.toContain('/login/bin');
  });

  it('adds no variables and keeps the fallback PATH when the shell prints no listing', async () => {
    const shell = join(directory, 'shell');
    await writeFile(shell, '#!/bin/sh\nprintf "no listing here"\n', { mode: 0o755 });
    vi.stubEnv('SHELL', shell);
    vi.stubEnv('PATH', '/custom/bin');
    const { resolveLoginShellVariables, resolveUserPath } = await import('./userPath');

    expect(await resolveLoginShellVariables()).toEqual({});
    expect((await resolveUserPath()).split(delimiter)[0]).toBe('/custom/bin');
  });

  it('adds no variables when the shell exits with an error', async () => {
    const shell = join(directory, 'shell');
    await writeFile(shell, '#!/bin/sh\nprintf "__B4M_ENV__A=1\\0__B4M_ENV__"\nexit 1\n', { mode: 0o755 });
    vi.stubEnv('SHELL', shell);
    const { resolveLoginShellVariables } = await import('./userPath');

    expect(await resolveLoginShellVariables()).toEqual({});
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

describe('parseShellEnvironment', () => {
  it('reads the NUL-separated listing between the markers and ignores output around them', async () => {
    const { parseShellEnvironment } = await import('./userPath');

    const found = parseShellEnvironment('banner __B4M_ENV__A=1\0B=x=y\0C=two\nlines\0__B4M_ENV__ trailing');

    expect(Object.fromEntries(found ?? [])).toEqual({ A: '1', B: 'x=y', C: 'two\nlines' });
  });

  it('is null without both markers or without any variable', async () => {
    const { parseShellEnvironment } = await import('./userPath');

    expect(parseShellEnvironment('A=1\0')).toBeNull();
    expect(parseShellEnvironment('__B4M_ENV__A=1\0')).toBeNull();
    expect(parseShellEnvironment('__B4M_ENV____B4M_ENV__')).toBeNull();
  });
});
