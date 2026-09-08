import { describe, it, expect, beforeEach } from 'vitest';
import { User, userRepository } from './UserModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

beforeEach(async () => {
  await User.syncIndexes();
});

/**
 * findAllByEmailsOrUsernames backs sharing-invite recipient resolution (#1151): a caller-typed
 * case variant of a real user's stored email/username must still resolve, matching the
 * case-insensitive behavior findByUsernameOrEmail already has.
 */
describe('UserModel.findAllByEmailsOrUsernames', () => {
  it('matches a stored email case-insensitively', async () => {
    await User.create({ username: 'alice', name: 'Alice', email: 'Alice@Example.com' });

    const found = await userRepository.findAllByEmailsOrUsernames(['alice@example.com'], []);
    expect(found.map(u => u.email)).toEqual(['Alice@Example.com']);
  });

  it('matches a stored username case-insensitively', async () => {
    await User.create({ username: 'Bob', name: 'Bob', email: 'bob@example.com' });

    const found = await userRepository.findAllByEmailsOrUsernames([], ['bob']);
    expect(found.map(u => u.username)).toEqual(['Bob']);
  });

  it('returns no match for a recipient nobody has', async () => {
    await User.create({ username: 'charlie', name: 'Charlie', email: 'charlie@example.com' });

    const found = await userRepository.findAllByEmailsOrUsernames(['nobody@example.com'], ['nobody']);
    expect(found).toEqual([]);
  });
});
