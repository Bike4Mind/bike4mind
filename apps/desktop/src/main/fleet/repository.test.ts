import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_GIT_CONFIG_ARGS } from '../git/hostGitArgs';

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile }));
vi.mock('../chat/tools/userPath', async importOriginal => ({
  ...(await importOriginal<typeof import('../chat/tools/userPath')>()),
  resolveLoginShellVariables: async () => ({}),
  hostProgram: async (name: string) => `C:\\Git\\cmd\\${name}.exe`,
}));
vi.mock('../wsl/wslPath', async importOriginal => {
  const actual = await importOriginal<typeof import('../wsl/wslPath')>();
  return {
    ...actual,
    wslLocation: (directory: string) => actual.parseWslPath(directory),
    wslCommandEnv: async () => ({}),
  };
});

import { createRepositoryResolver, gitRemoteSettings } from './repository';

beforeEach(() => {
  execFile.mockReset();
  execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, 'https://github.com/o/r.git\n'));
});

describe('fleet repository host overrides', () => {
  it('prefixes the config overrides when reading the origin url, running git from its resolved path', async () => {
    await createRepositoryResolver()('/repo');
    expect(execFile.mock.calls[0][0]).toBe('C:\\Git\\cmd\\git.exe');
    expect(execFile.mock.calls[0][1]).toEqual([
      ...HOST_GIT_CONFIG_ARGS,
      '-C',
      '/repo',
      'config',
      '--get',
      'remote.origin.url',
    ]);
  });

  it('reads every remote url and gh default under the same overrides', async () => {
    execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, 'remote.origin.url https://github.com/o/r.git\n'));

    expect(await gitRemoteSettings('/repo')).toBe('remote.origin.url https://github.com/o/r.git');
    expect(execFile.mock.calls[0][1]).toEqual([
      ...HOST_GIT_CONFIG_ARGS,
      '-C',
      '/repo',
      'config',
      '--get-regexp',
      '^remote\\..*\\.(url|gh-resolved)$',
    ]);
  });
});

describe('fleet repository reads in a WSL folder', () => {
  const REPO = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';
  const dashC = (args: readonly string[]) => args[args.indexOf('-C') + 1];

  it('hands the distro git the Linux path of the folder for -C', async () => {
    await createRepositoryResolver()(REPO);
    await gitRemoteSettings(REPO);

    expect(execFile).toHaveBeenCalledTimes(2);
    for (const [, args] of execFile.mock.calls) expect(dashC(args)).toBe('/home/me/repo');
  });
});
