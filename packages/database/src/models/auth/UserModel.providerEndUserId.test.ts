import { describe, it, expect } from 'vitest';
import { toProviderEndUserId } from '@bike4mind/llm-adapters';
import { User } from './UserModel';
import { providerEndUserIdFor } from './providerEndUserId';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

describe('User.providerEndUserId', () => {
  it('matches the identifier the LLM adapters send to providers', () => {
    expect(providerEndUserIdFor('507f1f77bcf86cd799439011')).toBe(toProviderEndUserId('507f1f77bcf86cd799439011'));
  });

  it('is written on create and on the first save of a legacy row', async () => {
    const created = await User.create({ username: 'fresh', name: 'Fresh', email: 'fresh@example.com' });
    expect(created.providerEndUserId).toBe(toProviderEndUserId(String(created._id)));

    await User.collection.updateOne({ _id: created._id }, { $unset: { providerEndUserId: 1 } });
    const legacy = await User.findById(created._id);
    legacy!.name = 'Renamed';
    await legacy!.save();
    const raw = await User.collection.findOne({ _id: created._id });
    expect(raw?.providerEndUserId).toBe(toProviderEndUserId(String(created._id)));
  });
});
