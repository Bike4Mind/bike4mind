import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPeerIdentity, peerAccountId, peerAccountScope } from './scope.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('peer scope', () => {
  it('keeps a signed-out runtime in its local profile when another process signs in', () => {
    const profile = { userId: 'local-profile' };
    const savedSignIn = { ...profile, auth: { userId: 'signed-in-account' } };
    expect(peerAccountScope(profile, 'https://example.com', true)).toEqual(
      peerAccountScope(savedSignIn, 'https://example.com', true)
    );
    expect(peerAccountScope(savedSignIn, 'https://example.com', false)).toEqual({
      endpoint: 'https://example.com',
      userId: 'signed-in-account',
    });
  });
  it('shares a repository scope across worktrees but separates accounts and granted roots', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'b4m-peer-scope-'));
    roots.push(root);
    const repo = join(root, 'repo');
    const other = join(root, 'other');
    await mkdir(repo);
    await exec('git', ['init', repo]);
    await exec(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial'],
      { cwd: repo }
    );
    await exec('git', ['worktree', 'add', '--detach', other, 'HEAD'], { cwd: repo });
    const options = { cwd: repo, endpoint: 'http://localhost:3000', userId: 'user', threadId: 'thread' };
    const a = await createPeerIdentity(options);
    const b = await createPeerIdentity({ ...options, cwd: other });
    expect(a.projectId).toBe(b.projectId);
    expect(a.id).not.toBe(b.id);
    expect(a.generation).not.toBe(b.generation);
    const granted = await createPeerIdentity({ ...options, grantedDirectories: [root] });
    expect(granted.projectId).not.toBe(a.projectId);
    expect(peerAccountId(options.endpoint, 'other')).not.toBe(a.accountId);
    expect(peerAccountId('http://localhost:4000', 'user')).not.toBe(a.accountId);
  });

  it('scopes non-Git directories and refuses terminal control characters in names', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'b4m-peer-scope-'));
    roots.push(root);
    const options = { cwd: root, endpoint: 'local-only', userId: 'profile', threadId: 'thread' };
    expect((await createPeerIdentity(options)).accountId).toMatch(/^[a-f0-9]{64}$/);
    await expect(createPeerIdentity({ ...options, name: '\x1b[31m' })).rejects.toThrow('printable');
  });
});
