import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
