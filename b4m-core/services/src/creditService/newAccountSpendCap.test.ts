import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getQuestErrorCode, type IUserDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import {
  assertNewAccountSpendWithinCap,
  checkNewAccountSpendCap,
  evaluateSpendWindows,
  type NewAccountSpendCapAdapters,
  type SpendSample,
} from './newAccountSpendCap';
import { holdCredits, type CreditHoldAdapters } from './creditHold';

const settings = vi.hoisted(() => ({ current: {} as Record<string, string> }));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: vi.fn(async () => settings.current),
}));

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const NOW = new Date('2026-10-30T12:00:00.000Z');
const LIMITS = { hourlyCredits: 10_000, dailyCredits: 25_000 };
const logger = new Logger({ metadata: { test: 'newAccountSpendCap' } });

const minutesAgo = (minutes: number, credits: number): SpendSample => ({
  at: new Date(NOW.getTime() - minutes * MINUTE_MS),
  credits,
});

const newUser = (overrides: Partial<IUserDocument> = {}) =>
  ({ id: 'u1', createdAt: new Date(NOW.getTime() - DAY_MS), isAdmin: false, ...overrides }) as IUserDocument;

const makeAdapters = (samples: SpendSample[] = []) => {
  const personalSpendSince = vi.fn(async () => samples);
  const adapters: NewAccountSpendCapAdapters = {
    adminSettings: {} as NewAccountSpendCapAdapters['adminSettings'],
    personalSpendSince,
  };
  return { adapters, personalSpendSince };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  settings.current = {
    enforceCredits: 'true',
    newAccountSpendCapDays: '7',
    newAccountHourlySpendCapCredits: String(LIMITS.hourlyCredits),
    newAccountDailySpendCapCredits: String(LIMITS.dailyCredits),
  };
});

describe('evaluateSpendWindows', () => {
  it('allows a request that keeps both windows under their caps', () => {
    const samples = [minutesAgo(30, 6_000), minutesAgo(300, 10_000)];
    expect(evaluateSpendWindows({ samples, requestedCredits: 4_000, now: NOW, limits: LIMITS })).toBeNull();
  });

  it('counts the requested credits, so one large request cannot jump the cap', () => {
    const refusal = evaluateSpendWindows({ samples: [], requestedCredits: 10_001, now: NOW, limits: LIMITS });
    expect(refusal).toMatchObject({ window: 'hour', capCredits: 10_000, spentCredits: 0, resetsAt: null });
  });

  it('refuses a request that would cross the hourly cap and reports when enough spend ages out', () => {
    const samples = [minutesAgo(50, 4_000), minutesAgo(20, 5_000)];
    const refusal = evaluateSpendWindows({ samples, requestedCredits: 2_000, now: NOW, limits: LIMITS });
    // The 50-minute-old bucket leaves the hour 10 minutes from now; its minute is counted whole.
    expect(refusal).toEqual({
      window: 'hour',
      capCredits: 10_000,
      spentCredits: 9_000,
      resetsAt: new Date(NOW.getTime() + 11 * MINUTE_MS),
    });
  });

  it('rolls: spend older than the window no longer counts', () => {
    const samples = [minutesAgo(61, 9_500)];
    expect(evaluateSpendWindows({ samples, requestedCredits: 2_000, now: NOW, limits: LIMITS })).toBeNull();
  });

  it('applies the daily cap to spend spread across the day', () => {
    const samples = [minutesAgo(23 * 60, 9_000), minutesAgo(10 * 60, 9_000), minutesAgo(3 * 60, 6_000)];
    const refusal = evaluateSpendWindows({ samples, requestedCredits: 2_000, now: NOW, limits: LIMITS });
    expect(refusal).toMatchObject({ window: 'day', capCredits: 25_000, spentCredits: 24_000 });
    expect(refusal?.resetsAt).toEqual(new Date(NOW.getTime() + 61 * MINUTE_MS));
  });

  it('reports the window that frees up last when both are over', () => {
    const samples = [minutesAgo(12 * 60, 16_000), minutesAgo(10, 9_000)];
    const refusal = evaluateSpendWindows({ samples, requestedCredits: 2_000, now: NOW, limits: LIMITS });
    expect(refusal?.window).toBe('day');
  });

  it('ignores a window whose cap is 0', () => {
    const samples = [minutesAgo(10, 50_000)];
    expect(
      evaluateSpendWindows({ samples, requestedCredits: 1, now: NOW, limits: { hourlyCredits: 0, dailyCredits: 0 } })
    ).toBeNull();
  });
});

describe('checkNewAccountSpendCap', () => {
  it('passes a new account under the cap', async () => {
    const { adapters, personalSpendSince } = makeAdapters([minutesAgo(5, 1_000)]);
    await expect(
      checkNewAccountSpendCap(
        { user: newUser(), requestedCredits: 500, billedToOrganization: false, logger, now: NOW },
        adapters
      )
    ).resolves.toBeNull();
    expect(personalSpendSince).toHaveBeenCalledWith('u1', new Date(NOW.getTime() - DAY_MS));
  });

  it('refuses with the per-hour limit and the reset time', async () => {
    const { adapters } = makeAdapters([minutesAgo(50, 9_500)]);
    await expect(
      checkNewAccountSpendCap(
        { user: newUser(), requestedCredits: 1_000, billedToOrganization: false, logger, now: NOW },
        adapters
      )
    ).resolves.toBe('New accounts can spend up to 10,000 credits per hour; this resets at 12:11 UTC.');
  });

  it('names the date when the reset falls on another UTC day', async () => {
    const lateNow = new Date('2026-10-30T23:50:00.000Z');
    const { adapters } = makeAdapters([{ at: new Date('2026-10-30T23:30:00.000Z'), credits: 9_500 }]);
    await expect(
      checkNewAccountSpendCap(
        { user: newUser(), requestedCredits: 1_000, billedToOrganization: false, logger, now: lateNow },
        adapters
      )
    ).resolves.toBe('New accounts can spend up to 10,000 credits per hour; this resets at Oct 31, 00:31 UTC.');
  });

  it.each([
    ['an account older than the window', newUser({ createdAt: new Date(NOW.getTime() - 8 * DAY_MS) })],
    ['an admin-lifted account', newUser({ newAccountSpendCapLifted: true })],
    ['an admin', newUser({ isAdmin: true })],
    ['a legacy account without createdAt', newUser({ createdAt: undefined })],
  ])('does not cap %s and never reads its spend', async (_label, user) => {
    const { adapters, personalSpendSince } = makeAdapters([minutesAgo(5, 1_000_000)]);
    await expect(
      checkNewAccountSpendCap(
        { user, requestedCredits: 50_000, billedToOrganization: false, logger, now: NOW },
        adapters
      )
    ).resolves.toBeNull();
    expect(personalSpendSince).not.toHaveBeenCalled();
  });

  it('leaves org-billed usage to the org limits', async () => {
    const { adapters, personalSpendSince } = makeAdapters([minutesAgo(5, 1_000_000)]);
    await expect(
      checkNewAccountSpendCap(
        { user: newUser(), requestedCredits: 50_000, billedToOrganization: true, logger, now: NOW },
        adapters
      )
    ).resolves.toBeNull();
    expect(personalSpendSince).not.toHaveBeenCalled();
  });

  it.each([
    // enforceCredits can only be switched off on self-host; hosted always enforces.
    ['credits are not enforced on self-host', { enforceCredits: 'false' }],
    ['the account-age window is 0', { newAccountSpendCapDays: '0' }],
  ])('is off when %s', async (_label, override) => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    settings.current = { ...settings.current, ...override };
    const { adapters, personalSpendSince } = makeAdapters([minutesAgo(5, 1_000_000)]);
    await expect(
      checkNewAccountSpendCap(
        { user: newUser(), requestedCredits: 50_000, billedToOrganization: false, logger, now: NOW },
        adapters
      )
    ).resolves.toBeNull();
    expect(personalSpendSince).not.toHaveBeenCalled();
  });

  it('assertNewAccountSpendWithinCap throws the insufficient-credits error shape', async () => {
    const { adapters } = makeAdapters();
    const error = await assertNewAccountSpendWithinCap(
      { user: newUser(), requestedCredits: 30_000, billedToOrganization: false, now: NOW },
      adapters
    ).catch((err: unknown) => err);
    expect(getQuestErrorCode(error)).toBe('insufficient_credits');
    expect((error as Error).message).toBe(
      'New accounts can spend up to 10,000 credits per hour, and this request needs about 30,000. Try a smaller model or a shorter request.'
    );
  });
});

describe('holdCredits with the new-account spend cap', () => {
  const makeHoldAdapters = (user: IUserDocument, samples: SpendSample[]) => {
    const incrementCredits = vi.fn(async () => ({ id: user.id, currentCredits: 1_000_000 }) as never);
    const adapters: CreditHoldAdapters = {
      users: { findById: vi.fn(async () => user), incrementCredits },
      organizations: {} as CreditHoldAdapters['organizations'],
      creditTransactions: {} as CreditHoldAdapters['creditTransactions'],
      newAccountSpendCap: makeAdapters(samples).adapters,
    };
    return { adapters, incrementCredits };
  };

  it('refuses before any balance moves when the hold would cross the cap', async () => {
    const { adapters, incrementCredits } = makeHoldAdapters(newUser({ createdAt: new Date(Date.now() - DAY_MS) }), [
      { at: new Date(Date.now() - 5 * MINUTE_MS), credits: 9_000 },
    ]);
    const error = await holdCredits(
      { userId: 'u1', organizationId: null, requiredCredits: 2_000, featureLabel: 'video', logger },
      adapters
    ).catch((err: unknown) => err);
    expect(getQuestErrorCode(error)).toBe('insufficient_credits');
    expect(incrementCredits).not.toHaveBeenCalled();
  });

  it('holds normally under the cap', async () => {
    const { adapters, incrementCredits } = makeHoldAdapters(newUser({ createdAt: new Date(Date.now() - DAY_MS) }), []);
    await holdCredits(
      { userId: 'u1', organizationId: null, requiredCredits: 2_000, featureLabel: 'video', logger },
      adapters
    );
    expect(incrementCredits).toHaveBeenCalledWith('u1', -2_000);
  });
});
