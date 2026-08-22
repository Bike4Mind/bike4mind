import { describe, expect, it, vi } from 'vitest';
import type { MembershipLake } from './lakeMembership';
import {
  couldMatchTagPrefixArmLoosely,
  findOtherLakeClaims,
  findPrefixArmChanges,
  hasOtherLakeClaim,
  loadPrefixArmCandidateLakes,
} from './prefixArmMembership';

const lake = (overrides: Partial<MembershipLake> = {}): MembershipLake => ({
  id: 'lake1',
  datalakeTag: 'datalake:lake1',
  fileTagPrefix: 'lk:',
  createdByUserId: 'owner',
  ...overrides,
});

const makeAdapters = (lakes: MembershipLake[]) => ({
  db: { dataLakes: { find: vi.fn().mockResolvedValue(lakes) } },
});

describe('findPrefixArmChanges - leaves', () => {
  it('detects a leave when the only prefix signal is dropped', async () => {
    const adapters = makeAdapters([lake()]);
    const { leaves } = await findPrefixArmChanges(
      { fileOwnerUserId: 'owner', currentTagNames: ['lk:invoices'], resultingTagNames: [] },
      adapters
    );
    expect(leaves).toEqual([{ lake: lake(), signalTags: ['lk:invoices'] }]);
  });

  it('is not a leave when the file carried no tag under the prefix', async () => {
    const adapters = makeAdapters([lake()]);
    const { leaves } = await findPrefixArmChanges(
      { fileOwnerUserId: 'owner', currentTagNames: ['other'], resultingTagNames: [] },
      adapters
    );
    expect(leaves).toEqual([]);
  });

  it('is not a leave when a different tag under the same prefix survives', async () => {
    const adapters = makeAdapters([lake()]);
    const { leaves } = await findPrefixArmChanges(
      { fileOwnerUserId: 'owner', currentTagNames: ['lk:a', 'lk:b'], resultingTagNames: ['lk:b'] },
      adapters
    );
    expect(leaves).toEqual([]);
  });

  it('handles nested prefixes independently', async () => {
    const outer = lake({ id: 'outer', datalakeTag: 'datalake:outer', fileTagPrefix: 'a:' });
    const inner = lake({ id: 'inner', datalakeTag: 'datalake:inner', fileTagPrefix: 'a:x:' });
    const adapters = makeAdapters([outer, inner]);
    // Dropping a:x:foo while adding a:bar - only the inner (a:x:) lake leaves.
    const { leaves } = await findPrefixArmChanges(
      { fileOwnerUserId: 'owner', currentTagNames: ['a:x:foo'], resultingTagNames: ['a:bar'] },
      adapters
    );
    expect(leaves.map(l => l.lake.id)).toEqual(['inner']);
  });

  it('returns both lakes when two lakes share one prefix (legacy overlap)', async () => {
    const a = lake({ id: 'a', datalakeTag: 'datalake:a' });
    const b = lake({ id: 'b', datalakeTag: 'datalake:b' });
    const adapters = makeAdapters([a, b]);
    const { leaves } = await findPrefixArmChanges(
      { fileOwnerUserId: 'owner', currentTagNames: ['lk:foo'], resultingTagNames: [] },
      adapters
    );
    expect(leaves.map(l => l.lake.id).sort()).toEqual(['a', 'b']);
  });

  it('never fires for the reserved datalake: namespace', async () => {
    const adapters = makeAdapters([lake({ fileTagPrefix: 'datalake:' })]);
    const { leaves } = await findPrefixArmChanges(
      { fileOwnerUserId: 'owner', currentTagNames: ['datalake:foo'], resultingTagNames: [] },
      adapters
    );
    expect(leaves).toEqual([]);
  });

  it('is [] with no fileOwnerUserId, mirroring the read arm dropping the prefix clause', async () => {
    const adapters = makeAdapters([lake()]);
    const { leaves } = await findPrefixArmChanges(
      { fileOwnerUserId: undefined, currentTagNames: ['lk:invoices'], resultingTagNames: [] },
      adapters
    );
    expect(leaves).toEqual([]);
  });

  it('counts a bare prefix tag (no suffix) as a signal, unlike satisfiesTagPrefix', async () => {
    const adapters = makeAdapters([lake()]);
    const { leaves } = await findPrefixArmChanges(
      { fileOwnerUserId: 'owner', currentTagNames: ['lk:'], resultingTagNames: [] },
      adapters
    );
    expect(leaves).toEqual([{ lake: lake(), signalTags: ['lk:'] }]);
  });

  it('is case-sensitive, matching the unflagged read-arm regex', async () => {
    const adapters = makeAdapters([lake()]);
    const { leaves } = await findPrefixArmChanges(
      { fileOwnerUserId: 'owner', currentTagNames: ['LK:invoices'], resultingTagNames: [] },
      adapters
    );
    expect(leaves).toEqual([]);
  });

  it('defers to the existing meta-tag path when the lake also carries its meta-tag', async () => {
    const adapters = makeAdapters([lake()]);
    const { leaves } = await findPrefixArmChanges(
      {
        fileOwnerUserId: 'owner',
        currentTagNames: ['lk:invoices', 'datalake:lake1'],
        resultingTagNames: ['datalake:lake1'],
      },
      adapters
    );
    expect(leaves).toEqual([]);
  });

  it('issues no lake query when nothing dropped could carry a prefix', async () => {
    const adapters = makeAdapters([lake()]);
    await findPrefixArmChanges(
      { fileOwnerUserId: 'owner', currentTagNames: ['plain'], resultingTagNames: [] },
      adapters
    );
    expect(adapters.db.dataLakes.find).not.toHaveBeenCalled();
  });

  it('uses a supplied candidate set without querying', async () => {
    const adapters = makeAdapters([]);
    const { leaves } = await findPrefixArmChanges(
      { fileOwnerUserId: 'owner', currentTagNames: ['lk:invoices'], resultingTagNames: [] },
      { ...adapters, candidateLakes: [lake()] }
    );
    expect(adapters.db.dataLakes.find).not.toHaveBeenCalled();
    expect(leaves).toEqual([{ lake: lake(), signalTags: ['lk:invoices'] }]);
  });

  it('re-asserts the owner anchor against a batch-loaded candidate set', async () => {
    const mine = lake({ id: 'mine', datalakeTag: 'datalake:mine', createdByUserId: 'owner' });
    const theirs = lake({ id: 'theirs', datalakeTag: 'datalake:theirs', createdByUserId: 'someone-else' });
    const { leaves } = await findPrefixArmChanges(
      { fileOwnerUserId: 'owner', currentTagNames: ['lk:invoices'], resultingTagNames: [] },
      { db: { dataLakes: { find: vi.fn() } }, candidateLakes: [mine, theirs] }
    );
    expect(leaves.map(l => l.lake.id)).toEqual(['mine']);
  });
});

describe('findPrefixArmChanges - joins', () => {
  it('detects a join when a tag newly satisfies a prefix arm', async () => {
    const adapters = makeAdapters([lake()]);
    const { joins } = await findPrefixArmChanges(
      { fileOwnerUserId: 'owner', currentTagNames: [], resultingTagNames: ['lk:invoices'] },
      adapters
    );
    expect(joins).toEqual([{ lake: lake(), signalTags: ['lk:invoices'] }]);
  });

  it('is not a join when the meta-tag is present (existing gated path owns it)', async () => {
    const adapters = makeAdapters([lake()]);
    const { joins } = await findPrefixArmChanges(
      { fileOwnerUserId: 'owner', currentTagNames: [], resultingTagNames: ['lk:invoices', 'datalake:lake1'] },
      adapters
    );
    expect(joins).toEqual([]);
  });

  it('is not a join when the file already satisfied the prefix', async () => {
    const adapters = makeAdapters([lake()]);
    const { joins } = await findPrefixArmChanges(
      { fileOwnerUserId: 'owner', currentTagNames: ['lk:a'], resultingTagNames: ['lk:a', 'lk:b'] },
      adapters
    );
    expect(joins).toEqual([]);
  });

  it('classifies a leave and a join for two different lakes from one call', async () => {
    const departing = lake({ id: 'departing', datalakeTag: 'datalake:departing', fileTagPrefix: 'a:' });
    const arriving = lake({ id: 'arriving', datalakeTag: 'datalake:arriving', fileTagPrefix: 'b:' });
    const adapters = makeAdapters([departing, arriving]);
    const { leaves, joins } = await findPrefixArmChanges(
      { fileOwnerUserId: 'owner', currentTagNames: ['a:foo'], resultingTagNames: ['b:bar'] },
      adapters
    );
    expect(leaves.map(l => l.lake.id)).toEqual(['departing']);
    expect(joins.map(j => j.lake.id)).toEqual(['arriving']);
  });
});

// The gate a hard delete has to pass. BOTH arms of buildDataLakeMembershipFilter, because a file a
// human curated into a second lake through THAT lake's fileTagPrefix carries no `datalake:` tag for
// it - a meta-tag-only gate reads that as "nobody else wants this" and evicts a full member.
describe('findOtherLakeClaims', () => {
  const leaving = { id: 'lake1', datalakeTag: 'datalake:lake1' };

  it('finds a second lake that claims the file ONLY through its prefix arm', async () => {
    const other = lake({ id: 'lake-b', datalakeTag: 'datalake:lake-b', fileTagPrefix: 'acme:' });
    const claims = await findOtherLakeClaims(
      { userId: 'owner', tagNames: ['acme:q3'] },
      leaving,
      makeAdapters([other])
    );
    expect(claims.metaTagNames).toEqual([]);
    expect(claims.prefixArmLakes).toEqual([other]);
    expect(hasOtherLakeClaim(claims)).toBe(true);
  });

  it('finds a second lake through its meta-tag', async () => {
    const claims = await findOtherLakeClaims(
      { userId: 'owner', tagNames: ['datalake:lake-b'] },
      leaving,
      makeAdapters([])
    );
    expect(claims.metaTagNames).toEqual(['datalake:lake-b']);
    expect(hasOtherLakeClaim(claims)).toBe(true);
  });

  it('is clear when nothing but the leaving lake ever held the file', async () => {
    const claims = await findOtherLakeClaims(
      { userId: 'owner', tagNames: ['plain-tag'] },
      leaving,
      makeAdapters([lake({ fileTagPrefix: 'acme:' })])
    );
    expect(hasOtherLakeClaim(claims)).toBe(false);
  });

  // The prefix arm's ownership conjunct: a lake reaches a prefixed tag only on a file its own creator
  // owns. Without it, minting a lake with prefix `acme:` would speak for every file tagged `acme:*`.
  it('ignores a prefix match on a lake whose creator does not own the file', async () => {
    const claims = await findOtherLakeClaims(
      { userId: 'someone-else', tagNames: ['acme:q3'] },
      leaving,
      makeAdapters([lake({ id: 'lake-b', createdByUserId: 'owner', fileTagPrefix: 'acme:' })])
    );
    expect(hasOtherLakeClaim(claims)).toBe(false);
  });

  it('never counts the leaving lake itself, by either arm', async () => {
    const self = lake({ id: 'lake1', datalakeTag: 'datalake:lake1', fileTagPrefix: 'acme:' });
    const claims = await findOtherLakeClaims(
      { userId: 'owner', tagNames: ['datalake:lake1', 'acme:q3'] },
      leaving,
      makeAdapters([self])
    );
    expect(hasOtherLakeClaim(claims)).toBe(false);
  });

  // Folded, matching the rest of the reserved-namespace comparisons: a mixed-case variant of the
  // leaving lake's OWN tag is that lake's, not a stranger's.
  it('folds case when deciding a meta-tag belongs to another lake', async () => {
    const mine = await findOtherLakeClaims(
      { userId: 'owner', tagNames: ['DATALAKE:Lake1'] },
      leaving,
      makeAdapters([])
    );
    expect(hasOtherLakeClaim(mine)).toBe(false);
    const theirs = await findOtherLakeClaims(
      { userId: 'owner', tagNames: ['DATALAKE:Other'] },
      leaving,
      makeAdapters([])
    );
    expect(theirs.metaTagNames).toEqual(['DATALAKE:Other']);
  });

  it('skips the lake query when no tag could carry a prefix arm', async () => {
    const find = vi.fn();
    // Every usable fileTagPrefix ends in ':', so a colon-free tag set is unreachable by that arm.
    const claims = await findOtherLakeClaims({ userId: 'owner', tagNames: ['plain', 'another'] }, leaving, {
      db: { dataLakes: { find } },
    });
    expect(find).not.toHaveBeenCalled();
    expect(hasOtherLakeClaim(claims)).toBe(false);
  });

  it('skips the prefix arm for an unowned file (nothing to anchor the conjunct to)', async () => {
    const find = vi.fn();
    const claims = await findOtherLakeClaims({ userId: null, tagNames: ['acme:q3'] }, leaving, {
      db: { dataLakes: { find } },
    });
    expect(find).not.toHaveBeenCalled();
    expect(hasOtherLakeClaim(claims)).toBe(false);
  });

  it('re-filters a batch-supplied candidate set by owner instead of querying', async () => {
    const find = vi.fn();
    const claims = await findOtherLakeClaims({ userId: 'owner', tagNames: ['acme:q3'] }, leaving, {
      db: { dataLakes: { find } },
      candidateLakes: [
        lake({ id: 'lake-b', createdByUserId: 'owner', fileTagPrefix: 'acme:' }),
        lake({ id: 'lake-c', createdByUserId: 'stranger', fileTagPrefix: 'acme:' }),
      ],
    });
    expect(find).not.toHaveBeenCalled();
    expect(claims.prefixArmLakes.map(l => l.id)).toEqual(['lake-b']);
  });
});

describe('loadPrefixArmCandidateLakes', () => {
  it('queries with $in over the distinct owner ids', async () => {
    const find = vi.fn().mockResolvedValue([lake()]);
    await loadPrefixArmCandidateLakes(['owner', 'owner', 'other', undefined, null], { db: { dataLakes: { find } } });
    expect(find).toHaveBeenCalledWith({ createdByUserId: { $in: ['owner', 'other'] } });
  });

  it('skips the query entirely with no real owner ids', async () => {
    const find = vi.fn();
    const result = await loadPrefixArmCandidateLakes([undefined, null], { db: { dataLakes: { find } } });
    expect(find).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});

describe('couldMatchTagPrefixArmLoosely', () => {
  it('matches case-insensitively, unlike the strict prefix-arm predicate', () => {
    expect(couldMatchTagPrefixArmLoosely('LK:Invoices', 'lk:')).toBe(true);
  });

  it('is false with no prefix', () => {
    expect(couldMatchTagPrefixArmLoosely('lk:invoices', null)).toBe(false);
  });

  // Mirrors prefixArmTagNames closing the reserved datalake: namespace, so the two predicates
  // never disagree on a lake somehow persisted with a reserved fileTagPrefix.
  it('never fires for the reserved datalake: namespace', () => {
    expect(couldMatchTagPrefixArmLoosely('datalake:lake1', 'datalake:')).toBe(false);
  });
});
