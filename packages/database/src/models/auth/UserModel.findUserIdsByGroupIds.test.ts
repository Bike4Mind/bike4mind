import { describe, it, expect, beforeEach } from 'vitest';
import { User, userRepository } from './UserModel';
import { setupMongoTest } from '../../__test__/utils';

/**
 * `findUserIdsByGroupIds` backs the group-list route's per-group membership (org-groups #1172,
 * Phase 4/5). One aggregation, keyed by group id, returning the member ids the management UI
 * renders and unassigns. Guards the group-arm double-match (a user in one requested group must
 * not leak into another group's bucket) and the ObjectId->string conversion the API contract needs.
 */
describe('UserModel.findUserIdsByGroupIds', () => {
  setupMongoTest();

  const makeUser = (groups: string[]) =>
    User.create({
      name: 'Group Member',
      username: `gm-${Math.random().toString(36).slice(2, 10)}`,
      password: null,
      hasUsablePassword: false,
      groups,
    });

  beforeEach(async () => {
    await User.deleteMany({});
  });

  it('returns member ids per group, string-typed, with no cross-group bleed', async () => {
    const u1 = await makeUser(['group-a']);
    const u2 = await makeUser(['group-a', 'group-b']);
    await makeUser([]); // in no group - must not appear anywhere

    const result = await userRepository.findUserIdsByGroupIds(['group-a', 'group-b']);

    expect(new Set(result['group-a'])).toEqual(new Set([u1.id, u2.id]));
    expect(result['group-b']).toEqual([u2.id]);
    expect(typeof result['group-b'][0]).toBe('string');
  });

  it('omits groups with no members and returns {} for empty input', async () => {
    await makeUser(['group-a']);

    const result = await userRepository.findUserIdsByGroupIds(['group-a', 'group-empty']);
    expect(result['group-empty']).toBeUndefined();

    expect(await userRepository.findUserIdsByGroupIds([])).toEqual({});
  });
});
