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

  it('keeps the inherited PATH and common locations when the shell cannot start', async () => {
    vi.stubEnv('SHELL', join(directory, 'missing-shell'));
    vi.stubEnv('PATH', '/custom/bin:/usr/bin');
    const { resolveUserPath } = await import('./userPath');

    const path = await resolveUserPath();

    expect(path.split(delimiter)).toEqual([
      '/custom/bin',
      '/usr/bin',
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
    ]);
  });
});
