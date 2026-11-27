import { describe, it, expect } from 'vitest';
import { User, userRepository } from './UserModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

describe('UserModel acquisition', () => {
  it('keeps a verified touch next to the campaign touches', async () => {
    const user = await User.create({ username: 'hopped', name: 'Hopped', email: 'hopped@example.com' });
    const verifiedTouch = { srcProductId: 'source-product', hopId: 'c'.repeat(32), redeemedAt: new Date() };

    await userRepository.update({
      id: user.id,
      acquisition: { firstTouch: { source: 'news' }, verifiedTouch, signupMethod: 'otc', capturedAt: new Date() },
    });

    const reloaded = await User.findById(user.id).lean();
    expect(reloaded?.acquisition?.verifiedTouch).toEqual(verifiedTouch);
    expect(reloaded?.acquisition?.firstTouch).toEqual({ source: 'news' });
  });

  it('refuses a verified touch missing its hop', async () => {
    const user = await User.create({ username: 'half', name: 'Half', email: 'half@example.com' });
    user.set('acquisition', {
      verifiedTouch: { srcProductId: 'source-product', redeemedAt: new Date() },
      signupMethod: 'otc',
      capturedAt: new Date(),
    });
    await expect(user.validate()).rejects.toThrow(/hopId/);
  });
});
