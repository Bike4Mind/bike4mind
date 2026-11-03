import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_GIT_CONFIG_ARGS } from '../../git/hostGitArgs';

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile }));
vi.mock('./userPath', async importOriginal => ({
  ...(await importOriginal<typeof import('./userPath')>()),
  hostProgram: async (name: string) => `C:\\Git\\cmd\\${name}.exe`,
}));

import { repositoryWrite, writesOwnRepository } from './ownRepository';

describe('ownRepository host overrides', () => {
  beforeEach(() => {
    execFile.mockReset();
    execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(new Error('no git'), ''));
  });

  it('prefixes the config overrides on the default git reader, which runs git from its resolved path', async () => {
    const write = repositoryWrite(['git', 'push'], '/repo');
    expect(write).not.toBeNull();
    await writesOwnRepository(write!);
    expect(execFile).toHaveBeenCalled();
    for (const [cmd, args] of execFile.mock.calls) {
      expect(cmd).toBe('C:\\Git\\cmd\\git.exe');
      expect(args.slice(0, HOST_GIT_CONFIG_ARGS.length)).toEqual([...HOST_GIT_CONFIG_ARGS]);
    }
  });
});
