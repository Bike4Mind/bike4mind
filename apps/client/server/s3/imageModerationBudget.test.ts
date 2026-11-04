// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tryAdd: vi.fn(),
  getSettingsMap: vi.fn(),
  resolveUserRateTier: vi.fn(),
  isDevelopment: vi.fn(() => false),
  getSettingsValue: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  cacheRepository: { tryAddWithinLimitFixedWindow: mocks.tryAdd },
}));
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  mocks.getSettingsValue.mockImplementation(actual.getSettingsValue);
  return { ...actual, getSettingsMap: mocks.getSettingsMap, getSettingsValue: mocks.getSettingsValue };
});
vi.mock('@bike4mind/server-utils/utils/config', () => ({ isDevelopment: mocks.isDevelopment }));
vi.mock('@server/utils/userRateTier', () => ({ resolveUserRateTier: mocks.resolveUserRateTier }));

import { IMAGE_MODERATION_WINDOW_MS, reserveImageModerationCalls } from './imageModerationBudget';

const user = { id: 'u1', isAdmin: false, tags: [] };
const WINDOW_END = new Date(Date.now() + 60 * 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isDevelopment.mockReturnValue(false);
  mocks.resolveUserRateTier.mockResolvedValue('free');
  mocks.getSettingsMap.mockResolvedValue({
    imageModerationLimitFreePerDay: '200',
    imageModerationLimitPaidPerDay: '2000',
  });
  mocks.tryAdd.mockResolvedValue({ success: true, count: 1, expiresAt: WINDOW_END });
});

describe('reserveImageModerationCalls', () => {
  it('spends the calls from a per-user daily bucket, resolving the tier without a request', async () => {
    await expect(reserveImageModerationCalls(user, 10)).resolves.toBe(true);

    expect(mocks.resolveUserRateTier).toHaveBeenCalledWith(user);
    expect(mocks.tryAdd).toHaveBeenCalledWith('rate-limit:u1:image-moderation', 10, 200, IMAGE_MODERATION_WINDOW_MS);
    expect(IMAGE_MODERATION_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it.each([
    ['free', 200],
    ['shadow', 200],
    ['basic', 2000],
    ['pro', 2000],
  ])('charges the %s tier its configured allowance', async (tier, limit) => {
    mocks.resolveUserRateTier.mockResolvedValue(tier);

    await reserveImageModerationCalls(user, 1);

    expect(mocks.tryAdd).toHaveBeenCalledWith(expect.any(String), 1, limit, IMAGE_MODERATION_WINDOW_MS);
  });

  it('refuses calls that do not fit, including a request larger than the whole allowance', async () => {
    mocks.tryAdd.mockResolvedValue({ success: false, count: 195, expiresAt: WINDOW_END });

    await expect(reserveImageModerationCalls(user, 10)).resolves.toBe(false);
    await expect(reserveImageModerationCalls(user, 500)).resolves.toBe(false);
  });

  it('passes the exact boundary to the all-or-nothing counter', async () => {
    mocks.getSettingsMap.mockResolvedValue({ imageModerationLimitFreePerDay: '10' });

    await expect(reserveImageModerationCalls(user, 10)).resolves.toBe(true);
    expect(mocks.tryAdd).toHaveBeenCalledWith(expect.any(String), 10, 10, IMAGE_MODERATION_WINDOW_MS);
  });

  it.each([
    ['the tier', () => mocks.resolveUserRateTier.mockRejectedValue(new Error('subscriptions unavailable'))],
    ['the setting', () => mocks.getSettingsMap.mockRejectedValue(new Error('settings unavailable'))],
  ])('applies the free allowance when %s cannot be read', async (_what, fail) => {
    mocks.resolveUserRateTier.mockResolvedValue('pro');
    fail();

    await reserveImageModerationCalls(user, 1);

    expect(mocks.tryAdd).toHaveBeenCalledWith(expect.any(String), 1, 200, IMAGE_MODERATION_WINDOW_MS);
  });

  it.each([
    ['free', 200],
    ['pro', 2000],
  ])('falls back to the %s schema default when the setting is unset', async (tier, limit) => {
    mocks.resolveUserRateTier.mockResolvedValue(tier);
    mocks.getSettingsMap.mockResolvedValue({});

    await reserveImageModerationCalls(user, 1);

    expect(mocks.tryAdd).toHaveBeenCalledWith(expect.any(String), 1, limit, IMAGE_MODERATION_WINDOW_MS);
  });

  it('applies the free allowance when the setting resolves to nothing', async () => {
    mocks.resolveUserRateTier.mockResolvedValue('pro');
    mocks.getSettingsValue.mockReturnValueOnce(undefined);

    await reserveImageModerationCalls(user, 1);

    expect(mocks.tryAdd).toHaveBeenCalledWith(expect.any(String), 1, 200, IMAGE_MODERATION_WINDOW_MS);
  });

  it('keeps an explicit 0, which refuses every scan', async () => {
    mocks.getSettingsMap.mockResolvedValue({ imageModerationLimitFreePerDay: '0' });
    mocks.tryAdd.mockResolvedValue({ success: false, count: 0, expiresAt: WINDOW_END });

    await expect(reserveImageModerationCalls(user, 1)).resolves.toBe(false);
    expect(mocks.tryAdd).toHaveBeenCalledWith(expect.any(String), 1, 0, IMAGE_MODERATION_WINDOW_MS);
  });

  it('does not count admins, developer-tagged users or the dev server', async () => {
    mocks.resolveUserRateTier.mockResolvedValue('bypass');
    await expect(reserveImageModerationCalls(user, 50)).resolves.toBe(true);

    mocks.resolveUserRateTier.mockResolvedValue('free');
    mocks.isDevelopment.mockReturnValue(true);
    await expect(reserveImageModerationCalls(user, 50)).resolves.toBe(true);

    expect(mocks.tryAdd).not.toHaveBeenCalled();
  });

  it('spends nothing for zero calls', async () => {
    await expect(reserveImageModerationCalls(user, 0)).resolves.toBe(true);

    expect(mocks.resolveUserRateTier).not.toHaveBeenCalled();
    expect(mocks.tryAdd).not.toHaveBeenCalled();
  });
});
