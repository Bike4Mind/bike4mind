import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { User, userRepository } from './UserModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

describe('UserModel.setAccountSegment', () => {
  it('sets the partner mark and unsets it again for null', async () => {
    const id = new Types.ObjectId().toString();
    await User.create({ _id: id, username: 'pat', name: 'Pat', email: 'pat@example.com' });

    await userRepository.setAccountSegment(id, 'partner');
    expect((await User.findById(id).lean())?.accountSegment).toBe('partner');

    await userRepository.setAccountSegment(id, null);
    const after = await User.findById(id).lean();
    expect(after).not.toBeNull();
    expect(after).not.toHaveProperty('accountSegment');
  });
});
