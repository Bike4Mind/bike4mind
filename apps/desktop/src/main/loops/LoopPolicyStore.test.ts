import { describe, expect, it } from 'vitest';
import type { PrivateFile } from '../privateFile';
import { LoopPolicyStore } from './LoopPolicyStore';

function memoryFile(): PrivateFile & { text: string | null } {
  const file = {
    text: null as string | null,
    read: async () => file.text,
    write: async (contents: string) => void (file.text = contents),
  };
  return file;
}

const policy = { loopId: 'l1', loopName: 'Docs', approvalMode: 'auto' as const, directory: '/repo', approvedAt: 'now' };

describe('LoopPolicyStore', () => {
  it('keeps policies per environment across a reload, until revoked', async () => {
    const file = memoryFile();
    await new LoopPolicyStore(file).approve('hosted', policy);
    const reloaded = new LoopPolicyStore(file);
    expect(await reloaded.policy('hosted', 'l1')).toEqual(policy);
    expect(await reloaded.policy('local', 'l1')).toBeNull();
    await reloaded.revoke('hosted', 'l1');
    expect(await new LoopPolicyStore(file).policies('hosted')).toEqual([]);
  });

  it('defaults settings to off and merges patches', async () => {
    const store = new LoopPolicyStore(memoryFile());
    expect(await store.settings('hosted')).toEqual({ enabled: false, runOnBattery: false });
    await store.setSettings('hosted', { enabled: true });
    expect(await store.setSettings('hosted', { laneCap: 2 })).toEqual({
      enabled: true,
      runOnBattery: false,
      laneCap: 2,
    });
  });

  it('records, finishes and forgets runner worktrees', async () => {
    const store = new LoopPolicyStore(memoryFile());
    const worktree = {
      sessionId: 's1',
      directory: '/repo',
      path: '/w',
      branch: 'b4m/x',
      ticketId: 't',
      createdAt: 'then',
    };
    await store.recordWorktree(worktree);
    await store.finishWorktree('s1', 'later');
    expect(await store.worktrees()).toEqual([{ ...worktree, finishedAt: 'later' }]);
    await store.forgetWorktree('s1');
    expect(await store.worktrees()).toEqual([]);
  });

  it('treats a corrupt file as empty', async () => {
    const file = memoryFile();
    file.text = '{nope';
    expect(await new LoopPolicyStore(file).policies('hosted')).toEqual([]);
  });
});
