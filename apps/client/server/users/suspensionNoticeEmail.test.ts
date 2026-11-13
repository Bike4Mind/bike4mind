import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetSettingsMap, mockNotify } = vi.hoisted(() => ({
  mockGetSettingsMap: vi.fn(),
  mockNotify: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {}, userRepository: {} }));
vi.mock('@bike4mind/services', () => ({ userService: { notifyAccountSuspended: mockNotify } }));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: mockGetSettingsMap,
}));
vi.mock('@bike4mind/server-utils/utils/mailer/index', () => ({ default: { sendEmail: vi.fn() } }));
vi.mock('@server/auth/blockedSignIn', () => ({ configuredSupportEmail: () => 'support@example.com' }));

import { emailSuspensionNoticeIfEnabled } from './suspensionNoticeEmail';

const settingsWith = (enabled: boolean) => ({ suspensionNoticeEmailEnabled: String(enabled) });

describe('emailSuspensionNoticeIfEnabled', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends nothing while the setting is off', async () => {
    mockGetSettingsMap.mockResolvedValue(settingsWith(false));

    await emailSuspensionNoticeIfEnabled('u1', 'multiple_accounts');

    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('sends the notice with the stored category and the support address when on', async () => {
    mockGetSettingsMap.mockResolvedValue(settingsWith(true));

    await emailSuspensionNoticeIfEnabled('u1', 'automated_misuse');

    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', category: 'automated_misuse', supportEmail: 'support@example.com' }),
      expect.anything()
    );
  });

  it('never throws, so a failed email cannot undo or fail the suspension', async () => {
    mockGetSettingsMap.mockRejectedValue(new Error('settings unavailable'));
    const logger = { warn: vi.fn() };

    await expect(emailSuspensionNoticeIfEnabled('u1', 'automated_misuse', logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
