import { beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ SUPPORT_EMAIL: undefined as string | undefined }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: config }));

import { blockedSignInErrorCode, blockedSignInMessage, configuredSupportEmail } from './blockedSignIn';
import {
  getLoginErrorMessage,
  isBlockedAccountLoginError,
  withSupportContact,
} from '@client/app/utils/loginErrorMessages';

describe('blockedSignIn', () => {
  beforeEach(() => {
    config.SUPPORT_EMAIL = undefined;
  });

  it('allows an account with no block', () => {
    expect(blockedSignInErrorCode({})).toBeNull();
    expect(blockedSignInMessage({})).toBeNull();
  });

  it.each([
    [{ isBanned: true }, 'account_suspended'],
    [{ disputePending: true }, 'account_on_hold'],
    [{ moderation: { status: 'suspended' as const } }, 'account_policy_suspended'],
  ])('maps %o to a login code the login page knows', (user, code) => {
    expect(blockedSignInErrorCode(user)).toBe(code);
    expect(getLoginErrorMessage(code)).toBe(blockedSignInMessage(user));
  });

  it('names the configured support address', () => {
    config.SUPPORT_EMAIL = 'help@example.com';
    expect(blockedSignInMessage({ disputePending: true })).toBe(
      'Your account is on hold pending a payment review. Please contact support. Support: help@example.com'
    );
  });

  it.each(['not-configured', 'my-secret-placeholder-value', ''])(
    'leaves out a placeholder support address %j',
    value => {
      config.SUPPORT_EMAIL = value;
      expect(configuredSupportEmail()).toBeUndefined();
      expect(blockedSignInMessage({ disputePending: true })).not.toContain('Support:');
    }
  );

  it.each([
    [{ isBanned: true }, 'account_suspended'],
    [{ disputePending: true }, 'account_on_hold'],
    [{ moderation: { status: 'suspended' as const } }, 'account_policy_suspended'],
  ])('builds the same notice with a support address as the login page for %o', (user, code) => {
    config.SUPPORT_EMAIL = 'help@example.com';
    expect(isBlockedAccountLoginError(code)).toBe(true);
    expect(withSupportContact(getLoginErrorMessage(code)!, configuredSupportEmail())).toBe(blockedSignInMessage(user));
  });
});
