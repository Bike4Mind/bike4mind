import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_GIT_CONFIG_ARGS } from '../../git/hostGitArgs';

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile }));

import { repositoryWrite, writesOwnRepository } from './ownRepository';

describe('ownRepository host overrides', () => {
  beforeEach(() => {
    execFile.mockReset();
    execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(new Error('no git'), ''));
  });

  it('prefixes the config overrides on the default git reader', async () => {
    const write = repositoryWrite(['git', 'push'], '/repo');
    expect(write).not.toBeNull();
    await writesOwnRepository(write!);
    expect(execFile).toHaveBeenCalled();
    for (const [cmd, args] of execFile.mock.calls) {
      expect(cmd).toBe('git');
      expect(args.slice(0, HOST_GIT_CONFIG_ARGS.length)).toEqual([...HOST_GIT_CONFIG_ARGS]);
    }
  });
});
