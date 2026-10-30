import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_GIT_CONFIG_ARGS } from '../git/hostGitArgs';

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile }));

import { createRepositoryResolver } from './repository';

describe('fleet repository host overrides', () => {
  beforeEach(() => {
    execFile.mockReset();
    execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, 'https://github.com/o/r.git\n'));
  });

  it('prefixes the config overrides when reading the origin url', async () => {
    await createRepositoryResolver()('/repo');
    expect(execFile.mock.calls[0][0]).toBe('git');
    expect(execFile.mock.calls[0][1]).toEqual([
      ...HOST_GIT_CONFIG_ARGS,
      '-C',
      '/repo',
      'config',
      '--get',
      'remote.origin.url',
    ]);
  });
});
