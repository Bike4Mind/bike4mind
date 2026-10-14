import { describe, it, expect, beforeEach } from 'vitest';
import { User, userRepository } from './UserModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

beforeEach(async () => {
  await User.syncIndexes();
});

describe('UserModel.existsOtherUserWithEmail', () => {
  it('matches another user case-insensitively after trimming the input', async () => {
    await User.create({ username: 'pat', name: 'Pat', email: 'Pat@Example.com' });

    expect(await userRepository.existsOtherUserWithEmail('  pat@example.COM ')).toBe(true);
  });

  it('ignores the excluded user', async () => {
    const self = await User.create({ username: 'pat', name: 'Pat', email: 'pat@example.com' });

    expect(await userRepository.existsOtherUserWithEmail('PAT@example.com', String(self._id))).toBe(false);
  });

  it('treats the input literally and requires a whole-value match', async () => {
    await User.create({ username: 'pat', name: 'Pat', email: 'pat@example.com' });

    expect(await userRepository.existsOtherUserWithEmail('pat@example.co')).toBe(false);
    expect(await userRepository.existsOtherUserWithEmail('pat@example.c.m')).toBe(false);
    expect(await userRepository.existsOtherUserWithEmail('.*')).toBe(false);
  });

  it('returns false for a blank input', async () => {
    await User.create({ username: 'pat', name: 'Pat', email: 'pat@example.com' });

    expect(await userRepository.existsOtherUserWithEmail('   ')).toBe(false);
  });
});

describe('UserModel.existsOtherUserWithUsername', () => {
  it('matches another user case-insensitively and skips the excluded one', async () => {
    const self = await User.create({ username: 'Jane Doe', name: 'Jane', email: 'jane@example.com' });
    await User.create({ username: 'jane.doe', name: 'Other', email: 'other@example.com' });

    expect(await userRepository.existsOtherUserWithUsername('JANE DOE')).toBe(true);
    expect(await userRepository.existsOtherUserWithUsername('jane doe', String(self._id))).toBe(false);
    expect(await userRepository.existsOtherUserWithUsername('Jane.Doe', String(self._id))).toBe(true);
  });
});
