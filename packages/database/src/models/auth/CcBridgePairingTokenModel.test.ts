import { describe, it, expect } from 'vitest';
import { ccBridgePairingTokenRepository } from './CcBridgePairingTokenModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

const base = (o: Record<string, unknown> = {}) => ({
  userId: 'user-1',
  tokenHash: 'hash',
  tokenPrefix: 'b4mpair_aaaaaaaa',
  expiresAt: new Date(Date.now() + 300_000),
  ...o,
});

describe('ccBridgePairingTokenRepository', () => {
  it('returns unredeemed, unexpired candidates for a prefix', async () => {
    await ccBridgePairingTokenRepository.create(base());
    const found = await ccBridgePairingTokenRepository.findUnredeemedCandidatesByPrefix('b4mpair_aaaaaaaa');
    expect(found).toHaveLength(1);
  });

  it('excludes expired tokens', async () => {
    await ccBridgePairingTokenRepository.create(
      base({ tokenPrefix: 'b4mpair_expired0', expiresAt: new Date(Date.now() - 1000) })
    );
    expect(await ccBridgePairingTokenRepository.findUnredeemedCandidatesByPrefix('b4mpair_expired0')).toHaveLength(0);
  });

  it('burns a token exactly once and then hides it from lookup', async () => {
    const created = await ccBridgePairingTokenRepository.create(base({ tokenPrefix: 'b4mpair_once0000' }));
    expect(await ccBridgePairingTokenRepository.redeem(created._id, 'dev-1')).toBeTruthy();
    expect(await ccBridgePairingTokenRepository.redeem(created._id, 'dev-2')).toBeNull();
    expect(await ccBridgePairingTokenRepository.findUnredeemedCandidatesByPrefix('b4mpair_once0000')).toHaveLength(0);
  });

  it('lets only one of several concurrent redemptions win', async () => {
    const created = await ccBridgePairingTokenRepository.create(base({ tokenPrefix: 'b4mpair_race0000' }));
    const results = await Promise.all(
      ['d1', 'd2', 'd3', 'd4'].map(d => ccBridgePairingTokenRepository.redeem(created._id, d))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
