import { describe, it, expect } from 'vitest';
import { User, userRepository } from './UserModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

const CLIENT_ID = 'b4m_acme_0a1b2c3d';

describe('UserModel signupClientId', () => {
  it('defaults to null', async () => {
    const user = await User.create({ username: 'plain', name: 'Plain', email: 'plain@example.com' });

    expect((await User.findById(user.id).lean())?.signupClientId).toBeNull();
  });

  it('keeps the value written at creation', async () => {
    const user = await User.create({
      username: 'via',
      name: 'Via',
      email: 'via@example.com',
      signupClientId: CLIENT_ID,
    });

    expect((await User.findById(user.id).lean())?.signupClientId).toBe(CLIENT_ID);
  });

  it('is never rewritten by an update, on an attributed or an unattributed account', async () => {
    const attributed = await User.create({
      username: 'attr',
      name: 'Attr',
      email: 'attr@example.com',
      signupClientId: CLIENT_ID,
    });
    const unattributed = await User.create({ username: 'unattr', name: 'Unattr', email: 'unattr@example.com' });

    for (const user of [attributed, unattributed]) {
      await userRepository.update({ id: user.id, signupClientId: 'b4m_other_0a1b2c3d' });
      await User.updateOne({ _id: user.id }, { $set: { signupClientId: 'b4m_other_0a1b2c3d' } });
      const doc = await User.findById(user.id);
      doc!.set('signupClientId', 'b4m_other_0a1b2c3d');
      await doc!.save();
    }

    expect((await User.findById(attributed.id).lean())?.signupClientId).toBe(CLIENT_ID);
    expect((await User.findById(unattributed.id).lean())?.signupClientId).toBeNull();
  });
});
