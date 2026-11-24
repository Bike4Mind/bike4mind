import { mkdtemp } from 'node:fs/promises';
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
});
