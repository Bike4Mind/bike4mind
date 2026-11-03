import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_GIT_CONFIG_ARGS } from '../../git/hostGitArgs';

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile }));
const program = vi.hoisted(() => ({ git: 'C:\\Git\\cmd\\git.exe' as string | null }));
vi.mock('../tools/userPath', async importOriginal => ({
  ...(await importOriginal<typeof import('../tools/userPath')>()),
  hostProgram: async () => program.git,
}));

import { fetchRemoteFor, git } from './git';

describe('git host overrides', () => {
  beforeEach(() => {
    program.git = 'C:\\Git\\cmd\\git.exe';
    execFile.mockReset();
    execFile.mockImplementation((_cmd, args, _opts, cb) =>
      args[0] === 'config' ? cb(null, '') : cb(null, { stdout: '', stderr: '' })
    );
  });

  it('prefixes the config overrides on every call, running git from its resolved path', async () => {
    await git('/repo', ['status', '--porcelain']);
    expect(execFile.mock.calls[0][0]).toBe('C:\\Git\\cmd\\git.exe');
    expect(execFile.mock.calls[0][1]).toEqual([...HOST_GIT_CONFIG_ARGS, 'status', '--porcelain']);
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
