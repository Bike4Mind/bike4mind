import { describe, it, expect, beforeEach } from 'vitest';
import { PendingOtcTokenModel, pendingOtcTokenRepository } from '../models/auth/PendingOtcTokenModel';
import { setupMongoTest } from '../__test__/utils';

/**
 * The test-only otc-code endpoint depends on storeNonce persisting the plaintext
 * debugCode and getDebugCode reading it back. Production passes no debugCode, so it
 * stays null - verified here so the "no plaintext on prod" property is a real invariant.
 */
describe('PendingOtcToken debugCode (test-only OTC retrieval)', () => {
  setupMongoTest();

  beforeEach(async () => {
    await PendingOtcTokenModel.deleteMany({});
  });

  it('persists and returns the debugCode when provided (non-prod path)', async () => {
    await pendingOtcTokenRepository.storeNonce('a-e2e@test.com', 'nonce-1', '123456');
    expect(await pendingOtcTokenRepository.getDebugCode('a-e2e@test.com')).toBe('123456');
  });

  it('stores null debugCode when none is provided (production path)', async () => {
    await pendingOtcTokenRepository.storeNonce('b-e2e@test.com', 'nonce-2');
    expect(await pendingOtcTokenRepository.getDebugCode('b-e2e@test.com')).toBeNull();
  });

  it('overwrites the debugCode on re-send', async () => {
    await pendingOtcTokenRepository.storeNonce('c-e2e@test.com', 'nonce-3', '111111');
    await pendingOtcTokenRepository.storeNonce('c-e2e@test.com', 'nonce-4', '222222');
    expect(await pendingOtcTokenRepository.getDebugCode('c-e2e@test.com')).toBe('222222');
  });

  it('returns null for an unknown email', async () => {
    expect(await pendingOtcTokenRepository.getDebugCode('nobody-e2e@test.com')).toBeNull();
  });
});
