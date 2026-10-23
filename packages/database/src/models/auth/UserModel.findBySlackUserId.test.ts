import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { User, userRepository } from './UserModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

/**
 * Slack principal lookups must only resolve links the OAuth callback made, which always carry the
 * workspace it verified. A link without one is a legacy manual entry and resolves to nobody.
 */
describe('UserModel.findBySlackUserId', () => {
  const seed = (id: Types.ObjectId, username: string, slackSettings: Record<string, unknown>) =>
    User.create({
      _id: id,
      username,
      name: username,
      email: `${username}@example.com`,
      slackSettings,
    });

  it('skips links with no workspace and returns the verified one', async () => {
    await seed(new Types.ObjectId(), 'legacy', { slackUserId: 'U1' });
    await seed(new Types.ObjectId(), 'blank', { slackUserId: 'U1', slackTeamId: '' });
    const verifiedId = new Types.ObjectId();
    await seed(verifiedId, 'verified', { slackUserId: 'U1', slackTeamId: 'T1' });

    const found = await userRepository.findBySlackUserId('U1');

    expect(found?.id).toBe(verifiedId.toString());
  });

  it('returns null when the only matching link has no workspace', async () => {
    await seed(new Types.ObjectId(), 'legacy', { slackUserId: 'U2' });

    await expect(userRepository.findBySlackUserId('U2')).resolves.toBeNull();
  });
});
