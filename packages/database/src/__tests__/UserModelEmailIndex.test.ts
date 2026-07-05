import { describe, it, expect, beforeEach } from 'vitest';
import { User } from '../models/auth/UserModel';
import { setupMongoTest } from '../__test__/utils';

setupMongoTest();

// Rebuild indexes from the schema before each test so the partial unique
// `email_1` index is present (cleanupTestDB drops collection data between tests).
beforeEach(async () => {
  await User.syncIndexes();
});

describe('UserModel — email partial unique index', () => {
  it('allows multiple accounts with no email (partial index excludes emailless docs)', async () => {
    await User.create({ username: 'emailless-one', name: 'Emailless One' });
    // A plain unique index would reject this with E11000 on { email: null }.
    await expect(User.create({ username: 'emailless-two', name: 'Emailless Two' })).resolves.toBeDefined();
  });

  it('still enforces uniqueness for real string emails', async () => {
    await User.create({ username: 'real-one', name: 'Real One', email: 'dup@example.com' });
    await expect(User.create({ username: 'real-two', name: 'Real Two', email: 'dup@example.com' })).rejects.toThrow();
  });

  it('allows an emailless account alongside accounts that have emails', async () => {
    await User.create({ username: 'has-email', name: 'Has Email', email: 'present@example.com' });
    await expect(User.create({ username: 'no-email', name: 'No Email' })).resolves.toBeDefined();
  });
});
