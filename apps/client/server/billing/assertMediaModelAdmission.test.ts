vi.mock('@server/billing/reserveRequestCredits', () => ({ reserveRequestCredits: vi.fn() }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_REQUIRES_SUBSCRIPTION_ERROR_CODE, PAID_PLAN_ENTITLEMENT_KEY } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  entitlements: vi.fn(),
  settings: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: mocks.user },
  adminSettingsRepository: { findOne: async () => null },
  organizationRepository: {},
  usageEventRepository: {},
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: mocks.settings,
}));
vi.mock('@server/entitlements', () => ({ getUserEntitlements: mocks.entitlements }));
import { assertMediaModelAdmission, filterAdmittedMediaModels } from './assertMediaModelAdmission';

describe('media model admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user.mockResolvedValue({ id: 'user-1', currentCredits: 10_000 });
    mocks.entitlements.mockResolvedValue(['base']);
    mocks.settings.mockResolvedValue({
      freeTierModelGateEnabled: 'true',
      freeTierAllowedModels: '["cheap-text"]',
      enforceCredits: 'true',
    });
  });

  it.each(['image-model', 'video-model', 'music_v1', 'eleven_text_to_sound_v2', 'tts-1', 'gpt-realtime-1.5'])(
    'refuses a free account with credits from %s with the existing paid-plan code',
    async modelId => {
      await expect(assertMediaModelAdmission('user-1', modelId)).rejects.toMatchObject({
        additionalInfo: { errorCode: MODEL_REQUIRES_SUBSCRIPTION_ERROR_CODE },
      });
      expect(mocks.user).toHaveBeenCalledWith('user-1');
    }
  );

  it('uses a loaded user document without re-fetching it', async () => {
    const user = { id: 'user-1', currentCredits: 10_000 } as Parameters<typeof filterAdmittedMediaModels>[0];
    await expect(assertMediaModelAdmission(user, 'image-model')).rejects.toMatchObject({
      additionalInfo: { errorCode: MODEL_REQUIRES_SUBSCRIPTION_ERROR_CODE },
    });
    expect(mocks.user).not.toHaveBeenCalled();
  });

  it('filters video/music picker choices with the same admission rule', async () => {
    const models = [{ id: 'music_v1' }, { id: 'video-model' }];
    const user = { id: 'user-1' } as Parameters<typeof filterAdmittedMediaModels>[0];
    expect(await filterAdmittedMediaModels(user, models)).toEqual([]);
    mocks.settings.mockResolvedValue({
      freeTierModelGateEnabled: 'true',
      freeTierAllowedModels: '["music_v1"]',
    });
    expect(await filterAdmittedMediaModels(user, models)).toEqual([{ id: 'music_v1' }]);
  });

  it('preserves an API key caller whose admin role was withheld on the request', async () => {
    mocks.user.mockImplementation(async () => ({ id: 'user-1', isAdmin: true, currentCredits: 10_000 }));
    await expect(assertMediaModelAdmission('user-1', 'image-model', true)).rejects.toMatchObject({
      additionalInfo: { errorCode: MODEL_REQUIRES_SUBSCRIPTION_ERROR_CODE },
    });
    await expect(assertMediaModelAdmission('user-1', 'image-model', false)).resolves.toBeUndefined();
  });

  it('allows the same media model with a paid plan', async () => {
    mocks.entitlements.mockResolvedValue([PAID_PLAN_ENTITLEMENT_KEY]);
    await expect(assertMediaModelAdmission('user-1', 'image-model')).resolves.toBeUndefined();
  });

  it('fails closed with a retryable error if plan lookup fails', async () => {
    mocks.entitlements.mockRejectedValue(new Error('unavailable'));
    await expect(assertMediaModelAdmission('user-1', 'image-model')).rejects.toMatchObject({ statusCode: 503 });
  });
});
