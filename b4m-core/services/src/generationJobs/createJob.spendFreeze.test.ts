import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isSpendFrozenError, type ISpendFreeze, type IUserDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import type { CreditHoldAdapters } from '../creditService/creditHold';
import { holdJobCredits } from './createJob';

const logger = new Logger({ metadata: { test: 'holdJobCredits spend freeze' } });
const user = { id: 'u1', organizationId: null };
const freeze = { scopeType: 'User', frozenAt: new Date('2026-11-16T00:00:00Z') } as ISpendFreeze;

const makeDeps = (frozen: ISpendFreeze | null) => {
  const incrementCredits = vi.fn(async () => ({ id: 'u1', currentCredits: 100 }));
  const credits = {
    users: { findById: vi.fn(async () => ({ id: 'u1', currentCredits: 100 }) as IUserDocument), incrementCredits },
    organizations: {},
    creditTransactions: {},
    newAccountSpendCap: {
      adminSettings: { findAll: vi.fn(async () => []), findBySettingNames: vi.fn(async () => []) },
      personalSpendSince: vi.fn(async () => []),
    },
    spendFreezes: { findActiveForSubject: vi.fn(async () => frozen) },
  } as unknown as CreditHoldAdapters;
  return { deps: { credits, logger }, incrementCredits };
};

const params = (enforceCredits: boolean) => ({ enforceCredits, user, requiredCredits: 30, featureLabel: 'video' });

describe('holdJobCredits spend freeze', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws the 403 spend_frozen error rather than returning the 402 value', async () => {
    const { deps, incrementCredits } = makeDeps(freeze);
    const error = await holdJobCredits(params(true), deps).catch((err: unknown) => err);
    expect(isSpendFrozenError(error)).toBe(true);
    expect(incrementCredits).not.toHaveBeenCalled();
  });

  it('refuses a frozen subject even when credits are not enforced', async () => {
    const { deps } = makeDeps(freeze);
    const error = await holdJobCredits(params(false), deps).catch((err: unknown) => err);
    expect(isSpendFrozenError(error)).toBe(true);
  });

  it('checks the API key the job was created with', async () => {
    const { deps } = makeDeps(null);
    await holdJobCredits({ ...params(false), apiKeyId: 'k1' }, deps);
    expect(deps.credits.spendFreezes.findActiveForSubject).toHaveBeenCalledWith({
      userId: 'u1',
      organizationId: null,
      apiKeyId: 'k1',
    });
  });

  it('holds normally when nothing is frozen', async () => {
    const { deps } = makeDeps(null);
    expect(await holdJobCredits(params(true), deps)).toMatchObject({ ok: true, hold: { reservedCredits: 30 } });
    expect(deps.credits.spendFreezes.findActiveForSubject).toHaveBeenCalledTimes(1);
  });
});
