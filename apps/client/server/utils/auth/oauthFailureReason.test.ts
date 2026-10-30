import { describe, it, expect } from 'vitest';
import {
  OAUTH_FAILURE_REASONS,
  resolveOAuthFailureReason,
  oauthFailureLoginErrorCode,
  SIGNUP_LIMITED_MESSAGE,
  STATE_REASON_TO_CODE,
} from './oauthFailureReason';
import { getLoginErrorMessage } from '@client/app/utils/loginErrorMessages';

describe('resolveOAuthFailureReason', () => {
  it('passes through every whitelisted canonical code unchanged', () => {
    for (const reason of OAUTH_FAILURE_REASONS) {
      expect(resolveOAuthFailureReason(reason)).toBe(reason);
    }
  });

  it('default-denies an unrecognized code to internal', () => {
    expect(resolveOAuthFailureReason('some_unknown_code')).toBe('internal');
  });

  it('default-denies a missing/undefined code to internal', () => {
    expect(resolveOAuthFailureReason(undefined)).toBe('internal');
  });

  it('default-denies non-string input to internal', () => {
    expect(resolveOAuthFailureReason({ code: 'duplicate_account' })).toBe('internal');
    expect(resolveOAuthFailureReason(null)).toBe('internal');
    expect(resolveOAuthFailureReason(123)).toBe('internal');
  });

  it('default-denies an attempt to smuggle raw error/DB text through the code field', () => {
    const rawMongoText = 'E11000 duplicate key error dup key: { username: "victim@example.com" }';
    expect(resolveOAuthFailureReason(rawMongoText)).toBe('internal');
  });
});

describe('oauthFailureLoginErrorCode', () => {
  it('maps an expired state to the retry code', () => {
    expect(oauthFailureLoginErrorCode('state_expired')).toBe('invalid_state');
  });

  it('maps closed registration to its own code so the login page can offer the waitlist', () => {
    expect(oauthFailureLoginErrorCode('registration_closed')).toBe('registration_closed');
  });

  it('maps a network signup limit to its own code, showing the same message as the OTC refusal', () => {
    expect(oauthFailureLoginErrorCode('signup_limited')).toBe('signup_limited');
    expect(getLoginErrorMessage('signup_limited')).toBe(SIGNUP_LIMITED_MESSAGE);
  });

  it('maps the sign-up email refusals to their own codes', () => {
    expect(oauthFailureLoginErrorCode('signup_email_unverified')).toBe('verified_email_required');
    expect(oauthFailureLoginErrorCode('signup_email_blocked')).toBe('signup_not_allowed');
  });

  // The reasons above are the only ones allowed to say something specific; everything
  // else must stay generic so a failure code cannot become an account oracle.
  const SPECIFIC_CODE_REASONS = [
    'state_expired',
    'registration_closed',
    'signup_limited',
    'signup_email_unverified',
    'signup_email_blocked',
  ];

  it('gives a generic code for every other canonical reason', () => {
    for (const reason of OAUTH_FAILURE_REASONS) {
      if (SPECIFIC_CODE_REASONS.includes(reason)) continue;
      expect(oauthFailureLoginErrorCode(reason)).toBe('callback_error');
    }
  });

  // The client only renders codes it knows; anything else silently becomes a generic message.
  it('emits only codes the login page knows', () => {
    for (const reason of OAUTH_FAILURE_REASONS) {
      expect(getLoginErrorMessage(oauthFailureLoginErrorCode(reason))).not.toBe(
        getLoginErrorMessage('definitely_not_a_code')
      );
    }
  });
});

describe('STATE_REASON_TO_CODE', () => {
  it('maps every jwtStateStore VerifyResult reason to a distinct canonical code', () => {
    expect(STATE_REASON_TO_CODE.missing).toBe('state_missing');
    expect(STATE_REASON_TO_CODE.expired).toBe('state_expired');
    expect(STATE_REASON_TO_CODE.invalid).toBe('state_invalid');
  });
});
