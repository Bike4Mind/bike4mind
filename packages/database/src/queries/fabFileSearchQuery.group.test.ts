import { describe, it, expect } from 'vitest';
import { buildOwnershipConditions } from './fabFileSearchQuery';

/**
 * Org Groups Phase 2b (#1174): exercise the dormant `userGroups` consumer in the shared
 * fabFile ownership filter with a NON-empty array. This one builder is the group-matching
 * chokepoint for four of the five consumers - data lakes, ChatCompletionFeatures forced
 * retrieval, knowledgeBaseSearch (semantic + keyword), and knowledgeBaseRetrieve Path B -
 * since they all funnel their `user.groups` through `fabfiles.search`.
 *
 * The invariant: group access is an $elemMatch, so a doc's groupId and the granted
 * permission must live on the SAME group entry (no cross-element over-grant), and the arm
 * is added ONLY when the user actually has groups (empty array stays the prod no-op).
 */
const findGroupArm = (conditions: object[]) =>
  conditions.find((c): c is { groups: { $elemMatch: unknown } } => 'groups' in c);

describe('buildOwnershipConditions - group-level sharing (userGroups)', () => {
  it('adds an $elemMatch group arm scoped to the user groups and read/write', () => {
    const conditions = buildOwnershipConditions('u1', { userGroups: ['g1', 'g2'] });

    expect(findGroupArm(conditions)).toEqual({
      groups: {
        $elemMatch: {
          groupId: { $in: ['g1', 'g2'] },
          permissions: { $in: ['read', 'write'] },
        },
      },
    });
  });

  it('omits the group arm entirely when the user has no groups', () => {
    expect(findGroupArm(buildOwnershipConditions('u1', { userGroups: [] }))).toBeUndefined();
    expect(findGroupArm(buildOwnershipConditions('u1', {}))).toBeUndefined();
    expect(findGroupArm(buildOwnershipConditions('u1'))).toBeUndefined();
  });

  it('keeps the owner + explicit-user arms alongside the group arm', () => {
    const conditions = buildOwnershipConditions('u1', { userGroups: ['g1'] });

    expect(conditions).toContainEqual({ userId: 'u1' });
    expect(conditions).toContainEqual({
      users: { $elemMatch: { userId: 'u1', permissions: { $in: ['read', 'write'] } } },
    });
    expect(findGroupArm(conditions)).toBeDefined();
  });

  it('drops the broad ownership arms (incl. groups) in restrictToDataLake mode', () => {
    const conditions = buildOwnershipConditions('u1', {
      userGroups: ['g1'],
      restrictToDataLake: true,
      dataLakeTags: ['datalake:acme:kb'],
    });

    expect(findGroupArm(conditions)).toBeUndefined();
    expect(conditions).not.toContainEqual({ userId: 'u1' });
  });
});
