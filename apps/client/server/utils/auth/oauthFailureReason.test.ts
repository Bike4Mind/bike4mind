import { describe, it, expect } from 'vitest';
import {
  OAUTH_FAILURE_REASONS,
  resolveOAuthFailureReason,
  oauthFailureRedirectMessage,
  STATE_REASON_TO_CODE,
} from './oauthFailureReason';

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

describe('oauthFailureRedirectMessage', () => {
  it('gives a retry hint for an expired state', () => {
    expect(oauthFailureRedirectMessage('state_expired')).toMatch(/expired/i);
  });

  it('gives a generic message for every other canonical reason', () => {
    for (const reason of OAUTH_FAILURE_REASONS) {
      if (reason === 'state_expired') continue;
      expect(oauthFailureRedirectMessage(reason)).toBe('Authentication failed');
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
