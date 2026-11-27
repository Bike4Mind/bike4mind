import { describe, it, expect } from 'vitest';
import { deviceAuthorizationRepository, digestDeviceCode } from './DeviceAuthorizationModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

const base = (o: Record<string, unknown> = {}) =>
  ({
    deviceCode: digestDeviceCode('dc-default'),
    userCode: 'AAAA-2345',
    clientId: 'b4m-cli',
    status: 'pending',
    userId: null,
    expiresAt: new Date(Date.now() + 600_000),
    approvedAt: null,
    lastPolledAt: null,
    ipAddress: '127.0.0.1',
    userAgent: 'test',
    pollCount: 0,
    verificationAttempts: 0,
    ...o,
  }) as never;

describe('DeviceAuthorizationModel repository', () => {
  it('digestDeviceCode is deterministic and never the raw code', () => {
    expect(digestDeviceCode('raw')).toBe(digestDeviceCode('raw'));
    expect(digestDeviceCode('raw')).not.toBe('raw');
  });

  it('findByDeviceCode resolves the raw code via its stored digest', async () => {
    await deviceAuthorizationRepository.create(base({ userCode: 'AAAA-2345', deviceCode: digestDeviceCode('raw-1') }));
    await deviceAuthorizationRepository.create(base({ userCode: 'BBBB-2345', deviceCode: digestDeviceCode('raw-2') }));
    expect((await deviceAuthorizationRepository.findByDeviceCode('raw-2'))?.userCode).toBe('BBBB-2345');
  });

  it('returns null for an unknown or expired code', async () => {
    await deviceAuthorizationRepository.create(
      base({ userCode: 'CCCC-2345', deviceCode: digestDeviceCode('raw-live') })
    );
    await deviceAuthorizationRepository.create(
      base({ userCode: 'DDDD-2345', deviceCode: digestDeviceCode('raw-dead'), expiresAt: new Date(Date.now() - 1000) })
    );
    expect(await deviceAuthorizationRepository.findByDeviceCode('nope')).toBeFalsy();
    expect(await deviceAuthorizationRepository.findByDeviceCode('raw-dead')).toBeFalsy();
  });

  // The RFC 8628 s3.4 binding in the token route reads clientId to decide who may redeem a
  // code. A row without one, or with an id the allowlist never admitted, would make that check
  // meaningless, so the schema has to refuse both at write time.
  it('rejects a row with no clientId', async () => {
    await expect(
      deviceAuthorizationRepository.create(
        base({ userCode: 'LLLL-2345', deviceCode: digestDeviceCode('c-4'), clientId: undefined })
      )
    ).rejects.toThrow(/clientId/);
  });

  it('rejects a clientId that is not on the allowlist', async () => {
    await expect(
      deviceAuthorizationRepository.create(
        base({ userCode: 'MMMM-2345', deviceCode: digestDeviceCode('c-5'), clientId: 'b4m-rogue' })
      )
    ).rejects.toThrow(/clientId/);
  });

  it('countPendingAndUnexpired counts only live pending records', async () => {
    const past = new Date(Date.now() - 1000);
    await deviceAuthorizationRepository.create(base({ userCode: 'EEEE-2345', deviceCode: digestDeviceCode('c-1') }));
    await deviceAuthorizationRepository.create(base({ userCode: 'FFFF-2345', deviceCode: digestDeviceCode('c-2') }));
    await deviceAuthorizationRepository.create(
      base({ userCode: 'GGGG-2345', deviceCode: digestDeviceCode('c-3'), expiresAt: past })
    );
    for (const [userCode, status] of [
      ['HHHH-2345', 'approved'],
      ['JJJJ-2345', 'denied'],
      ['KKKK-2345', 'consumed'],
    ]) {
      await deviceAuthorizationRepository.create(base({ userCode, status, deviceCode: digestDeviceCode(userCode) }));
    }
    expect(await deviceAuthorizationRepository.countPendingAndUnexpired()).toBe(2);
  });

  describe('atomic redemption', () => {
    it('redeems an approved device code once under concurrent requests', async () => {
      const doc = await deviceAuthorizationRepository.create(base({ status: 'approved', userId: 'u1' }));
      const results = await Promise.all([
        deviceAuthorizationRepository.claimApproved(doc.id),
        deviceAuthorizationRepository.claimApproved(doc.id),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.find(Boolean)?.status).toBe('consumed');
    });

    it('does not claim a code that is not approved', async () => {
      const doc = await deviceAuthorizationRepository.create(base());
      expect(await deviceAuthorizationRepository.claimApproved(doc.id)).toBeNull();
    });

    it('records one poll when two arrive inside the interval', async () => {
      const doc = await deviceAuthorizationRepository.create(base());
      const results = await Promise.all([
        deviceAuthorizationRepository.recordPollIfDue(doc.id, 5000),
        deviceAuthorizationRepository.recordPollIfDue(doc.id, 5000),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const stored = await deviceAuthorizationRepository.findById(doc.id);
      expect(stored?.pollCount).toBe(1);
      expect(stored?.lastPolledAt).toBeInstanceOf(Date);
    });

    it('records a poll once the interval has elapsed', async () => {
      const doc = await deviceAuthorizationRepository.create(base({ lastPolledAt: new Date(Date.now() - 6000) }));
      expect(await deviceAuthorizationRepository.recordPollIfDue(doc.id, 5000)).not.toBeNull();
      expect(await deviceAuthorizationRepository.recordPollIfDue(doc.id, 5000)).toBeNull();
    });
  });
});
