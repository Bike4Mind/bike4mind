import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@bike4mind/observability';

const { mockGetSettingsMap, mockNotify, mockPublish, mockSmtpSend, mockFindActiveEmailsByIds } = vi.hoisted(() => ({
  mockGetSettingsMap: vi.fn(),
  mockNotify: vi.fn(),
  mockPublish: vi.fn(),
  mockSmtpSend: vi.fn(),
  mockFindActiveEmailsByIds: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  userRepository: { findActiveEmailsByIds: mockFindActiveEmailsByIds },
}));
vi.mock('@bike4mind/services', () => ({ userService: { notifyAccountSuspended: mockNotify } }));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: mockGetSettingsMap,
}));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({ EmailEvents: { Send: { publish: mockPublish } } }));
vi.mock('@bike4mind/server-utils/utils/mailer/index', () => ({ default: { sendEmail: mockSmtpSend } }));
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

describe('emailSuspensionNoticeIfEnabled through the queued mailer', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv('B4M_SELF_HOST', 'false');
    const { userService } = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
    mockNotify.mockImplementation(userService.notifyAccountSuspended);
    mockGetSettingsMap.mockResolvedValue(settingsWith(true));
    mockFindActiveEmailsByIds.mockResolvedValue([{ id: 'u1', email: 'member@example.org' }]);
    mockPublish.mockResolvedValue({ FailedEntryCount: 0, Entries: [{ EventId: 'event-1' }] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('publishes the notice as an email.send event to the suspended account', async () => {
    await emailSuspensionNoticeIfEnabled('u1', 'automated_misuse');

    expect(mockFindActiveEmailsByIds).toHaveBeenCalledWith(['u1']);
    expect(mockPublish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        to: 'member@example.org',
        subject: 'Your account has been suspended',
        body: expect.stringContaining('While the account is suspended you cannot sign in'),
      })
    );
    expect(mockSmtpSend).not.toHaveBeenCalled();
  });

  it('publishes nothing while the setting is off', async () => {
    mockGetSettingsMap.mockResolvedValue(settingsWith(false));

    await emailSuspensionNoticeIfEnabled('u1', 'automated_misuse');

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('warns and does not throw when the event cannot be queued', async () => {
    vi.spyOn(Logger, 'error').mockImplementation(() => {});
    mockPublish.mockRejectedValue(new Error('bus unreachable'));
    const logger = { warn: vi.fn() };

    await expect(emailSuspensionNoticeIfEnabled('u1', 'automated_misuse', logger)).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith('[suspension] notice email failed to send', { userId: 'u1' });
    expect(mockSmtpSend).not.toHaveBeenCalled();
  });
});
