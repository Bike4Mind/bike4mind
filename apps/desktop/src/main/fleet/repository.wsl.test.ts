import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile }));
vi.mock('../wsl/wslPath', async importOriginal => {
  const actual = await importOriginal<typeof import('../wsl/wslPath')>();
  return {
    ...actual,
    wslLocation: (directory: string) => actual.parseWslPath(directory),
    wslCommandEnv: async () => ({}),
  };
});

import { createRepositoryResolver, gitRemoteSettings } from './repository';

const REPO = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';

const dashC = (args: readonly string[]) => args[args.indexOf('-C') + 1];

describe('fleet repository reads in a WSL folder', () => {
  beforeEach(() => {
    execFile.mockReset();
    execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, 'https://github.com/o/r.git\n'));
  });

  it('hands the distro git the Linux path of the folder for -C', async () => {
    await createRepositoryResolver()(REPO);
    await gitRemoteSettings(REPO);

    expect(execFile).toHaveBeenCalledTimes(2);
    for (const [, args] of execFile.mock.calls) expect(dashC(args)).toBe('/home/me/repo');
  });
});
