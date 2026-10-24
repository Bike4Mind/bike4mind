import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_GIT_CONFIG_ARGS } from '../../git/hostGitArgs';

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile }));

import { fetchRemoteFor, git } from './git';

describe('git host overrides', () => {
  beforeEach(() => {
    execFile.mockReset();
    execFile.mockImplementation((_cmd, args, _opts, cb) =>
      args[0] === 'config' ? cb(null, '') : cb(null, { stdout: '', stderr: '' })
    );
  });

  it('prefixes the config overrides on every call', async () => {
    await git('/repo', ['status', '--porcelain']);
    expect(execFile.mock.calls[0][0]).toBe('git');
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
  });
});
