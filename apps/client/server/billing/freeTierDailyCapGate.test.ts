import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';
import { TooManyRequestsError } from '@bike4mind/common';

// Hoisted mocks (vi.hoisted runs before imports)
const { getSettingsMapMock, getSettingsValueMock, resolveUserRateTierMock, findDailySpendByUserMock } = vi.hoisted(
  () => ({
    getSettingsMapMock: vi.fn().mockResolvedValue({}),
    getSettingsValueMock: vi.fn(),
    resolveUserRateTierMock: vi.fn(),
    findDailySpendByUserMock: vi.fn(),
  })
);

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

import { checkFreeTierDailySpendCap } from './freeTierDailyCapGate';

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

const mockRepo = { findDailySpendByUser: findDailySpendByUserMock } as unknown as Parameters<
  typeof checkFreeTierDailySpendCap
>[0]['usageEventRepository'];

describe('checkFreeTierDailySpendCap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips when enforceCredits is off', async () => {
    getSettingsValueMock.mockImplementation((key: string) => {
      if (key === 'enforceCredits') return false;
      return undefined;
    });

    await checkFreeTierDailySpendCap({ user: makeUser(DAY_MS), usageEventRepository: mockRepo, logger: mockLogger });

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

    await checkFreeTierDailySpendCap({ user: makeUser(DAY_MS), usageEventRepository: mockRepo, logger: mockLogger });

    expect(findDailySpendByUserMock).not.toHaveBeenCalled();
  });

  it('skips when steady-state cap is 0', async () => {
    getSettingsValueMock.mockImplementation((key: string) => {
      if (key === 'enforceCredits') return true;
      if (key === 'freeTierDailySpendCapCredits') return 0;
      return undefined;
    });
    resolveUserRateTierMock.mockResolvedValue('free');

    await checkFreeTierDailySpendCap({ user: makeUser(10 * DAY_MS), usageEventRepository: mockRepo, logger: mockLogger });

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
    await expect(
      checkFreeTierDailySpendCap({ user: makeUser(1 * 60 * 60 * 1000), usageEventRepository: mockRepo, logger: mockLogger })
    ).resolves.toBeUndefined();
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

    await expect(
      checkFreeTierDailySpendCap({ user: makeUser(1 * 60 * 60 * 1000), usageEventRepository: mockRepo, logger: mockLogger })
    ).rejects.toBeInstanceOf(TooManyRequestsError);
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

    await expect(
      checkFreeTierDailySpendCap({ user: makeUser(2 * DAY_MS), usageEventRepository: mockRepo, logger: mockLogger })
    ).rejects.toBeInstanceOf(TooManyRequestsError);
  });

  it('uses steady-state cap for an account older than 7 days', async () => {
    getSettingsValueMock.mockImplementation((key: string) => {
      if (key === 'enforceCredits') return true;
      if (key === 'freeTierDailySpendCapCredits') return 200;
      return undefined;
    });
    resolveUserRateTierMock.mockResolvedValue('free');
    findDailySpendByUserMock.mockResolvedValue(201);

    await expect(
      checkFreeTierDailySpendCap({ user: makeUser(10 * DAY_MS), usageEventRepository: mockRepo, logger: mockLogger })
    ).rejects.toBeInstanceOf(TooManyRequestsError);
  });

  it('falls back to steady-state cap when day-1 cap is 0', async () => {
    getSettingsValueMock.mockImplementation((key: string) => {
      if (key === 'enforceCredits') return true;
      if (key === 'freeTierDailySpendCapCredits') return 200;
      if (key === 'freeTierDay1SpendCapCredits') return 0;
      return undefined;
    });
    resolveUserRateTierMock.mockResolvedValue('free');
    findDailySpendByUserMock.mockResolvedValue(201);

    // day-1 cap is 0, so falls back to steady-state 200; 201 >= 200 => throws
    await expect(
      checkFreeTierDailySpendCap({ user: makeUser(1 * 60 * 60 * 1000), usageEventRepository: mockRepo, logger: mockLogger })
    ).rejects.toBeInstanceOf(TooManyRequestsError);
  });

  it('falls back to steady-state cap when days-2-7 cap is 0', async () => {
    getSettingsValueMock.mockImplementation((key: string) => {
      if (key === 'enforceCredits') return true;
      if (key === 'freeTierDailySpendCapCredits') return 200;
      if (key === 'freeTierDays2To7SpendCapCredits') return 0;
      return undefined;
    });
    resolveUserRateTierMock.mockResolvedValue('free');
    findDailySpendByUserMock.mockResolvedValue(201);

    // days-2-7 cap is 0, so falls back to steady-state 200; 201 >= 200 => throws
    await expect(
      checkFreeTierDailySpendCap({ user: makeUser(2 * DAY_MS), usageEventRepository: mockRepo, logger: mockLogger })
    ).rejects.toBeInstanceOf(TooManyRequestsError);
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
    await expect(
      checkFreeTierDailySpendCap({ user: makeUser(10 * DAY_MS), usageEventRepository: mockRepo, logger: mockLogger })
    ).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[freeTierDailyCapGate]'),
      expect.objectContaining({ error: expect.any(Error) })
    );
  });
});
