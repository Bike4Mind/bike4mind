import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ launched: 0 }));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const execFile = (_file: string, _args: unknown, _options: unknown, done: (e: null, out: string) => void) => {
    calls.launched++;
    done(null, 'zzz\n');
    return {} as never;
  };
  return { ...actual, execFile, default: { ...actual, execFile } };
});
vi.mock('../../git/hostGitArgs', () => ({
  gitCommand: async (directory: string, args: readonly string[]) => ({
    file: 'wsl.exe',
    args: [...args],
    cwd: directory,
  }),
  gitCommandEnv: async () => ({ PATH: '/usr/bin' }),
  gitArgumentPath: (_directory: string, path: string) => path,
  hostGitArgs: (args: readonly string[]) => args,
  quickGitTimeout: () => 1000,
}));
vi.mock('../../wsl/wslPath', async () => {
  const actual = await vi.importActual<typeof import('../../wsl/wslPath')>('../../wsl/wslPath');
  return {
    ...actual,
    wslLocation: (directory: string) =>
      directory.startsWith('/wsl/') ? { distro: directory.split('/')[2] as string, linuxPath: '/' } : null,
  };
});

const { gitCommandKind, withGrantedRoots } = await import('./shellWrites');

describe('gitCommandKind in WSL distros', () => {
  beforeEach(() => {
    calls.launched = 0;
  });

  const kind = (directory: string) => withGrantedRoots([], () => gitCommandKind(directory, 'zzz'));

  it('lists once per distro, as each runs its own git with its own programs', async () => {
    vi.stubEnv('PATH', '/usr/bin');
    expect(await kind('/wsl/DistroA/project')).toBe('deprecated');
    const once = calls.launched;
    expect(once).toBeGreaterThan(0);
    expect(await kind('/wsl/DistroA/other')).toBe('deprecated');
    expect(calls.launched).toBe(once);
    expect(await kind('/wsl/DistroB/project')).toBe('deprecated');
    expect(calls.launched).toBe(once * 2);
  });
});
