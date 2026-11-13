import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashEmailToken } from '@bike4mind/utils';
import { User, userRepository } from './UserModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

const RAW_TOKEN = '3f2b8c1e-6a4d-4e2f-9b7a-1c5d8e9f0a2b';
const createUser = () =>
  User.create({
    name: 'Email Token Test',
    username: `email-token-${randomUUID()}`,
    emailVerificationToken: hashEmailToken(RAW_TOKEN),
    pendingEmail: 'first@example.test',
    pendingEmailToken: hashEmailToken(RAW_TOKEN),
    pendingEmailSentAt: new Date(Date.now() - 60_000),
    pendingEmailExpires: new Date(Date.now() + 60_000),
  });

describe('email token repository', () => {
  it('rotates the read pending change once and preserves its expiry', async () => {
    const user = await createUser();
    const snapshot = user.toJSON();
    const expiresAt = new Date(user.pendingEmailExpires!);
    expect(await userRepository.rotatePendingEmailToken(snapshot, 'new-hash', expiresAt, new Date())).toBe(true);
    expect(await userRepository.rotatePendingEmailToken(snapshot, 'other-hash', expiresAt, new Date())).toBe(false);
    const stored = await User.findById(user.id);
    expect(stored?.pendingEmailToken).toBe('new-hash');
    expect(stored?.pendingEmailExpires).toEqual(expiresAt);
  });

  it('does not rotate a newer pending destination or a completed change', async () => {
    const user = await createUser();
    const snapshot = user.toJSON();
    const expiresAt = new Date(user.pendingEmailExpires!);
    await User.updateOne({ _id: user.id }, { $set: { pendingEmail: 'second@example.test' } });
    expect(await userRepository.rotatePendingEmailToken(snapshot, 'new-hash', expiresAt, new Date())).toBe(false);
    await User.updateOne({ _id: user.id }, { $set: { pendingEmail: snapshot.pendingEmail, pendingEmailUsed: true } });
    expect(await userRepository.rotatePendingEmailToken(snapshot, 'new-hash', expiresAt, new Date())).toBe(false);
    expect((await User.findById(user.id))?.pendingEmailToken).toBe(snapshot.pendingEmailToken);
  });

  it('does not rotate after the original expiry', async () => {
    const user = await createUser();
    const expired = new Date(Date.now() - 1);
    expect(await userRepository.rotatePendingEmailToken(user.toJSON(), 'new-hash', expired, new Date())).toBe(false);
  });
});
