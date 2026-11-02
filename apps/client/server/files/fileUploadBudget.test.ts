// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vitest.setup.ts passes this module through for every other suite.
vi.unmock('@server/files/fileUploadBudget');

const mocks = vi.hoisted(() => ({
  tryAdd: vi.fn(),
  getSettingsMap: vi.fn(),
  resolveUserRateTier: vi.fn(),
  isDevelopment: vi.fn(() => false),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  cacheRepository: { tryAddWithinLimitFixedWindow: mocks.tryAdd },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: mocks.getSettingsMap,
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ isDevelopment: mocks.isDevelopment }));
vi.mock('@server/utils/userRateTier', () => ({ resolveUserRateTier: mocks.resolveUserRateTier }));

import { TooManyRequestsError } from '@bike4mind/common';
import { consumeFileUploadBudget, FILE_UPLOAD_LIMITED, FILE_UPLOAD_WINDOW_MS } from './fileUploadBudget';

const WINDOW_END = new Date(Date.now() + 20 * 60_000);
const req = { user: { id: 'u1', isAdmin: false, tags: [] } } as unknown as Parameters<
  typeof consumeFileUploadBudget
>[0];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isDevelopment.mockReturnValue(false);
  mocks.resolveUserRateTier.mockResolvedValue('free');
  mocks.getSettingsMap.mockResolvedValue({ fileUploadLimitFreePerHour: '300', fileUploadLimitPaidPerHour: '3000' });
  mocks.tryAdd.mockResolvedValue({ success: true, count: 1, expiresAt: WINDOW_END });
});

describe('consumeFileUploadBudget', () => {
  it('spends one unit per file from a single per-user hourly bucket', async () => {
    await consumeFileUploadBudget(req, 100);

    expect(mocks.tryAdd).toHaveBeenCalledWith('rate-limit:u1:file-upload', 100, 300, FILE_UPLOAD_WINDOW_MS);
    expect(FILE_UPLOAD_WINDOW_MS).toBe(60 * 60 * 1000);
  });

  it.each([
    ['free', 300],
    ['shadow', 300],
    ['basic', 3000],
    ['pro', 3000],
  ])('charges the %s tier its configured allowance', async (tier, limit) => {
    mocks.resolveUserRateTier.mockResolvedValue(tier);

    await consumeFileUploadBudget(req, 1);

    expect(mocks.tryAdd).toHaveBeenCalledWith(expect.any(String), 1, limit, FILE_UPLOAD_WINDOW_MS);
  });

  it.each([
    ['the tier', () => mocks.resolveUserRateTier.mockRejectedValue(new Error('subscriptions unavailable'))],
    ['the setting', () => mocks.getSettingsMap.mockRejectedValue(new Error('settings unavailable'))],
  ])('applies the free allowance when %s cannot be read', async (_what, fail) => {
    mocks.resolveUserRateTier.mockResolvedValue('pro');
    fail();

    await consumeFileUploadBudget(req, 1);

    expect(mocks.tryAdd).toHaveBeenCalledWith(expect.any(String), 1, 300, FILE_UPLOAD_WINDOW_MS);
  });

  it('tells a caller whose request exceeds the whole allowance to send fewer files, not to wait', async () => {
    mocks.getSettingsMap.mockResolvedValue({ fileUploadLimitFreePerHour: '50' });
    mocks.tryAdd.mockResolvedValue({ success: false, count: 0, expiresAt: WINDOW_END });

    const error = await consumeFileUploadBudget(req, 100).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TooManyRequestsError);
    expect((error as TooManyRequestsError).message).toContain('Upload fewer files at a time');
    expect((error as TooManyRequestsError).additionalInfo?.retryAfter).toBeUndefined();
  });

  it('refuses a request with no signed-in user without touching the counter', async () => {
    await expect(consumeFileUploadBudget({} as typeof req, 1)).rejects.toThrow('Sign in to upload files');
    expect(mocks.tryAdd).not.toHaveBeenCalled();
  });

  it('refuses with a 429 carrying Retry-After when the files do not fit', async () => {
    mocks.tryAdd.mockResolvedValue({ success: false, count: 250, expiresAt: WINDOW_END });

    const error = await consumeFileUploadBudget(req, 100).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TooManyRequestsError);
    const { additionalInfo } = error as TooManyRequestsError;
    expect(additionalInfo).toMatchObject({ code: FILE_UPLOAD_LIMITED, details: { limit: 300, requested: 100 } });
    expect(additionalInfo?.retryAfter).toBeGreaterThan(19 * 60);
    expect(additionalInfo?.retryAfter).toBeLessThanOrEqual(20 * 60);
  });

  it('blocks every upload when the tier limit is set to 0', async () => {
    mocks.getSettingsMap.mockResolvedValue({ fileUploadLimitFreePerHour: '0' });
    mocks.tryAdd.mockResolvedValue({ success: false, count: 0, expiresAt: WINDOW_END });

    await expect(consumeFileUploadBudget(req, 1)).rejects.toThrow('File uploads are currently blocked');
    expect(mocks.tryAdd).toHaveBeenCalledWith(expect.any(String), 1, 0, FILE_UPLOAD_WINDOW_MS);
  });

  it.each([
    ['free', 300],
    ['pro', 3000],
  ])('falls back to the %s schema default when the setting is unset', async (tier, limit) => {
    mocks.resolveUserRateTier.mockResolvedValue(tier);
    mocks.getSettingsMap.mockResolvedValue({});

    await consumeFileUploadBudget(req, 1);

    expect(mocks.tryAdd).toHaveBeenCalledWith(expect.any(String), 1, limit, FILE_UPLOAD_WINDOW_MS);
  });

  it('does not count admins, developer-tagged users or the dev server', async () => {
    mocks.resolveUserRateTier.mockResolvedValue('bypass');
    await consumeFileUploadBudget(req, 50);

    mocks.resolveUserRateTier.mockResolvedValue('free');
    mocks.isDevelopment.mockReturnValue(true);
    await consumeFileUploadBudget(req, 50);

    expect(mocks.tryAdd).not.toHaveBeenCalled();
  });

  it('spends nothing for an empty request', async () => {
    await consumeFileUploadBudget(req, 0);

    expect(mocks.resolveUserRateTier).not.toHaveBeenCalled();
    expect(mocks.tryAdd).not.toHaveBeenCalled();
  });
});
