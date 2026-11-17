import { describe, it, expect, vi } from 'vitest';
import { spendFrozenError, type ISpendFreeze } from '@bike4mind/common';
import { createSpendFreezeDenialReader } from './agentExecutor.spendFreeze';

const frozen = (scopeType: ISpendFreeze['scopeType']) =>
  ({ scopeType, scopeId: 'scope-1', frozenAt: new Date(), reason: 'test freeze' }) as unknown as ISpendFreeze;

function makeDeps(overrides: { findActiveForSubject?: (subject: unknown) => Promise<ISpendFreeze | null> } = {}) {
  return {
    spendFreezes: { findActiveForSubject: vi.fn(overrides.findActiveForSubject ?? (async () => null)) },
  };
}

describe('createSpendFreezeDenialReader', () => {
  it('returns null when nothing the run spends under is frozen', async () => {
    const deps = makeDeps();
    await expect(createSpendFreezeDenialReader({ userId: 'user-1' }, deps)()).resolves.toBeNull();
  });

  it('returns the tagged refusal message of the frozen scope', async () => {
    const deps = makeDeps({ findActiveForSubject: async () => frozen('User') });
    const reader = createSpendFreezeDenialReader({ userId: 'user-1' }, deps);

    await expect(reader()).resolves.toBe(spendFrozenError(frozen('User')).message);
  });

  it('checks the user, the billed organization and the API key, whoever the key bills', async () => {
    const deps = makeDeps();

    await createSpendFreezeDenialReader({ userId: 'user-1', organizationId: 'org-1', apiKeyId: 'key-1' }, deps)();

    expect(deps.spendFreezes.findActiveForSubject).toHaveBeenCalledWith({
      userId: 'user-1',
      organizationId: 'org-1',
      apiKeyId: 'key-1',
    });
  });

  it('reads the freeze live every call', async () => {
    const deps = makeDeps();
    const reader = createSpendFreezeDenialReader({ userId: 'user-1', apiKeyId: 'key-1' }, deps);

    await reader();
    await reader();

    expect(deps.spendFreezes.findActiveForSubject).toHaveBeenCalledTimes(2);
  });

  it('propagates a failed freeze read', async () => {
    const deps = makeDeps({
      findActiveForSubject: async () => {
        throw new Error('connection reset');
      },
    });

    await expect(createSpendFreezeDenialReader({ userId: 'user-1' }, deps)()).rejects.toThrow('connection reset');
  });
});
