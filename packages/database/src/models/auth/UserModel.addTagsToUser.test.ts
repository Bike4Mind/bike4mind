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

  it('leaves the user untouched for an empty list', async () => {
    const user = await User.create({ username: 'empty', name: 'Empty', email: 'empty@example.com', tags: ['beta'] });

    await userRepository.addTagsToUser(user.id, []);

    const reloaded = await User.findById(user.id);
    expect(reloaded?.tags).toEqual(['beta']);
  });
});
