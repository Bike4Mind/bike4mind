import { describe, it, expect } from 'vitest';
import { authFailLogRepository } from './AuthFailLogModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

const log = (ip: string, reason: string, createdAt = new Date()) =>
  authFailLogRepository.create({ strategy: 'google', ip, reason, createdAt } as never);

describe('AuthFailLog reason-scoped counting', () => {
  it('ignores rows whose reason is not listed, whatever their status', async () => {
    for (let i = 0; i < 3; i++) await log('1.1.1.1', 'registration_closed');
    for (let i = 0; i < 5; i++) await log('1.1.1.1', 'internal');
    for (let i = 0; i < 3; i++) await log('2.2.2.2', 'internal');
    const since = new Date(Date.now() - 60_000);

    const hits = await authFailLogRepository.getIPsWithHighAttemptsForReasons(since, 3, ['registration_closed']);
    expect(hits).toEqual([{ ip: '1.1.1.1', attempts: 3 }]);
    expect(await authFailLogRepository.getIPsWithHighAttemptsForReasons(since, 4, ['registration_closed'])).toEqual([]);
  });

  it('counts one IP since a point in time', async () => {
    const now = Date.now();
    await log('1.1.1.1', 'registration_closed', new Date(now - 5 * 60_000));
    await log('1.1.1.1', 'registration_closed', new Date(now - 1000));
    await log('1.1.1.1', 'internal', new Date(now - 1000));
    const since = new Date(now - 60_000);
    expect(await authFailLogRepository.countForIPAndReasons('1.1.1.1', since, ['registration_closed'])).toBe(1);
  });
});
