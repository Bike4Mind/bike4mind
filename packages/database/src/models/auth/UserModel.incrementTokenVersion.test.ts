import { describe, it, expect } from 'vitest';
import { User, userRepository } from './UserModel';
import { NotFoundError } from '@bike4mind/utils';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

/**
 * incrementTokenVersion drives the server-side session kill switch (logout + admin
 * force-logout). It must be a real atomic bump that returns the NEW version, and it
 * must fail loudly when the target is gone (the alternative - silently reporting a
 * successful revoke that never happened - is the dangerous mode).
 */
describe('UserModel.incrementTokenVersion', () => {
  it('bumps tokenVersion by one and returns the new value', async () => {
    const user = await User.create({ username: 'alice', name: 'Alice', email: 'alice@example.com' });
    expect(user.tokenVersion).toBe(0);

    const next = await userRepository.incrementTokenVersion(user.id);
    expect(next).toBe(1);

    const reloaded = await User.findById(user.id);
    expect(reloaded?.tokenVersion).toBe(1);
  });

  it('increments monotonically across successive calls', async () => {
    const user = await User.create({ username: 'bob', name: 'Bob', email: 'bob@example.com' });

    expect(await userRepository.incrementTokenVersion(user.id)).toBe(1);
    expect(await userRepository.incrementTokenVersion(user.id)).toBe(2);
    expect(await userRepository.incrementTokenVersion(user.id)).toBe(3);
  });

  it('throws NotFoundError for an unknown user instead of reporting a phantom revoke', async () => {
    const ghostId = '507f1f77bcf86cd799439011';
    await expect(userRepository.incrementTokenVersion(ghostId)).rejects.toBeInstanceOf(NotFoundError);
  });
});
