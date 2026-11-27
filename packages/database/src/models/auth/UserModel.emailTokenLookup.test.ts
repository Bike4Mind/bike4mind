import { describe, it, expect } from 'vitest';
import { hashEmailToken } from '@bike4mind/utils';
import { User, userRepository } from './UserModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

const RAW = '3f2b8c1e-6a4d-4e2f-9b7a-1c5d8e9f0a2b';
const LEGACY = '8a1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';

describe.each([
  { field: 'emailVerificationToken', find: (token: string) => userRepository.findByEmailVerificationToken(token) },
  { field: 'pendingEmailToken', find: (token: string) => userRepository.findByPendingEmailToken(token) },
] as const)('UserModel lookup by $field', ({ field, find }) => {
  it('finds a hashed row by its raw token', async () => {
    const user = await User.create({ username: 'hashed', name: 'Hashed', [field]: hashEmailToken(RAW) });

    expect(String((await find(RAW))?._id)).toBe(String(user._id));
  });

  it('finds a row stored in plaintext before hashing by its raw token', async () => {
    const user = await User.create({ username: 'legacy', name: 'Legacy', [field]: LEGACY });

    expect(String((await find(LEGACY))?._id)).toBe(String(user._id));
  });

  it('does not find a row by its stored hash', async () => {
    await User.create({ username: 'hashed', name: 'Hashed', [field]: hashEmailToken(RAW) });

    expect(await find(hashEmailToken(RAW))).toBeNull();
  });

  it('returns null for an empty token even when rows hold an empty value', async () => {
    await User.collection.insertOne({ username: 'blank', name: 'Blank', [field]: '' });

    expect(await find('')).toBeNull();
  });
});
