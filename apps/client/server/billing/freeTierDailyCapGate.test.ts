import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';
import { DAILY_FREE_LIMIT_REACHED_ERROR_CODE, TooManyRequestsError } from '@bike4mind/common';

// Hoisted mocks (vi.hoisted runs before imports)
const { getSettingsMapMock, getSettingsValueMock, resolveUserRateTierMock, findDailySpendByUserMock, findByIdMock } =
  vi.hoisted(() => ({
    getSettingsMapMock: vi.fn().mockResolvedValue({}),
    getSettingsValueMock: vi.fn(),
    resolveUserRateTierMock: vi.fn(),
    findDailySpendByUserMock: vi.fn(),
    findByIdMock: vi.fn(),
  }));

vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: getSettingsMapMock,
  getSettingsValue: getSettingsValueMock,
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
}));

vi.mock('@server/utils/userRateTier', () => ({
  resolveUserRateTier: resolveUserRateTierMock,
}));

import { checkFreeTierDailySpendCap, isFreeTierDailyCapError } from './freeTierDailyCapGate';

/** Build a minimal IUserDocument with a given account age. */
function makeUser(ageMs: number): IUserDocument {
  return {
    id: 'user-1',
    createdAt: new Date(Date.now() - ageMs),
    updatedAt: new Date(),
    isAdmin: false,
    tags: [],
  } as unknown as IUserDocument;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const mockLogger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as Parameters<
  typeof checkFreeTierDailySpendCap
>[0]['logger'];

const mockUsageRepo = { findDailySpendByUser: findDailySpendByUserMock } as unknown as Parameters<
  typeof checkFreeTierDailySpendCap
>[0]['usageEventRepository'];

const mockUserRepo = { findById: findByIdMock };

/** Shorthand: call the gate for a user of a given age. */
function callGate(user: IUserDocument) {
  findByIdMock.mockResolvedValue(user);
  return checkFreeTierDailySpendCap({
    userId: user.id,
    userRepository: mockUserRepo,
    usageEventRepository: mockUsageRepo,
    logger: mockLogger,
  });
}

describe('checkFreeTierDailySpendCap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips when enforceCredits is off', async () => {
    getSettingsValueMock.mockImplementation((key: string) => {
      if (key === 'enforceCredits') return false;
      return undefined;
    });

    await callGate(makeUser(DAY_MS));

    // The user lookup must not run when enforcement is disabled.
    expect(findByIdMock).not.toHaveBeenCalled();
    expect(resolveUserRateTierMock).not.toHaveBeenCalled();
    expect(findDailySpendByUserMock).not.toHaveBeenCalled();
  });

  it('skips when tier is not free', async () => {
    getSettingsValueMock.mockImplementation((key: string) => {
      if (key === 'enforceCredits') return true;
      if (key === 'freeTierDailySpendCapCredits') return 200;
      return undefined;
    });
    resolveUserRateTierMock.mockResolvedValue('pro');

    await callGate(makeUser(DAY_MS));

    expect(findDailySpendByUserMock).not.toHaveBeenCalled();
  });

  it('skips when steady-state cap is 0', async () => {
    getSettingsValueMock.mockImplementation((key: string) => {
      if (key === 'enforceCredits') return true;
      if (key === 'freeTierDailySpendCapCredits') return 0;
      return undefined;
    });
    resolveUserRateTierMock.mockResolvedValue('free');

    await callGate(makeUser(10 * DAY_MS));

    expect(findDailySpendByUserMock).not.toHaveBeenCalled();
  });

  it('uses day-1 cap for an account under 24 hours old', async () => {
    getSettingsValueMock.mockImplementation((key: string) => {
      if (key === 'enforceCredits') return true;
      if (key === 'freeTierDailySpendCapCredits') return 200;
      if (key === 'freeTierDay1SpendCapCredits') return 500;
      return undefined;
    });
    resolveUserRateTierMock.mockResolvedValue('free');
    findDailySpendByUserMock.mockResolvedValue(300);

    // Under cap - should NOT throw
    await expect(callGate(makeUser(1 * 60 * 60 * 1000))).resolves.toBeUndefined();
  });

  it('throws when day-1 cap is exceeded', async () => {
    getSettingsValueMock.mockImplementation((key: string) => {
      if (key === 'enforceCredits') return true;
      if (key === 'freeTierDailySpendCapCredits') return 200;
      if (key === 'freeTierDay1SpendCapCredits') return 500;
      return undefined;
    });
    resolveUserRateTierMock.mockResolvedValue('free');
    findDailySpendByUserMock.mockResolvedValue(500);

    await expect(callGate(makeUser(1 * 60 * 60 * 1000))).rejects.toBeInstanceOf(TooManyRequestsError);
  });

  it('uses days-2-7 cap for an account 2 days old', async () => {
    getSettingsValueMock.mockImplementation((key: string) => {
      if (key === 'enforceCredits') return true;
      if (key === 'freeTierDailySpendCapCredits') return 200;
      if (key === 'freeTierDay1SpendCapCredits') return 500;
      if (key === 'freeTierDays2To7SpendCapCredits') return 300;
      return undefined;
    });
    resolveUserRateTierMock.mockResolvedValue('free');
    findDailySpendByUserMock.mockResolvedValue(350);

    await expect(callGate(makeUser(2 * DAY_MS))).rejects.toBeInstanceOf(TooManyRequestsError);
  });

  it('uses steady-state cap for an account older than 7 days', async () => {
    getSettingsValueMock.mockImplementation((key: string) => {
      if (key === 'enforceCredits') return true;
      if (key === 'freeTierDailySpendCapCredits') return 200;
      return undefined;
    });
    resolveUserRateTierMock.mockResolvedValue('free');
    findDailySpendByUserMock.mockResolvedValue(201);

    await expect(callGate(makeUser(10 * DAY_MS))).rejects.toBeInstanceOf(TooManyRequestsError);
  });

  it('falls back to steady-state cap when day-1 cap is 0', async () => {
    getSettingsValueMock.mockImplementation((key: string) => {
      if (key === 'enforceCredits') return true;
      if (key === 'freeTierDailySpendCapCredits') return 200;
      if (key === 'freeTierDay1SpendCapCredits') return 0;
      return undefined;
    });
    resolveUserRateTierMock.mockResolvedValue('free');
    findDailySpendByUserMock.mockResolvedValue(150);

    // A day-1 cap of 0 would refuse any spend; falling back to the steady-state 200 lets 150 through.
    await expect(callGate(makeUser(1 * 60 * 60 * 1000))).resolves.toBeUndefined();
  });

  it('falls back to steady-state cap when days-2-7 cap is 0', async () => {
    getSettingsValueMock.mockImplementation((key: string) => {
      if (key === 'enforceCredits') return true;
      if (key === 'freeTierDailySpendCapCredits') return 200;
      if (key === 'freeTierDays2To7SpendCapCredits') return 0;
      return undefined;
    });
    resolveUserRateTierMock.mockResolvedValue('free');
    findDailySpendByUserMock.mockResolvedValue(150);

    // A days-2-7 cap of 0 would refuse any spend; falling back to the steady-state 200 lets 150 through.
    await expect(callGate(makeUser(2 * DAY_MS))).resolves.toBeUndefined();
  });

  it('fails open on a transient DB error', async () => {
    getSettingsValueMock.mockImplementation((key: string) => {
      if (key === 'enforceCredits') return true;
      if (key === 'freeTierDailySpendCapCredits') return 200;
      return undefined;
    });
    resolveUserRateTierMock.mockResolvedValue('free');
    findDailySpendByUserMock.mockRejectedValue(new Error('DB timeout'));

    // Should NOT throw - fail open
    await expect(callGate(makeUser(10 * DAY_MS))).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[freeTierDailyCapGate]'),
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it('refuses at exactly the cap and allows one credit under it', async () => {
    getSettingsValueMock.mockImplementation((key: string) => {
      if (key === 'enforceCredits') return true;
      if (key === 'freeTierDailySpendCapCredits') return 200;
      return undefined;
    });
    resolveUserRateTierMock.mockResolvedValue('free');
    const user = makeUser(10 * DAY_MS);

    findDailySpendByUserMock.mockResolvedValue(199);
    await expect(callGate(user)).resolves.toBeUndefined();

    findDailySpendByUserMock.mockResolvedValue(200);
    await expect(callGate(user)).rejects.toBeInstanceOf(TooManyRequestsError);
  });

  it('tags the refusal with the registered errorCode and a Retry-After until UTC midnight', async () => {
    getSettingsValueMock.mockImplementation((key: string) => {
      if (key === 'enforceCredits') return true;
      if (key === 'freeTierDailySpendCapCredits') return 200;
      return undefined;
    });
    resolveUserRateTierMock.mockResolvedValue('free');
    findDailySpendByUserMock.mockResolvedValue(250);

    const error = await callGate(makeUser(10 * DAY_MS)).catch((caught: unknown) => caught);

    expect(isFreeTierDailyCapError(error)).toBe(true);
    const info = (error as TooManyRequestsError).additionalInfo;
    expect(info).toMatchObject({ errorCode: DAILY_FREE_LIMIT_REACHED_ERROR_CODE, spentToday: 250, dailyCap: 200 });
    expect(info?.retryAfter).toBeGreaterThan(0);
    expect(info?.retryAfter).toBeLessThanOrEqual(DAY_MS / 1000);

    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    expect(findDailySpendByUserMock).toHaveBeenLastCalledWith('user-1', startOfDay);
  });

  it('applies the steady-state cap to a user without createdAt instead of failing open', async () => {
    getSettingsValueMock.mockImplementation((key: string) => {
      if (key === 'enforceCredits') return true;
      if (key === 'freeTierDailySpendCapCredits') return 200;
      if (key === 'freeTierDay1SpendCapCredits') return 500;
      return undefined;
    });
    resolveUserRateTierMock.mockResolvedValue('free');
    findDailySpendByUserMock.mockResolvedValue(300);
    const legacyUser = { id: 'user-1', isAdmin: false, tags: [] } as unknown as IUserDocument;

    await expect(callGate(legacyUser)).rejects.toBeInstanceOf(TooManyRequestsError);
  });

  it('returns without checking when the user is not found', async () => {
    getSettingsValueMock.mockImplementation((key: string) => {
      if (key === 'enforceCredits') return true;
      return undefined;
    });
    findByIdMock.mockResolvedValue(null);

    await expect(
      checkFreeTierDailySpendCap({
        userId: 'ghost-user',
        userRepository: mockUserRepo,
        usageEventRepository: mockUsageRepo,
        logger: mockLogger,
      })
    ).resolves.toBeUndefined();

    expect(resolveUserRateTierMock).not.toHaveBeenCalled();
  });

  it('does not treat an unrelated 429 as the daily cap', () => {
    expect(isFreeTierDailyCapError(new TooManyRequestsError('slow down'))).toBe(false);
  });
});
