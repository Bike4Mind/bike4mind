import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile }));
vi.mock('../../wsl/wslPath', async importOriginal => {
  const actual = await importOriginal<typeof import('../../wsl/wslPath')>();
  return {
    ...actual,
    wslLocation: (directory: string) => actual.parseWslPath(directory),
    wslCommandEnv: async () => ({}),
  };
});

import { repositoryWrite, writesOwnRepository } from './ownRepository';

const REPO = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';

describe('ownRepository reads in a WSL folder', () => {
  beforeEach(() => {
    execFile.mockReset();
    execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(new Error('no git'), ''));
  });

  it('hands the distro git the Linux path of the folder for -C', async () => {
    const write = repositoryWrite(['git', 'push'], REPO);
    expect(write).not.toBeNull();

    await writesOwnRepository(write!);

    expect(execFile).toHaveBeenCalled();
    for (const [, args] of execFile.mock.calls) expect(args[args.indexOf('-C') + 1]).toBe('/home/me/repo');
  });
});
