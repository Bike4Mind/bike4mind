import { describe, expect, it, vi } from 'vitest';
import type { MembershipLake } from './lakeMembership';
import { findPrefixArmChanges, loadPrefixArmCandidateLakes } from './prefixArmMembership';

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
