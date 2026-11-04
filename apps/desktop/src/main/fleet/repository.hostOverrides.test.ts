import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_GIT_CONFIG_ARGS } from '../git/hostGitArgs';

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile }));
vi.mock('../chat/tools/userPath', async importOriginal => ({
  ...(await importOriginal<typeof import('../chat/tools/userPath')>()),
  hostProgram: async (name: string) => `C:\\Git\\cmd\\${name}.exe`,
}));

import { createRepositoryResolver, gitRemoteSettings } from './repository';

describe('fleet repository host overrides', () => {
  beforeEach(() => {
    execFile.mockReset();
    execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, 'https://github.com/o/r.git\n'));
  });

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
