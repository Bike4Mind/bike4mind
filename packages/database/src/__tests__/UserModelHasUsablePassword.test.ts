import { describe, it, expect } from 'vitest';
import { User } from '../models/auth/UserModel';
import { setupMongoTest } from '../__test__/utils';

setupMongoTest();

describe('UserModel — hasUsablePassword', () => {
  it('defaults to false when not specified (passwordless-first)', async () => {
    const user = await User.create({ username: 'default-flag', name: 'Default Flag' });
    expect(user.hasUsablePassword).toBe(false);
  });

  it('persists an explicit true value', async () => {
    const user = await User.create({ username: 'real-password', name: 'Real Password', hasUsablePassword: true });
    expect(user.hasUsablePassword).toBe(true);
  });

  it('is selected by default (not select:false, unlike password)', async () => {
    await User.create({ username: 'selected-by-default', name: 'Selected By Default', hasUsablePassword: true });
    const fetched = await User.findOne({ username: 'selected-by-default' });
    expect(fetched?.hasUsablePassword).toBe(true);
    // password stays hidden without an explicit .select('+password') - unaffected by this field.
    expect(fetched?.password).toBeUndefined();
  });
});
