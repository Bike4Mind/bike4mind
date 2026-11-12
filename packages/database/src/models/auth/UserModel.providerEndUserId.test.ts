import { describe, it, expect } from 'vitest';
import { toProviderEndUserId } from '@bike4mind/llm-adapters';
import { User } from './UserModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

describe('UserModel providerEndUserId', () => {
  it('stores the identifier LLM providers receive when the account is created', async () => {
    const user = await User.create({ username: 'pe', name: 'pe', email: 'pe@example.com' });

    const stored = await User.findById(user._id).select('+providerEndUserId').lean();

    expect(stored?.providerEndUserId).toBe(toProviderEndUserId(String(user._id)));
  });

  it('keeps it out of default reads', async () => {
    const user = await User.create({ username: 'hidden', name: 'hidden', email: 'hidden@example.com' });

    const read = await User.findById(user._id).lean();

    expect(read).not.toHaveProperty('providerEndUserId');
  });

  it('does not change on a later save', async () => {
    const user = await User.create({ username: 'resave', name: 'resave', email: 'resave@example.com' });
    const loaded = await User.findById(user._id);
    loaded!.name = 'renamed';
    await loaded!.save();

    const stored = await User.findById(user._id).select('+providerEndUserId').lean();
    expect(stored?.providerEndUserId).toBe(toProviderEndUserId(String(user._id)));
  });
});
