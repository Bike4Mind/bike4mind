import { mkdir, mkdtemp, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectTrustStore } from './ProjectTrustStore';

const MAIN = '/work/repo';
const WORKTREE = '/work/repo/.b4m/worktrees/task';

async function store(inheritsFrom?: (directory: string) => Promise<string | null>): Promise<ProjectTrustStore> {
  const directory = await mkdtemp(join(tmpdir(), 'b4m-trust-'));
  return new ProjectTrustStore(join(directory, 'trust.json'), inheritsFrom);
}

describe('ProjectTrustStore', () => {
  it('matches exactly when nothing is inherited', async () => {
    const trust = await store();
    await trust.trust(MAIN);
    expect(await trust.isTrusted(MAIN)).toBe(true);
    expect(await trust.isTrusted(WORKTREE)).toBe(false);
  });

  it('trusts an app worktree whose main checkout is trusted', async () => {
    const trust = await store(async directory => (directory === WORKTREE ? MAIN : null));
    expect(await trust.isTrusted(WORKTREE)).toBe(false);
    await trust.trust(MAIN);
    expect(await trust.isTrusted(WORKTREE)).toBe(true);
    expect(await trust.isTrusted('/work/other')).toBe(false);
  });

  it('drops the inherited trust when the main checkout is revoked', async () => {
    const trust = await store(async () => MAIN);
    await trust.trust(MAIN);
    await trust.revoke(MAIN);
    expect(await trust.isTrusted(WORKTREE)).toBe(false);
  });

  it('fails closed when the owner cannot be resolved', async () => {
    const trust = await store(async () => {
      throw new Error('unreadable');
    });
    await trust.trust(MAIN);
    expect(await trust.isTrusted(WORKTREE)).toBe(false);
  });

  it('records trust given inside a worktree against its main checkout', async () => {
    const sibling = '/work/repo/.b4m/worktrees/other';
    const trust = await store(async directory => (directory === MAIN ? null : MAIN));
    expect(await trust.trust(WORKTREE)).toEqual([MAIN]);
    expect(await trust.isTrusted(sibling)).toBe(true);
    expect(await trust.isTrusted(MAIN)).toBe(true);
  });

  it('revokes the main checkout when trust is removed inside a worktree', async () => {
    const trust = await store(async directory => (directory === MAIN ? null : MAIN));
    await trust.trust(MAIN);
    expect(await trust.revoke(WORKTREE)).toEqual([]);
    expect(await trust.isTrusted(WORKTREE)).toBe(false);
  });

  it('inherits from a project that was trusted through a symlink', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-trust-link-')));
    const real = join(root, 'repo');
    const link = join(root, 'link');
    await mkdir(real);
    await symlink(real, link);
    const worktree = join(real, '.b4m', 'worktrees', 'task');
    const trust = await store(async directory => (directory === worktree ? real : null));
    await trust.trust(link);
    expect(await trust.isTrusted(worktree)).toBe(true);
    expect(await trust.trust(worktree)).toEqual([link]);
    expect(await trust.revoke(worktree)).toEqual([]);
  });

  it('names the entry a worktree decision is recorded against', async () => {
    const trust = await store(async directory => (directory === WORKTREE ? MAIN : null));
    expect(await trust.recordedPath(WORKTREE)).toBe(MAIN);
    expect(await trust.recordedPath('/work/other')).toBe('/work/other');
  });
});
