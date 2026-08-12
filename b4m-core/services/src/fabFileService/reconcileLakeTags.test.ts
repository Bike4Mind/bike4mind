import { describe, it, expect, vi } from 'vitest';
import { DATA_LAKES, type IDataLakeDocument } from '@bike4mind/common';
import { reconcileLakeTags } from './reconcileLakeTags';

const lake = (overrides: Partial<IDataLakeDocument> = {}): IDataLakeDocument =>
  ({
    id: 'lake1',
    name: 'Lake',
    slug: 'lake',
    fileTagPrefix: 'lk:',
    datalakeTag: 'datalake:lake',
    createdByUserId: 'owner',
    status: 'active',
    ...overrides,
  }) as IDataLakeDocument;

const owner = { userId: 'owner', isAdmin: false };
const tag = (name: string, strength = 0) => ({ name, strength });

const makeAdapters = (
  storedTags: { name: string; strength: number }[],
  lakeDoc: IDataLakeDocument | null = lake()
) => ({
  db: {
    fabFiles: {
      findById: vi.fn().mockResolvedValue({ id: 'f1', userId: 'owner', tags: storedTags }),
      pullTagsByFabFileId: vi.fn().mockResolvedValue(1),
      pushTagsByFabFileId: vi.fn().mockResolvedValue(1),
      computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 4, totalSizeBytes: 40 }),
    },
    dataLakes: {
      findByDatalakeTag: vi.fn().mockResolvedValue(lakeDoc),
      setStats: vi.fn(),
      activateIfDraft: vi.fn(),
      // No prefix collisions in these tests; the fallback tagger's own logic is covered by
      // fallbackLakeTags.test.ts.
      find: vi.fn().mockResolvedValue([]),
    },
  },
});

const run = (
  adapters: ReturnType<typeof makeAdapters>,
  current: string[],
  desired: { name: string; strength: number }[]
) => reconcileLakeTags(owner, 'f1', current, desired, adapters as any);

describe('reconcileLakeTags', () => {
  it('passes ordinary tags through untouched and writes nothing', async () => {
    const adapters = makeAdapters([]);

    const result = await run(adapters, ['keep'], [tag('keep'), tag('added')]);
    await result.commit();

    expect(result.tagsToPersist).toEqual([tag('keep'), tag('added')]);
    expect(adapters.db.fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
    expect(adapters.db.dataLakes.setStats).not.toHaveBeenCalled();
  });

  it('joins a lake whose meta-tag the caller added, and recomputes its stats', async () => {
    const adapters = makeAdapters([]);

    const result = await run(adapters, [], [tag('datalake:lake', 1)]);
    await result.commit();

    // The join is carried by the persisted array itself, so commit() issues no second write for
    // membership - only the stats recompute it cannot do. The array also gains a fallback
    // content tag: addFileToLake stamps only the meta-tag, and a join with no qualifying tag
    // under the lake's prefix would reproduce the "counted but not browseable" bug otherwise.
    expect(result.tagsToPersist).toEqual([tag('datalake:lake', 1), tag('lk:uncategorized', 1)]);
    expect(adapters.db.fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
    expect(adapters.db.dataLakes.setStats).toHaveBeenCalledWith('lake1', { fileCount: 4, totalSizeBytes: 40 });
  });

  // The whole point of this door: a whole-array write cannot tell an intentional removal from a
  // stale client's copy, so it preserves membership rather than treating the drop as a leave.
  it('preserves lake membership when the caller drops only the meta-tag', async () => {
    const stored = [tag('datalake:lake', 1), tag('lk:invoices', 1), tag('unrelated')];
    const adapters = makeAdapters(stored);

    // The caller drops only the meta-tag and keeps the folder tag in the payload.
    const result = await run(
      adapters,
      ['datalake:lake', 'lk:invoices', 'unrelated'],
      [tag('lk:invoices', 1), tag('unrelated')]
    );

    // The meta-tag is force-carried back in - membership is untouched.
    expect(result.tagsToPersist).toEqual([tag('lk:invoices', 1), tag('unrelated'), tag('datalake:lake', 1)]);

    await result.commit();

    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
    expect(adapters.db.dataLakes.setStats).not.toHaveBeenCalled();
  });

  // Security-relevant: preserving the meta-tag alone would let a mere file-share recipient (no
  // relation to the lake beyond a share on this one file) use this door to strip or rewrite the
  // lake's OWN content tags. The lake's content tags must be force-carried too when the actor
  // cannot manage it.
  it('preserves a lake content tag when the actor cannot manage the lake', async () => {
    const stored = [tag('datalake:lake', 1), tag('lk:invoices', 1)];
    const adapters = makeAdapters(stored);
    const editor = { userId: 'editor', isAdmin: false };

    const result = await reconcileLakeTags(
      editor,
      'f1',
      ['datalake:lake', 'lk:invoices'],
      [tag('datalake:lake', 1)],
      adapters as any
    );
    await result.commit();

    expect(result.tagsToPersist).toEqual(expect.arrayContaining([tag('datalake:lake', 1), tag('lk:invoices', 1)]));
    expect(adapters.db.dataLakes.setStats).not.toHaveBeenCalled();
  });

  it("lets the lake manager freely edit their own lake's content tags through this door", async () => {
    const stored = [tag('datalake:lake', 1), tag('lk:invoices', 1)];
    const adapters = makeAdapters(stored);

    // Same drop, but the actor IS the lake's manager - their own content-tag edit goes through.
    const result = await run(adapters, ['datalake:lake', 'lk:invoices'], [tag('datalake:lake', 1)]);
    await result.commit();

    expect(result.tagsToPersist).not.toEqual(expect.arrayContaining([tag('lk:invoices', 1)]));
  });

  it('leaves membership alone when the caller round-trips the meta-tag', async () => {
    // Also has no tag under 'lk:', so the fallback tagger backfills one - the invariant applies
    // on every write through this door, not only a join.
    const adapters = makeAdapters([tag('datalake:lake', 1)]);

    const result = await run(adapters, ['datalake:lake'], [tag('datalake:lake', 1), tag('note')]);
    await result.commit();

    expect(result.tagsToPersist).toEqual([tag('note'), tag('datalake:lake', 1), tag('lk:uncategorized', 1)]);
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
    expect(adapters.db.fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('normalizes a meta-tag the caller spelled in another casing', async () => {
    const adapters = makeAdapters([]);

    const result = await run(adapters, [], [tag('DataLake:Lake', 1)]);

    expect(adapters.db.dataLakes.findByDatalakeTag).toHaveBeenCalledWith('datalake:lake');
    expect(result.tagsToPersist).toEqual([tag('datalake:lake', 1), tag('lk:uncategorized', 1)]);
  });

  // Membership is the canonical tag matched EXACTLY, because that is what the read arm matches.
  // Relaxing this to a case-insensitive compare would let a legacy non-canonical meta-tag confer
  // membership the read path never granted, and dropping that dead string would then count as a
  // LEAVE - gated on manage rights. Re-summarization, which rewrites the whole array as a
  // non-manager, would start failing on any file carrying one.
  it('does not treat a non-canonically-cased stored meta-tag as membership', async () => {
    const adapters = makeAdapters([tag('DataLake:Lake', 1)], lake({ createdByUserId: 'someone-else' }));

    const result = await reconcileLakeTags(
      { userId: 'not-the-owner', isAdmin: false },
      'f1',
      ['DataLake:Lake'],
      [tag('note')],
      adapters as any
    );
    await result.commit();

    expect(result.tagsToPersist).toEqual([tag('note')]);
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
    expect(adapters.db.dataLakes.setStats).not.toHaveBeenCalled();
  });

  it('refuses a meta-tag the caller applied that names no lake', async () => {
    const adapters = makeAdapters([], null);

    await expect(run(adapters, [], [tag('datalake:ghost', 1)])).rejects.toThrow(/only the creator/i);
  });

  // A lake can be deleted out from under a file. The orphaned string must not make the file
  // uneditable - dropping it is a plain tag removal.
  it('lets an orphaned meta-tag be dropped without a lake write', async () => {
    const adapters = makeAdapters([tag('datalake:gone', 1)], null);

    const result = await run(adapters, ['datalake:gone'], [tag('note')]);
    await result.commit();

    expect(result.tagsToPersist).toEqual([tag('note')]);
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
  });

  // The gates must fire before the caller persists anything: the tag array write alone would
  // already have granted or revoked membership.
  it('refuses a join by a caller who cannot manage the lake, before returning a payload', async () => {
    const adapters = makeAdapters([], lake({ createdByUserId: 'someone-else' }));

    await expect(run(adapters, [], [tag('datalake:lake', 1)])).rejects.toThrow(/only the creator can add/i);
  });

  it('preserves membership when the caller drops the meta-tag, regardless of manage rights', async () => {
    const adapters = makeAdapters([tag('datalake:lake', 1)], lake({ createdByUserId: 'someone-else' }));

    const result = await run(adapters, ['datalake:lake'], []);
    await expect(result.commit()).resolves.toBeUndefined();

    // The fallback tagger backfills a folder stamp since the file lost its only content tag under
    // the lake's prefix - same as the round-trip case above.
    expect(result.tagsToPersist).toEqual([tag('datalake:lake', 1), tag('lk:uncategorized', 1)]);
    expect(adapters.db.dataLakes.setStats).not.toHaveBeenCalled();
  });

  // Two lakes can share a fileTagPrefix - nothing makes it unique. Dropping both meta-tags in one
  // call preserves both, independently, the same as a single lake would.
  it('preserves two lakes sharing a fileTagPrefix in one call', async () => {
    const lakeA = lake({ id: 'lakeA', datalakeTag: 'datalake:a', fileTagPrefix: 'qa:' });
    const lakeB = lake({ id: 'lakeB', datalakeTag: 'datalake:b', fileTagPrefix: 'qa:' });
    const stored = [tag('datalake:a', 1), tag('datalake:b', 1), tag('qa:shared', 1)];
    const adapters = makeAdapters(stored);
    adapters.db.dataLakes.findByDatalakeTag = vi.fn(async (t: string) => (t === 'datalake:a' ? lakeA : lakeB));

    const result = await run(adapters, ['datalake:a', 'datalake:b', 'qa:shared'], [tag('qa:shared', 1)]);
    await expect(result.commit()).resolves.toBeUndefined();

    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
    expect(adapters.db.dataLakes.setStats).not.toHaveBeenCalled();
    expect(result.tagsToPersist).toEqual(
      expect.arrayContaining([tag('qa:shared', 1), tag('datalake:a', 1), tag('datalake:b', 1)])
    );
  });

  it('refuses a built-in fallback lake', async () => {
    const fallback = lake({ id: DATA_LAKES[0].id, datalakeTag: DATA_LAKES[0].datalakeTag, createdByUserId: 'owner' });
    const adapters = makeAdapters([], fallback);

    await expect(run(adapters, [], [tag(DATA_LAKES[0].datalakeTag, 1)])).rejects.toThrow(/read-only/i);
  });

  describe('prefix-arm-only membership (no meta-tag on the file)', () => {
    const withPrefixLakes = (storedTags: { name: string; strength: number }[], prefixLakes: IDataLakeDocument[]) => {
      const adapters = makeAdapters(storedTags, null);
      adapters.db.dataLakes.find = vi.fn().mockResolvedValue(prefixLakes);
      return adapters;
    };

    // The headline bug this ticket fixes: the file carries no meta-tag for this lake at all, only
    // its prefixed content tag - a whole-array write dropping it must preserve membership exactly
    // like the meta-tag case, not treat the drop as a leave.
    it('preserves a lake whose sole membership signal is a dropped prefix tag', async () => {
      const adapters = withPrefixLakes([tag('lk:invoices', 1)], [lake()]);

      const result = await run(adapters, ['lk:invoices'], []);
      await result.commit();

      expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
      expect(adapters.db.dataLakes.setStats).not.toHaveBeenCalled();
      expect(result.tagsToPersist).toEqual([tag('lk:invoices', 1)]);
    });

    it('preserves a prefix-arm membership on drop regardless of manage rights', async () => {
      // The file is owned by (and the lake created by) 'owner' - a DIFFERENT actor ('editor', with
      // shared edit access to the file but no lake-manage rights) is the one dropping the tag.
      const adapters = withPrefixLakes([tag('lk:invoices', 1)], [lake({ createdByUserId: 'owner' })]);

      const result = await reconcileLakeTags(
        { userId: 'editor', isAdmin: false },
        'f1',
        ['lk:invoices'],
        [],
        adapters as any
      );
      await expect(result.commit()).resolves.toBeUndefined();

      expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
      expect(adapters.db.dataLakes.setStats).not.toHaveBeenCalled();
      expect(result.tagsToPersist).toEqual([tag('lk:invoices', 1)]);
    });

    it("an admin's whole-array write still cannot drop another user's sole prefix-arm tag", async () => {
      const adapters = withPrefixLakes([tag('lk:invoices', 1)], [lake({ createdByUserId: 'someone-else' })]);
      adapters.db.fabFiles.findById = vi
        .fn()
        .mockResolvedValue({ id: 'f1', userId: 'someone-else', tags: [tag('lk:invoices', 1)] });

      const result = await reconcileLakeTags(
        { userId: 'admin', isAdmin: true },
        'f1',
        ['lk:invoices'],
        [],
        adapters as any
      );
      await result.commit();

      expect(adapters.db.dataLakes.setStats).not.toHaveBeenCalled();
      expect(result.tagsToPersist).toEqual([tag('lk:invoices', 1)]);
    });

    it('keeps membership when a sibling tag under the same prefix survives', async () => {
      const adapters = withPrefixLakes([tag('lk:a', 1), tag('lk:b', 1)], [lake()]);

      const result = await run(adapters, ['lk:a', 'lk:b'], [tag('lk:b', 1)]);
      await result.commit();

      expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
      expect(adapters.db.dataLakes.setStats).not.toHaveBeenCalled();
    });

    // Security-relevant: a sibling tag surviving hides this drop from findPrefixArmChanges
    // entirely (it is not a "leave"), so it needs its own manage-rights check independent of the
    // leave/join framing - otherwise an unmanaged file-share recipient could rewrite the lake's
    // content tags one sibling at a time.
    it('preserves a dropped sibling prefix tag when the actor cannot manage the lake', async () => {
      const adapters = withPrefixLakes([tag('lk:a', 1), tag('lk:b', 1)], [lake()]);
      const editor = { userId: 'editor', isAdmin: false };

      const result = await reconcileLakeTags(editor, 'f1', ['lk:a', 'lk:b'], [tag('lk:b', 1)], adapters as any);
      await result.commit();

      expect(result.tagsToPersist).toEqual(expect.arrayContaining([tag('lk:a', 1), tag('lk:b', 1)]));
      expect(adapters.db.dataLakes.setStats).not.toHaveBeenCalled();
    });

    it('force-carries the departing prefix tag into tagsToPersist, at its original strength', async () => {
      const adapters = withPrefixLakes([tag('lk:invoices', 3)], [lake()]);

      const result = await run(adapters, ['lk:invoices'], []);

      expect(result.tagsToPersist).toEqual([tag('lk:invoices', 3)]);
    });

    it('preserves a lake dropped via both its meta-tag and its prefix tag at once', async () => {
      const stored = [tag('datalake:lake', 1), tag('lk:invoices', 1)];
      const adapters = withPrefixLakes(stored, [lake()]);
      adapters.db.dataLakes.findByDatalakeTag = vi.fn().mockResolvedValue(lake());

      const result = await run(adapters, ['datalake:lake', 'lk:invoices'], []);
      await result.commit();

      // Membership survives on the preserved meta-tag alone; the prefix content tag was a plain
      // ordinary edit the caller genuinely dropped, so the fallback tagger backfills a folder stamp
      // in its place - the lake's meta-tag skip in findPrefixArmChanges avoids double-handling it.
      expect(adapters.db.dataLakes.setStats).not.toHaveBeenCalled();
      expect(result.tagsToPersist).toEqual([tag('datalake:lake', 1), tag('lk:uncategorized', 1)]);
    });

    it('anchors on the file OWNER, not the acting user', async () => {
      const adapters = withPrefixLakes([tag('lk:invoices', 1)], [lake({ createdByUserId: 'owner' })]);
      adapters.db.fabFiles.findById = vi
        .fn()
        .mockResolvedValue({ id: 'f1', userId: 'someone-else', tags: [tag('lk:invoices', 1)] });

      // Actor is 'owner' (manages the lake), but the FILE is owned by someone-else, so this lake
      // is never a candidate for this file and no leave fires.
      const result = await reconcileLakeTags(owner, 'f1', ['lk:invoices'], [], adapters as any);
      await result.commit();

      expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
    });

    it('preserves two lakes sharing one prefix on a shared drop', async () => {
      const a = lake({ id: 'a', datalakeTag: 'datalake:a' });
      const b = lake({ id: 'b', datalakeTag: 'datalake:b' });
      const adapters = withPrefixLakes([tag('lk:shared', 1)], [a, b]);

      const result = await run(adapters, ['lk:shared'], []);
      await expect(result.commit()).resolves.toBeUndefined();

      expect(adapters.db.dataLakes.setStats).not.toHaveBeenCalled();
      // Both lakes' signal is the same tag - force-carried once, not twice.
      expect(result.tagsToPersist).toEqual([tag('lk:shared', 1)]);
    });

    it('judges the leave against the post-fallback-tagger array, not the raw desired array', async () => {
      // Nested prefixes: dropping a:x:foo but adding a:bar - the outer lake (a:) is still
      // satisfied by a:bar, so it must NOT be treated as a leave even though the raw payload
      // never explicitly re-lists it.
      const outer = lake({ id: 'outer', datalakeTag: 'datalake:outer', fileTagPrefix: 'a:' });
      const adapters = withPrefixLakes([tag('a:x:foo', 1)], [outer]);

      const result = await run(adapters, ['a:x:foo'], [tag('a:bar', 1)]);
      await result.commit();

      expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
    });

    it('issues no dataLakes.find call for a plain edit whose dropped names contain no colon', async () => {
      const adapters = withPrefixLakes([tag('plain', 1)], [lake()]);

      const result = await run(adapters, ['plain'], []);
      await result.commit();

      expect(adapters.db.dataLakes.find).not.toHaveBeenCalled();
    });

    it('resolves the owner via findById when fileOwnerUserId is omitted', async () => {
      const adapters = withPrefixLakes([tag('lk:invoices', 1)], [lake()]);

      const result = await reconcileLakeTags(owner, 'f1', ['lk:invoices'], [], {
        db: adapters.db,
        logger: undefined,
      } as any);
      await result.commit();

      expect(adapters.db.fabFiles.findById).toHaveBeenCalledWith('f1');
      expect(result.tagsToPersist).toEqual([tag('lk:invoices', 1)]);
      expect(adapters.db.dataLakes.setStats).not.toHaveBeenCalled();
    });

    it('recomputes stats on a prefix-arm join when the actor manages the lake', async () => {
      const adapters = withPrefixLakes([], [lake({ createdByUserId: 'owner' })]);

      const result = await run(adapters, [], [tag('lk:invoices', 1)]);
      await result.commit();

      expect(adapters.db.dataLakes.setStats).toHaveBeenCalledWith('lake1', { fileCount: 4, totalSizeBytes: 40 });
    });

    // MEMBERSHIP needs no gate (the read-side predicate grants it purely on the tag), but the
    // stats recompute's activation side effect also flips a draft lake to active - a one-way
    // publication change a mere file-share recipient must not be able to force onto a lake they
    // do not manage. Stats still get corrected (so they don't drift forever), just never the
    // activation.
    it('corrects stats but never activates on a prefix-arm join by an actor who cannot manage the lake', async () => {
      const adapters = withPrefixLakes([], [lake({ createdByUserId: 'owner', status: 'draft' })]);
      adapters.db.fabFiles.findById = vi.fn().mockResolvedValue({ id: 'f1', userId: 'owner', tags: [] });

      const result = await reconcileLakeTags(
        { userId: 'not-the-owner', isAdmin: false },
        'f1',
        [],
        [tag('lk:invoices', 1)],
        adapters as any
      );
      await result.commit();

      expect(adapters.db.dataLakes.setStats).toHaveBeenCalledWith('lake1', { fileCount: 4, totalSizeBytes: 40 });
      expect(adapters.db.dataLakes.activateIfDraft).not.toHaveBeenCalled();
    });
  });
});

describe('reconcileLakeTags - static-registry prefix (e.g. opti:), no owning lake document', () => {
  it('refuses a non-admin newly applying a registry-prefixed tag', async () => {
    const adapters = makeAdapters([]);

    await expect(run(adapters, [], [tag('opti:report')])).rejects.toThrow(/only an admin can change this data lake/i);
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('allows an admin to apply a registry-prefixed tag', async () => {
    const adapters = makeAdapters([]);

    const result = await reconcileLakeTags(
      { userId: 'admin', isAdmin: true },
      'f1',
      [],
      [tag('opti:report')],
      adapters as any
    );

    expect(result.tagsToPersist).toEqual([tag('opti:report')]);
  });

  it('does not block an unrelated edit to a file that already carries a legacy registry-prefixed tag', async () => {
    const adapters = makeAdapters([tag('opti:legacy')]);

    const result = await run(adapters, ['opti:legacy'], [tag('opti:legacy'), tag('unrelated')]);

    expect(result.tagsToPersist).toEqual(expect.arrayContaining([tag('opti:legacy'), tag('unrelated')]));
  });

  it('refuses a non-admin whole-array write that keeps a legacy tag but adds a NEW registry-prefixed one', async () => {
    const adapters = makeAdapters([tag('opti:legacy')]);

    await expect(run(adapters, ['opti:legacy'], [tag('opti:legacy'), tag('opti:new')])).rejects.toThrow(
      /only an admin can change this data lake/i
    );
  });

  // The headline bug, replayed for the static-registry namespace: no owning document means
  // `findByDatalakeTag` returns null, but that must not make the meta-tag look like a plain,
  // droppable string - it is real membership in a shared knowledge base every entitled user
  // can see.
  it('preserves a static-registry meta-tag dropped by a whole-array write', async () => {
    const staticTag = DATA_LAKES[0].datalakeTag;
    const adapters = makeAdapters([tag(staticTag, 1)], null);

    const result = await run(adapters, [staticTag], [tag('note')]);
    await result.commit();

    expect(result.tagsToPersist).toEqual(expect.arrayContaining([tag('note'), tag(staticTag, 1)]));
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('preserves a dropped static-registry content tag the same way as a dynamic-lake prefix tag', async () => {
    const prefix = DATA_LAKES[0].fileTagPrefix;
    const adapters = makeAdapters([tag(`${prefix}legacy`, 1)], null);

    const result = await run(adapters, [`${prefix}legacy`], []);

    expect(result.tagsToPersist).toEqual([tag(`${prefix}legacy`, 1)]);
  });
});
