import { describe, it, expect, vi, beforeEach } from 'vitest';

type Filter = Record<string, unknown>;
type Lake = {
  id: string;
  name: string;
  fileTagPrefix: string;
  datalakeTag: string;
  createdByUserId: string;
  organizationId?: string;
  status: string;
};

const mockLakeFind = vi.fn<(filter: Filter) => Promise<Lake[]>>();
const mockUpdateMany = vi.fn<(filter: Filter, update: Filter) => Promise<{ modifiedCount: number }>>();
const mockRepoFind = vi.fn<(filter: Filter) => Promise<Lake[]>>();

// The real filter builder, not a stub: this test asserts the migration hands the right prefix to
// it, and a stub would let the two drift. Its agreement with the satisfaction predicate is proven
// against a real server in packages/database.
vi.mock('@bike4mind/database', async () => {
  const { buildLacksContentPrefixTagFilter } = await vi.importActual<
    typeof import('../../../database/src/queries/dataLakeLifecycleScope')
  >('../../../database/src/queries/dataLakeLifecycleScope');
  return {
    buildLacksContentPrefixTagFilter,
    DataLakeModel: { find: (filter: Filter) => mockLakeFind(filter) },
    FabFile: { updateMany: (filter: Filter, update: Filter) => mockUpdateMany(filter, update) },
    dataLakeRepository: { find: (filter: Filter) => mockRepoFind(filter) },
  };
});

import migration from './20260803000000_backfill-datalake-content-prefix-tag';

const lake = (over: Partial<Lake> = {}): Lake => ({
  id: 'lake1',
  name: 'Acme',
  fileTagPrefix: 'acme:',
  datalakeTag: 'datalake:acme',
  createdByUserId: 'owner',
  status: 'active',
  ...over,
});

let logged: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
  mockUpdateMany.mockResolvedValue({ modifiedCount: 0 });
  // No other lake in scope -> nothing to collide with, the healthy default.
  mockRepoFind.mockResolvedValue([]);
});

const output = () => logged.join('\n');

describe('backfill-datalake-content-prefix-tag', () => {
  it('stamps the uncategorized tag on meta-tagged files lacking one', async () => {
    mockLakeFind.mockResolvedValue([lake()]);
    mockUpdateMany.mockResolvedValue({ modifiedCount: 3 });

    await migration.up();

    const [filter, update] = mockUpdateMany.mock.calls[0];
    expect(filter['tags.name']).toBe('datalake:acme');
    expect(update).toEqual({ $push: { tags: { name: 'acme:uncategorized', strength: 1 } } });
    expect(output()).toContain('stamped 3 file(s) across 1 lake(s)');
  });

  it('selects only files with no tag under the prefix, so an already-categorized file is untouched', async () => {
    mockLakeFind.mockResolvedValue([lake()]);
    await migration.up();

    // The negated-elemMatch arm is what makes the write a no-op for a satisfied file. Asserting
    // the built regex rather than merely "a filter was passed" is what would fail if the
    // migration dropped the arm and stamped every member.
    const [filter] = mockUpdateMany.mock.calls[0];
    const tagsArm = filter.tags as { $not: { $elemMatch: { $and: [{ name: { $regex: RegExp } }] } } };
    expect(tagsArm.$not.$elemMatch.$and[0].name.$regex.source).toBe('^acme:[\\s\\S]');
  });

  it('re-running is a no-op once every file carries the tag', async () => {
    mockLakeFind.mockResolvedValue([lake()]);
    mockUpdateMany.mockResolvedValue({ modifiedCount: 0 });

    await migration.up();

    expect(output()).toContain('stamped 0 file(s) across 0 lake(s)');
    expect(output()).not.toContain('skipped');
  });

  it('skips a lake mid-teardown', async () => {
    mockLakeFind.mockResolvedValue([]);
    await migration.up();

    expect(mockLakeFind.mock.calls[0][0]).toEqual({ status: { $nin: ['deleting', 'deleted'] } });
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(output()).toContain('no data lakes, nothing to do');
  });

  it.each([
    ['an unanchorable prefix', 'acme', 'unusable-prefix'],
    ['the reserved namespace', 'datalake:', 'reserved-namespace'],
  ])('writes nothing for %s and reports it', async (_label, fileTagPrefix, why) => {
    mockLakeFind.mockResolvedValue([lake({ fileTagPrefix })]);

    await migration.up();

    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(output()).toContain('skipped 1 lake(s)');
    expect(output()).toContain(why);
  });

  it('writes nothing for an overlapping prefix and names the clashing lake', async () => {
    // Post-#1130 a prefix tag on a creator-owned file IS membership, so minting under a shared
    // prefix would hand this lake's files to the other lake's teardown.
    mockLakeFind.mockResolvedValue([lake()]);
    mockRepoFind.mockResolvedValue([lake({ id: 'lake2', name: 'Other', fileTagPrefix: 'acme:hr:' })]);

    await migration.up();

    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(output()).toContain('"Other" (acme:hr:)');
  });

  it('refuses a lake whose overlap check failed, unlike the write doors', async () => {
    // The deliberate divergence. The reconciler stamps anyway so a broken diagnostic read cannot
    // fail a user's write; a bulk mint across every legacy row must not take that chance.
    mockLakeFind.mockResolvedValue([lake()]);
    mockRepoFind.mockRejectedValue(new Error('mongo down'));

    await migration.up();

    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(output()).toContain('overlap check failed');
  });

  it('keeps stamping the healthy lakes when one of them is refused', async () => {
    mockLakeFind.mockResolvedValue([lake({ fileTagPrefix: 'datalake:' }), lake({ id: 'lake2', name: 'Good' })]);
    mockUpdateMany.mockResolvedValue({ modifiedCount: 2 });

    await migration.up();

    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockUpdateMany.mock.calls[0][0]['tags.name']).toBe('datalake:acme');
    expect(output()).toContain('stamped 2 file(s) across 1 lake(s) of 2 scanned');
  });

  it('stamps a nested pair outermost-first, whatever order the lakes come back in', async () => {
    // Each lake's write is visible to the next one's filter, and `a:x:uncategorized` satisfies
    // `a:`. Reaching the inner lake first would leave the outer one with no node of its own -
    // the exact symptom this migration exists to remove. The reconciler sorts for the same
    // reason; a cross-scope nested pair is not a collision, so the gate lets both through.
    const inner = lake({ id: 'inner', name: 'Inner', fileTagPrefix: 'a:x:', datalakeTag: 'datalake:inner' });
    const outer = lake({ id: 'outer', name: 'Outer', fileTagPrefix: 'a:', datalakeTag: 'datalake:outer' });
    mockLakeFind.mockResolvedValue([inner, outer]);
    mockUpdateMany.mockResolvedValue({ modifiedCount: 1 });

    await migration.up();

    const stamped = mockUpdateMany.mock.calls.map(
      ([, update]) => (update as { $push: { tags: { name: string } } }).$push.tags.name
    );
    expect(stamped).toEqual(['a:uncategorized', 'a:x:uncategorized']);
  });

  it('is irreversible', async () => {
    await expect(migration.down()).resolves.toBeUndefined();
  });
});
