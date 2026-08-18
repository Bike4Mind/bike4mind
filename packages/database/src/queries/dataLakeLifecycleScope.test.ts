import { describe, expect, it } from 'vitest';
import { isDataLakeTagName, matchesTagPrefixArm, prefixArmTagNames } from '@bike4mind/common';
import {
  buildDataLakeMembershipFilter,
  buildLacksContentPrefixTagFilter,
  buildNoOtherLakeMetaTagFilter,
} from './dataLakeLifecycleScope';

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
    it('ORs the meta-tag with a prefix arm ANDed against creator OWNERSHIP', () => {
      const filter = buildDataLakeMembershipFilter({
        datalakeTag: TAG,
        fileTagPrefix: 'acme:',
        creatorUserId: 'creator-1',
      });

      expect(filter).toEqual({
        $or: [metaOnly, { $and: [{ 'tags.name': { $regex: /^acme:/ } }, { userId: 'creator-1' }] }],
      });
    });

    it('has no share or group arm, so a file merely shared to the creator is not a member', () => {
      // This predicate hard-deletes what it matches. A `users`/`groups` arm here would let a lake
      // owner purge a file another user owns and shared with them, and would list it to every
      // visitor of a public lake.
      const serialized = JSON.stringify(
        buildDataLakeMembershipFilter({ datalakeTag: TAG, fileTagPrefix: 'acme:', creatorUserId: 'creator-1' })
      );
      expect(serialized).not.toContain('users');
      expect(serialized).not.toContain('groups');
      expect(serialized).not.toContain('permissions');
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

  describe('parity with prefixArmTagNames (@bike4mind/common)', () => {
    /**
     * `prefixArmTagNames` is the JS-side mirror of this filter's prefix arm, used by the write
     * doors to detect a prefix-arm leave/join before anything is persisted. Extracts the regex
     * this filter builds so both sides are asserted against the SAME fixtures - see
     * `satisfiesTagPrefix` <-> `buildLacksContentPrefixTagFilter` above for the existing parity
     * pattern this mirrors.
     */
    const membershipRegex = (fileTagPrefix: string): RegExp | null => {
      const filter = buildDataLakeMembershipFilter({ datalakeTag: TAG, fileTagPrefix, creatorUserId: 'creator-1' });
      if (!('$or' in filter)) return null;
      const prefixArm = (filter.$or as Record<string, unknown>[])[1].$and as Record<string, unknown>[];
      return (prefixArm[0]['tags.name'] as { $regex: RegExp }).$regex;
    };

    it.each([
      ['acme:', 'acme:report'],
      ['acme:', 'acme:'],
      ['a+b(c).*:', 'a+b(c).*:report'],
      ['docs:legal:', 'docs:legal:contract'],
    ])('agrees a tag under prefix %s is a signal: %s', (prefix, tag) => {
      const regex = membershipRegex(prefix);
      expect(regex?.test(tag)).toBe(true);
      expect(matchesTagPrefixArm([tag], prefix)).toBe(true);
      expect(prefixArmTagNames([tag], prefix)).toEqual([tag]);
    });

    it.each([
      ['acme:', 'not-acme:report'],
      ['acme:', 'other'],
      ['docs:', 'docs'],
    ])('agrees a tag NOT under prefix %s is not a signal: %s', (prefix, tag) => {
      const regex = membershipRegex(prefix);
      expect(regex?.test(tag) ?? false).toBe(false);
      expect(matchesTagPrefixArm([tag], prefix)).toBe(false);
    });

    it.each([
      ['reserved namespace', 'datalake:'],
      ['unusable - no colon', 'acme'],
      ['unusable - empty', ''],
    ])('agrees %s yields no signal at all', (_label, fileTagPrefix) => {
      expect(membershipRegex(fileTagPrefix)).toBeNull();
      expect(prefixArmTagNames(['acme:report', 'datalake:x'], fileTagPrefix)).toEqual([]);
    });

    it('agrees mixed casing does not satisfy the prefix (case-sensitive)', () => {
      const regex = membershipRegex('acme:');
      expect(regex?.test('Acme:report')).toBe(false);
      expect(matchesTagPrefixArm(['Acme:report'], 'acme:')).toBe(false);
    });
  });
});

describe('buildNoOtherLakeMetaTagFilter', () => {
  it("excludes any element carrying a datalake: meta-tag other than this lake's own", () => {
    const filter = buildNoOtherLakeMetaTagFilter(TAG);

    const elemMatch = (filter.tags as { $not: { $elemMatch: Record<string, unknown> } }).$not.$elemMatch;
    const { name } = elemMatch as { name: { $regex: RegExp; $ne: string } };
    expect(name.$regex.source).toBe('^datalake:');
    expect(name.$regex.flags).toContain('i');
    expect(name.$ne).toBe(TAG);
  });

  it('folds case on the namespace test, matching isDataLakeTagName', () => {
    const filter = buildNoOtherLakeMetaTagFilter(TAG);
    const { $regex } = (filter.tags as { $not: { $elemMatch: { name: { $regex: RegExp } } } }).$not.$elemMatch.name;

    expect($regex.test('DATALAKE:org1:sibling')).toBe(true);
    expect(isDataLakeTagName('DATALAKE:org1:sibling')).toBe(true);
    expect($regex.test('not-datalake:x')).toBe(false);
    expect(isDataLakeTagName('not-datalake:x')).toBe(false);
  });

  it('is exact (case-sensitive) on the "other than mine" test, agreeing with the membership filter\'s own meta arm', () => {
    const filter = buildNoOtherLakeMetaTagFilter(TAG);
    const { $regex, $ne } = (filter.tags as { $not: { $elemMatch: { name: { $regex: RegExp; $ne: string } } } }).$not
      .$elemMatch.name;

    // A case-variant of this lake's OWN tag is treated as "another lake's" (excluded) - degenerate
    // and deliberate, since buildDataLakeMembershipFilter's meta arm is exact too and no lake can
    // hold a non-canonical meta-tag in the first place.
    const variant = 'DataLake:Org1:Acme-Docs';
    expect($regex.test(variant)).toBe(true);
    expect(variant === $ne).toBe(false);
  });

  it('composes with the membership filter and the content-prefix filter without a tags-key collision', () => {
    const membership = buildDataLakeMembershipFilter({ datalakeTag: TAG, fileTagPrefix: 'acme:', creatorUserId: 'c1' });
    const exclusive = buildNoOtherLakeMetaTagFilter(TAG);
    const withMembership = { ...membership, ...exclusive };
    expect(withMembership).toHaveProperty('$or');
    expect(withMembership).toHaveProperty('tags');

    const contentPrefix = buildLacksContentPrefixTagFilter('acme:');
    const withContentPrefix = { ...contentPrefix, ...exclusive };
    // Both fragments own a top-level `tags` key; spreading them in this order means the exclusive
    // filter (spread last) wins the key rather than silently combining, so a caller composing them
    // must not rely on both surviving from a single spread - documented here so a future caller
    // finds this test before rediscovering the collision the hard way.
    expect(withContentPrefix.tags).toEqual(exclusive.tags);
  });
});
