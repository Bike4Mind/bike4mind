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

  it('returns member ids per group, string-typed', async () => {
    const u1 = await makeUser(['group-a']);
    const u2 = await makeUser(['group-a', 'group-b']);
    await makeUser([]); // in no group - must not appear anywhere

    const result = await userRepository.findUserIdsByGroupIds(['group-a', 'group-b']);

    expect(new Set(result['group-a'])).toEqual(new Set([u1.id, u2.id]));
    expect(result['group-b']).toEqual([u2.id]);
    expect(typeof result['group-b'][0]).toBe('string');
  });

  // Exercises the post-$unwind $match specifically. The fixture user is in a REQUESTED group and an
  // UNREQUESTED one, so the first $match admits the document and the unwind fans out both group
  // arms - only the second $match drops the unrequested arm. Without it, 'group-z' gets its own
  // bucket. A fixture where every user's groups are all inside the requested set cannot fail here,
  // which is why this case is separate from the one above.
  it('does not leak a matched user other groups into the result', async () => {
    const u1 = await makeUser(['group-a', 'group-z']);

    const result = await userRepository.findUserIdsByGroupIds(['group-a']);

    expect(result['group-a']).toEqual([u1.id]);
    expect(result['group-z']).toBeUndefined();
    expect(Object.keys(result)).toEqual(['group-a']);
  });

  it('omits groups with no members and returns {} for empty input', async () => {
    await makeUser(['group-a']);

    const result = await userRepository.findUserIdsByGroupIds(['group-a', 'group-empty']);
    expect(result['group-empty']).toBeUndefined();

    expect(await userRepository.findUserIdsByGroupIds([])).toEqual({});
  });
});
