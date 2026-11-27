import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_GIT_CONFIG_ARGS } from '../../git/hostGitArgs';

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile }));
const program = vi.hoisted(() => ({ git: 'C:\\Git\\cmd\\git.exe' as string | null }));
vi.mock('../tools/userPath', async importOriginal => ({
  ...(await importOriginal<typeof import('../tools/userPath')>()),
  resolveLoginShellVariables: async () => ({}),
  hostProgram: async () => program.git,
}));

import { fetchRemoteFor, git } from './git';

type Callback = (error: null, stdout: string | { stdout: string; stderr: string }) => void;

/** Answers the config read with `config`, the submodule listing with none, and any other call with no output. */
const answer = (config: string) => (_cmd: string, args: string[], _opts: unknown, cb: Callback) => {
  if (args[0] === 'config') return cb(null, config);
  if (args.includes('ls-files')) return cb(null, '');
  return cb(null, { stdout: '', stderr: '' });
};
const subcommands = () =>
  execFile.mock.calls.map(([, args]) => args.find((arg: string) => !arg.startsWith('-') && !arg.includes('=')));

describe('git host overrides', () => {
  beforeEach(() => {
    program.git = 'C:\\Git\\cmd\\git.exe';
    execFile.mockReset();
    execFile.mockImplementation(answer(''));
  });

  it('prefixes the config overrides on every call, running git from its resolved path', async () => {
    await git('/repo', ['rev-parse', 'HEAD']);
    expect(execFile.mock.calls[0][0]).toBe('C:\\Git\\cmd\\git.exe');
    expect(execFile.mock.calls[0][1]).toEqual([...HOST_GIT_CONFIG_ARGS, 'rev-parse', 'HEAD']);
  });

  it('pins the drivers the repository sets before a call that reads work-tree files', async () => {
    execFile.mockImplementation(answer('local\0filter.x.clean\ntouch marker\0'));
    await git('/repo', ['status', '--porcelain']);
    expect(subcommands().sort()).toEqual(['config', 'ls-files', 'status']);
    expect(execFile.mock.calls.at(-1)?.[1]).toEqual([
      ...HOST_GIT_CONFIG_ARGS,
      '-c',
      'filter.x.clean=',
      'status',
      '--porcelain',
    ]);
  });

  it('refuses a branch switch, without running it, while a filter only the repository sets is emptied', async () => {
    execFile.mockImplementation(answer('local\0filter.x.smudge\ntouch marker\0'));
    await expect(git('/repo-filter', ['switch', '--quiet', 'main'])).rejects.toThrow(
      expect.objectContaining({ name: 'GitError', message: expect.stringContaining('file filter') })
    );
    expect(subcommands().sort()).toEqual(['config', 'ls-files']);
  });

  it('adds the network overrides to fetch', async () => {
    execFile.mockImplementation((_cmd, args, _opts, cb) =>
      args[0] === 'config' ? cb(null, 'local\0core.sshcommand\ntouch marker\0') : cb(null, { stdout: '', stderr: '' })
    );
    await fetchRemoteFor('/repo-net', 'origin/main');
    const fetchCall = execFile.mock.calls.find(([, args]) => args.includes('fetch'));
    expect(fetchCall?.[1].slice(0, HOST_GIT_CONFIG_ARGS.length)).toEqual([...HOST_GIT_CONFIG_ARGS]);
    expect(fetchCall?.[1]).toContain('credential.helper=');
    expect(fetchCall?.[1]).toContain('core.sshCommand=ssh');
    expect(execFile.mock.calls.map(([file, args]) => [file, args[0]])).toEqual([
      ['C:\\Git\\cmd\\git.exe', 'config'],
      ['C:\\Git\\cmd\\git.exe', '-c'],
    ]);
  });

  it('reports git as not installed when there is none to run', async () => {
    program.git = null;
    await expect(git('/repo', ['status'])).rejects.toThrow('git is not installed');
    expect(execFile).not.toHaveBeenCalled();
  });
});
