import { describe, it, expect } from 'vitest';
import { User, userRepository } from './UserModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

describe('UserModel.addTagsToUser', () => {
  it('merges new tags with existing ones without duplicating any', async () => {
    const user = await User.create({ username: 'tagged', name: 'Tagged', email: 'tagged@example.com', tags: ['beta'] });

    await userRepository.addTagsToUser(user.id, ['beta', 'Partner']);

    const reloaded = await User.findById(user.id);
    expect(reloaded?.tags).toEqual(['beta', 'Partner']);
  });

  it('is idempotent when the same tags are applied twice', async () => {
    const user = await User.create({ username: 'twice', name: 'Twice', email: 'twice@example.com' });

    await userRepository.addTagsToUser(user.id, ['Partner', 'cohort-a']);
    await userRepository.addTagsToUser(user.id, ['Partner', 'cohort-a']);

    const reloaded = await User.findById(user.id);
    expect(reloaded?.tags).toEqual(['Partner', 'cohort-a']);
  });

  it('normalizes legacy null tags while preserving simultaneous additions', async () => {
    const user = await User.create({
      username: 'legacy-null',
      name: 'Legacy',
      email: 'legacy@example.com',
      tags: null,
    });
    await Promise.all([
      userRepository.addTagsToUser(user.id, ['pending-free-credits']),
      userRepository.addTagsToUser(user.id, ['existing-tag']),
    ]);
    const reloaded = await User.findById(user.id);
    expect(reloaded?.tags).toEqual(expect.arrayContaining(['pending-free-credits', 'existing-tag']));
  });

  it('clears only the pending grant breadcrumb and preserves concurrent tag changes', async () => {
    const user = await User.create({
      username: 'pending',
      name: 'Pending',
      email: 'pending@example.com',
      tags: ['pending-free-credits', 'remove-me'],
      pendingCreditGrant: 25,
    });
    await User.updateOne({ _id: user._id }, { $pull: { tags: 'remove-me' } });
    await Promise.all([
      userRepository.addTagsToUser(user.id, ['new-entitlement']),
      userRepository.clearPendingFreeCreditGrant(user.id),
    ]);
    const reloaded = await User.findById(user.id);
    expect(reloaded?.tags).toEqual(['new-entitlement']);
    expect(reloaded?.pendingCreditGrant).toBeNull();
  });

  it('leaves the user untouched for an empty list', async () => {
    const user = await User.create({ username: 'empty', name: 'Empty', email: 'empty@example.com', tags: ['beta'] });

    await userRepository.addTagsToUser(user.id, []);

    const reloaded = await User.findById(user.id);
    expect(reloaded?.tags).toEqual(['beta']);
  });
});
