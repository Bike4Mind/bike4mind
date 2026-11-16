import { describe, it, expect, vi } from 'vitest';
import { CreditHolderType, spendFrozenError, type ISpendFreeze } from '@bike4mind/common';
import { createSpendFreezeDenialReader } from './agentExecutor.spendFreeze';

const frozen = (scopeType: ISpendFreeze['scopeType']) =>
  ({ scopeType, scopeId: 'scope-1', frozenAt: new Date(), reason: 'test freeze' }) as unknown as ISpendFreeze;

function makeDeps(
  overrides: {
    findActiveForSubject?: (subject: unknown) => Promise<ISpendFreeze | null>;
    billingOwnerType?: CreditHolderType;
  } = {}
) {
  return {
    spendFreezes: { findActiveForSubject: vi.fn(overrides.findActiveForSubject ?? (async () => null)) },
    readKeyBillingOwnerType: vi.fn(async () => overrides.billingOwnerType),
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

  it('checks the user, the billed organization and the API key of a personal-billed key', async () => {
    const deps = makeDeps({ billingOwnerType: CreditHolderType.User });

    await createSpendFreezeDenialReader({ userId: 'user-1', organizationId: 'org-1', apiKeyId: 'key-1' }, deps)();

    expect(deps.spendFreezes.findActiveForSubject).toHaveBeenCalledWith({
      userId: 'user-1',
      organizationId: 'org-1',
      apiKeyId: 'key-1',
    });
  });

  it('drops the creator for an org-billed key, so a frozen creator does not stop the org', async () => {
    const deps = makeDeps({ billingOwnerType: CreditHolderType.Organization });

    await createSpendFreezeDenialReader({ userId: 'user-1', organizationId: 'org-1', apiKeyId: 'key-1' }, deps)();

    expect(deps.spendFreezes.findActiveForSubject).toHaveBeenCalledWith({
      userId: null,
      organizationId: 'org-1',
      apiKeyId: 'key-1',
    });
  });

  it('keeps the user when the key record or its billing type is missing', async () => {
    const deps = makeDeps({ billingOwnerType: undefined });

    await createSpendFreezeDenialReader({ userId: 'user-1', apiKeyId: 'key-1' }, deps)();

    expect(deps.spendFreezes.findActiveForSubject).toHaveBeenCalledWith({
      userId: 'user-1',
      organizationId: null,
      apiKeyId: 'key-1',
    });
  });

  it('reads the freeze live every call but resolves the key billing type once', async () => {
    const deps = makeDeps({ billingOwnerType: CreditHolderType.User });
    const reader = createSpendFreezeDenialReader({ userId: 'user-1', apiKeyId: 'key-1' }, deps);

    await reader();
    await reader();

    expect(deps.spendFreezes.findActiveForSubject).toHaveBeenCalledTimes(2);
    expect(deps.readKeyBillingOwnerType).toHaveBeenCalledTimes(1);
  });

  it('does not look up a key for a run without one', async () => {
    const deps = makeDeps();
    await createSpendFreezeDenialReader({ userId: 'user-1' }, deps)();
    expect(deps.readKeyBillingOwnerType).not.toHaveBeenCalled();
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
