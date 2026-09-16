import { describe, it, expect } from 'vitest';
import { deviceAuthorizationRepository, digestDeviceCode } from './DeviceAuthorizationModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

const base = (o: Record<string, unknown> = {}) =>
  ({
    deviceCode: digestDeviceCode('dc-default'),
    userCode: 'AAAA-2345',
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
});
