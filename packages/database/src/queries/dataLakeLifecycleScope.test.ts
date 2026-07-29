import { describe, expect, it } from 'vitest';
import { buildDataLakeMembershipFilter } from './dataLakeLifecycleScope';

const TAG = 'datalake:org1:acme-docs';

/** The fail-closed shape: the meta-tag alone, with no widening $or. */
const metaOnly = { 'tags.name': TAG };

describe('buildDataLakeMembershipFilter', () => {
  describe('fails closed to the meta-tag alone', () => {
    it.each([
      ['no prefix at all', undefined],
      ['null prefix', null],
      ['empty prefix', ''],
      ['whitespace-only prefix', '   '],
      ['prefix missing its trailing colon', 'acme'],
      ['prefix inside the reserved datalake: namespace', 'datalake:'],
      ['reserved namespace with a suffix', 'datalake:other:'],
    ])('%s', (_label, fileTagPrefix) => {
      const filter = buildDataLakeMembershipFilter({
        datalakeTag: TAG,
        fileTagPrefix,
        creatorUserId: 'creator-1',
        creatorGroupIds: ['g1'],
      });
      expect(filter).toEqual(metaOnly);
    });

    it.each([
      ['creatorUserId absent', undefined],
      ['creatorUserId null', null],
      ['creatorUserId empty', ''],
    ])('drops the prefix arm when %s, so it cannot match unowned files', (_label, creatorUserId) => {
      const filter = buildDataLakeMembershipFilter({
        datalakeTag: TAG,
        fileTagPrefix: 'acme:',
        creatorUserId,
      });
      expect(filter).toEqual(metaOnly);
    });
  });

  describe('with a usable prefix and creator', () => {
    it('ORs the meta-tag with a prefix arm ANDed against the creator access arms', () => {
      const filter = buildDataLakeMembershipFilter({
        datalakeTag: TAG,
        fileTagPrefix: 'acme:',
        creatorUserId: 'creator-1',
        creatorGroupIds: ['g1'],
      });

      expect(filter).toEqual({
        $or: [
          metaOnly,
          {
            $and: [
              { 'tags.name': { $regex: /^acme:/ } },
              {
                $or: [
                  { userId: 'creator-1' },
                  { users: { $elemMatch: { userId: 'creator-1', permissions: { $in: ['read', 'write'] } } } },
                  { groups: { $elemMatch: { groupId: { $in: ['g1'] }, permissions: { $in: ['read', 'write'] } } } },
                ],
              },
            ],
          },
        ],
      });
    });

    it('omits the group arm when the creator has no groups', () => {
      const filter = buildDataLakeMembershipFilter({
        datalakeTag: TAG,
        fileTagPrefix: 'acme:',
        creatorUserId: 'creator-1',
        creatorGroupIds: [],
      });
      const prefixArm = (filter.$or as Record<string, unknown>[])[1].$and as Record<string, unknown>[];
      expect(prefixArm[1].$or).toHaveLength(2);
    });

    it('escapes regex metacharacters so a crafted prefix cannot widen the match', () => {
      const filter = buildDataLakeMembershipFilter({
        datalakeTag: TAG,
        fileTagPrefix: 'a+b(c).*:',
        creatorUserId: 'creator-1',
      });
      const prefixArm = (filter.$or as Record<string, unknown>[])[1].$and as Record<string, unknown>[];
      const { $regex } = prefixArm[0]['tags.name'] as { $regex: RegExp };

      expect($regex.source).toBe('^a\\+b\\(c\\)\\.\\*:');
      // The literal prefix still matches; the metacharacters no longer act as wildcards.
      expect($regex.test('a+b(c).*:report')).toBe(true);
      expect($regex.test('aXbXcXXX:report')).toBe(false);
    });

    it('anchors the prefix so a mid-tag occurrence is not a member', () => {
      const filter = buildDataLakeMembershipFilter({
        datalakeTag: TAG,
        fileTagPrefix: 'acme:',
        creatorUserId: 'creator-1',
      });
      const prefixArm = (filter.$or as Record<string, unknown>[])[1].$and as Record<string, unknown>[];
      const { $regex } = prefixArm[0]['tags.name'] as { $regex: RegExp };

      expect($regex.test('acme:report')).toBe(true);
      expect($regex.test('not-acme:report')).toBe(false);
    });

    it('normalizes a padded prefix rather than matching the raw string', () => {
      const filter = buildDataLakeMembershipFilter({
        datalakeTag: TAG,
        fileTagPrefix: '  acme:  ',
        creatorUserId: 'creator-1',
      });
      const prefixArm = (filter.$or as Record<string, unknown>[])[1].$and as Record<string, unknown>[];
      const { $regex } = prefixArm[0]['tags.name'] as { $regex: RegExp };
      expect($regex.source).toBe('^acme:');
    });
  });
});
