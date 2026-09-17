import { describe, it, expect, beforeAll } from 'vitest';
import { configureSlackPackage } from './di/registry';
import type { JwtStateStoreOptions, VerifyResult, BaseStatePayload } from './di/types';
import { generateUserLinkStateToken, verifyUserLinkStateToken } from './user-link-helpers';
import { generateOrgSlackConnectStateToken, verifyOrgSlackConnectStateToken } from './org-slack-helpers';

/**
 * Guards the browser-binding wiring in the Slack OAuth state helpers: the two
 * generate/verify pairs must thread the nonce hash through to the injected
 * jwtStateStore. If a helper drops its nonce argument (the silent-disable footgun),
 * these tests fail - a token minted for browser A would verify in browser B.
 *
 * A faithful reference jwtStateStore stands in for the host's real impl (which lives
 * in apps/client and cannot be imported here); it mirrors the `nh` claim semantics:
 * embed only when a hash is passed, enforce only when an expected hash is passed.
 */
const referenceJwtStateStore = {
  createStateToken<T extends Record<string, unknown>>(
    options: JwtStateStoreOptions,
    additionalPayload?: T,
    nonceHash?: string
  ): string {
    return JSON.stringify({
      aud: options.audience,
      iss: 'bike4mind',
      ...additionalPayload,
      ...(nonceHash ? { nh: nonceHash } : {}),
    });
  },
  verifyStateToken<T extends BaseStatePayload>(
    token: string,
    options: JwtStateStoreOptions,
    expectedNonceHash?: string | null
  ): VerifyResult<T> {
    let decoded: { aud?: string; nh?: unknown } & Record<string, unknown>;
    try {
      decoded = JSON.parse(token);
    } catch {
      return { valid: false, reason: 'invalid', message: 'Invalid authorization state.' };
    }
    if (decoded.aud !== options.audience) {
      return { valid: false, reason: 'invalid', message: 'Invalid authorization state.' };
    }
    if (expectedNonceHash !== undefined) {
      if (typeof decoded.nh !== 'string' || decoded.nh.length === 0 || decoded.nh !== expectedNonceHash) {
        return { valid: false, reason: 'invalid', message: 'Invalid authorization state.' };
      }
    }
    return { valid: true, payload: decoded as unknown as T };
  },
  validateJwtSecret: () => 'test-secret',
};

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

beforeAll(() => {
  configureSlackPackage({ jwtStateStore: referenceJwtStateStore } as any, {} as any);
});

describe('Slack user-link state browser-binding', () => {
  it('rejects a state completed in a different browser (cookie mismatch or absent)', () => {
    const token = generateUserLinkStateToken('user-1', HASH_A);
    expect(verifyUserLinkStateToken(token, HASH_B).valid).toBe(false);
    expect(verifyUserLinkStateToken(token, null).valid).toBe(false);
  });

  it('accepts the state in the initiating browser', () => {
    const token = generateUserLinkStateToken('user-1', HASH_A);
    const result = verifyUserLinkStateToken(token, HASH_A);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.payload.userId).toBe('user-1');
  });

  it('rejects a legacy state minted without a nonce even when a cookie is present', () => {
    const token = generateUserLinkStateToken('user-1');
    expect(verifyUserLinkStateToken(token, HASH_A).valid).toBe(false);
  });
});

describe('Slack org-connect state browser-binding', () => {
  it('rejects a state completed in a different browser (cookie mismatch or absent)', () => {
    const token = generateOrgSlackConnectStateToken('org-1', 'user-1', HASH_A);
    expect(verifyOrgSlackConnectStateToken(token, HASH_B).valid).toBe(false);
    expect(verifyOrgSlackConnectStateToken(token, null).valid).toBe(false);
  });

  it('accepts the state in the initiating browser', () => {
    const token = generateOrgSlackConnectStateToken('org-1', 'user-1', HASH_A);
    const result = verifyOrgSlackConnectStateToken(token, HASH_A);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.organizationId).toBe('org-1');
      expect(result.payload.userId).toBe('user-1');
    }
  });

  it('rejects a legacy state minted without a nonce even when a cookie is present', () => {
    const token = generateOrgSlackConnectStateToken('org-1', 'user-1');
    expect(verifyOrgSlackConnectStateToken(token, HASH_A).valid).toBe(false);
  });
});
