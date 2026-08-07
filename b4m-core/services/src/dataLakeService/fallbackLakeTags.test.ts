import { describe, expect, it, vi } from 'vitest';
import { DATA_LAKES, type IDataLakeDocument } from '@bike4mind/common';
import { createDataLakeFallbackTagger, decideStampPrefix, reconcileDataLakeFallbackTags } from './fallbackLakeTags';

const lake = (overrides: Partial<IDataLakeDocument> = {}): IDataLakeDocument =>
  ({
    id: 'lake1',
    name: 'Lake',
    slug: 'acme',
    fileTagPrefix: 'acme:',
    datalakeTag: 'datalake:acme',
    createdByUserId: 'owner',
    status: 'active',
    ...overrides,
  }) as IDataLakeDocument;

const META = 'datalake:acme';

/**
 * `find` backs the prefix-overlap check. It defaults to returning only the lakes reachable by
 * meta-tag, so the common case has nothing to collide with; pass `scopeLakes` to seed a
 * same-creator lake that is NOT a member of the file, which is how a real collision looks.
 */
const makeDb = (byTag: Record<string, IDataLakeDocument | null>, scopeLakes?: IDataLakeDocument[]) => ({
  dataLakes: {
    findByDatalakeTag: vi.fn(async (tag: string) => byTag[tag] ?? null),
    find: vi.fn(async () => scopeLakes ?? (Object.values(byTag).filter(Boolean) as IDataLakeDocument[])),
  },
});

const tag = (name: string, strength = 1) => ({ name, strength });
const names = (tags: { name: string }[]) => tags.map(t => t.name).sort();

describe('reconcileDataLakeFallbackTags', () => {
  it('stamps the lake prefix on a file that carries only the meta-tag', async () => {
    const db = makeDb({ [META]: lake() });
    const result = await reconcileDataLakeFallbackTags([tag(META)], { db });
    expect(names(result)).toEqual(['acme:uncategorized', META]);
  });

  it('leaves a file that already has a tag under the prefix alone', async () => {
    const db = makeDb({ [META]: lake() });
    const result = await reconcileDataLakeFallbackTags([tag(META), tag('acme:legal')], { db });
    expect(names(result)).toEqual(['acme:legal', META]);
  });

  it('stamps when the only other tag is outside the lake prefix', async () => {
    // Guards against implementing satisfaction as "has any tag" - a bare user tag is not a
    // category under this lake, so the file would still be missing from the tree.
    const db = makeDb({ [META]: lake() });
    const result = await reconcileDataLakeFallbackTags([tag(META), tag('important')], { db });
    expect(names(result)).toEqual(['acme:uncategorized', META, 'important']);
  });

  it('stamps nothing for a mixed-case prefix that reaches the reserved namespace', async () => {
    // isReservedTagPrefix folds no case, and neither does the create-time refinement built on it,
    // so `DataLake:x:` is storable today. Minting under it would be lowercased into a meta-tag by
    // the next gated write, resolve to no lake, and lock every further edit to this file out.
    const db = makeDb({ [META]: lake({ fileTagPrefix: 'DataLake:x:' }) });
    const result = await reconcileDataLakeFallbackTags([tag(META)], { db });
    expect(names(result)).toEqual([META]);
  });

  it('stamps nothing when the lake prefix overlaps another lake in the same scope', async () => {
    // Post-#1130 a prefix tag on a creator-owned file IS membership of any lake sharing that
    // prefix - including that lake's permanent delete. Auto-minting one would put this file in
    // another lake's teardown, so decline instead.
    const db = makeDb({ [META]: lake() }, [
      lake(),
      lake({ id: 'lake2', name: 'Other', slug: 'other', fileTagPrefix: 'acme:', datalakeTag: 'datalake:other' }),
    ]);
    const warn = vi.fn();
    const result = await reconcileDataLakeFallbackTags([tag(META)], { db, logger: { warn } });
    expect(names(result)).toEqual([META]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('overlaps'));
  });

  it('stamps nothing when a NESTED prefix overlaps, in either direction', async () => {
    const db = makeDb({ [META]: lake({ fileTagPrefix: 'acme:' }) }, [
      lake(),
      lake({ id: 'lake2', name: 'Nested', slug: 'nested', fileTagPrefix: 'acme:hr:', datalakeTag: 'datalake:nested' }),
    ]);
    const result = await reconcileDataLakeFallbackTags([tag(META)], { db });
    expect(names(result)).toEqual([META]);
  });

  it('still stamps when the overlap lookup itself fails', async () => {
    // Best-effort: a broken collision read must not fail the write. Falling back to stamping is
    // the pre-existing behavior, and the warning is what makes the degraded path visible.
    const db = makeDb({ [META]: lake() });
    db.dataLakes.find = vi.fn(async () => {
      throw new Error('mongo down');
    }) as unknown as typeof db.dataLakes.find;
    const warn = vi.fn();
    const result = await reconcileDataLakeFallbackTags([tag(META)], { db, logger: { warn } });
    expect(names(result)).toEqual(['acme:uncategorized', META]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not check tag-prefix overlap'), expect.anything());
  });

  it('says nothing on the healthy path', async () => {
    const db = makeDb({ [META]: lake() });
    const warn = vi.fn();
    await reconcileDataLakeFallbackTags([tag(META)], { db, logger: { warn } });
    expect(warn).not.toHaveBeenCalled();
  });

  it('stamps nothing for a lake whose prefix sits in the reserved namespace', async () => {
    // The lowercase form, which create does reject, so only a legacy row reaches it. The stamp
    // would be excluded from the tree by the counters and skipped by removal, and since a
    // datalake:* tag never satisfies a prefix it would be re-appended on every single write.
    const db = makeDb({ [META]: lake({ fileTagPrefix: 'datalake:' }) });
    const result = await reconcileDataLakeFallbackTags([tag(META)], { db });
    expect(names(result)).toEqual([META]);
  });

  it('does not accumulate a duplicate stamp across repeated writes', async () => {
    const db = makeDb({ [META]: lake() });
    let tags: { name: string; strength: number }[] = [tag(META)];
    for (let i = 0; i < 4; i++) {
      tags = (await reconcileDataLakeFallbackTags(tags, { db })) as typeof tags;
    }
    expect(names(tags)).toEqual(['acme:uncategorized', META]);
  });

  it('stamps nested prefixes in a stable order regardless of tag order', async () => {
    // Overlapping prefixes are refused when the collision query can SEE them; this covers the
    // ordering logic for the pair it cannot, i.e. lakes in different scopes. `scopeLakes: []`
    // is what "no collision visible" looks like.
    const lakes = {
      'datalake:outer': lake({ id: 'outer', fileTagPrefix: 'a:', datalakeTag: 'datalake:outer' }),
      'datalake:inner': lake({ id: 'inner', fileTagPrefix: 'a:x:', datalakeTag: 'datalake:inner' }),
    };
    const forward = await reconcileDataLakeFallbackTags([tag('datalake:outer'), tag('datalake:inner')], {
      db: makeDb(lakes, []),
    });
    const reversed = await reconcileDataLakeFallbackTags([tag('datalake:inner'), tag('datalake:outer')], {
      db: makeDb(lakes, []),
    });
    expect(names(forward)).toEqual(names(reversed));
    expect(names(forward)).toContain('a:uncategorized');
  });

  it('does not treat a bare prefix with no suffix as satisfying', async () => {
    // 'acme:' splits to ['acme', ''] in the tag tree and renders as an unlabeled row, so it is
    // not a category anyone can navigate to.
    const db = makeDb({ [META]: lake() });
    const result = await reconcileDataLakeFallbackTags([tag(META), tag('acme:')], { db });
    expect(names(result)).toEqual(['acme:', 'acme:uncategorized', META]);
  });

  it('does nothing when the file belongs to no lake, and never looks one up', async () => {
    const db = makeDb({});
    const result = await reconcileDataLakeFallbackTags([tag('notes'), tag('acme:legal')], { db });
    expect(names(result)).toEqual(['acme:legal', 'notes']);
    expect(db.dataLakes.findByDatalakeTag).not.toHaveBeenCalled();
  });

  it('resolves a mixed-case meta-tag to its canonical lake key', async () => {
    const db = makeDb({ [META]: lake() });
    const result = await reconcileDataLakeFallbackTags([tag('DataLake:Acme')], { db });
    expect(db.dataLakes.findByDatalakeTag).toHaveBeenCalledWith(META);
    expect(names(result)).toEqual(['DataLake:Acme', 'acme:uncategorized']);
  });

  it('treats a differently-cased prefix tag as NOT satisfying', async () => {
    // Deliberate asymmetry with the meta-tag match above: buildOwnershipConditions and the
    // tag-count aggregates build their prefix regexes with no `i` flag, so 'Acme:legal' really
    // does not place this file under 'acme:' for them. Lowercasing here would skip the stamp on
    // a file those queries still see as uncategorized.
    const db = makeDb({ [META]: lake() });
    const result = await reconcileDataLakeFallbackTags([tag(META), tag('Acme:legal')], { db });
    expect(names(result)).toEqual(['Acme:legal', 'acme:uncategorized', META]);
  });

  it('skips a lake whose prefix cannot be anchored', async () => {
    // normalizeTagPrefix rejects it, so the read arms and the removal path ignore it too - a tag
    // built on it would be invisible to every query and swept by nothing.
    const db = makeDb({ [META]: lake({ fileTagPrefix: '   ' }) });
    const result = await reconcileDataLakeFallbackTags([tag(META)], { db });
    expect(names(result)).toEqual([META]);
  });

  it('trims a padded prefix so the stamp matches what the read arms search for', async () => {
    const db = makeDb({ [META]: lake({ fileTagPrefix: ' acme:' }) });
    const result = await reconcileDataLakeFallbackTags([tag(META)], { db });
    expect(names(result)).toEqual(['acme:uncategorized', META]);
  });

  it('tolerates a stale meta-tag that resolves to no lake', async () => {
    // The write gate rejects an unresolvable meta-tag before this runs, so this is only reached
    // for a tag already on the file. A rename must not 400 because of it.
    const db = makeDb({ [META]: lake(), 'datalake:ghost': null });
    const result = await reconcileDataLakeFallbackTags([tag(META), tag('datalake:ghost')], { db });
    expect(names(result)).toEqual(['acme:uncategorized', META, 'datalake:ghost']);
  });

  it('stamps each lake independently when a file belongs to two', async () => {
    const db = makeDb({
      [META]: lake(),
      'datalake:beta': lake({ id: 'lake2', slug: 'beta', fileTagPrefix: 'beta:', datalakeTag: 'datalake:beta' }),
    });
    const result = await reconcileDataLakeFallbackTags([tag(META), tag('datalake:beta')], { db });
    expect(names(result)).toEqual(['acme:uncategorized', 'beta:uncategorized', META, 'datalake:beta']);
  });

  it('adds one fallback when two lakes share a prefix', async () => {
    // Cross-scope pair, so the collision query returns nothing and the stamp is not refused. What
    // is under test here is the dedupe: one prefix tag satisfies both lakes, so only one is added.
    const db = makeDb(
      {
        [META]: lake(),
        'datalake:beta': lake({ id: 'lake2', slug: 'beta', datalakeTag: 'datalake:beta' }),
      },
      []
    );
    const result = await reconcileDataLakeFallbackTags([tag(META), tag('datalake:beta')], { db });
    expect(names(result)).toEqual(['acme:uncategorized', META, 'datalake:beta']);
  });

  it('ignores malformed tag entries rather than throwing', async () => {
    const db = makeDb({ [META]: lake() });
    const input = [{ name: null }, { name: 42 }, {}, tag(META)] as unknown as { name: string; strength: number }[];
    const result = await reconcileDataLakeFallbackTags(input, { db });
    expect(result.map(t => t.name)).toContain('acme:uncategorized');
  });

  it('preserves fields the caller put on its tag objects', async () => {
    const db = makeDb({ [META]: lake() });
    const result = await reconcileDataLakeFallbackTags([{ ...tag(META), source: 'wizard' }], { db });
    expect(result).toContainEqual({ name: META, strength: 1, source: 'wizard' });
  });

  it('stamps at strength 1, matching the meta-tag it accompanies', async () => {
    const db = makeDb({ [META]: lake() });
    const result = await reconcileDataLakeFallbackTags([tag(META)], { db });
    expect(result).toContainEqual({ name: 'acme:uncategorized', strength: 1 });
  });
});

describe('reconcileDataLakeFallbackTags - retraction', () => {
  it('retracts the stamped tag when a write drops the lake meta-tag', async () => {
    // Otherwise the file stays a prefix-only member: still listed in the lake's browse and still
    // in retrieval scope, for a lake it just left.
    const db = makeDb({ [META]: lake() });
    const result = await reconcileDataLakeFallbackTags([tag('notes')], {
      db,
      previousTags: [tag(META), tag('acme:uncategorized')],
    });
    expect(names(result)).toEqual(['notes']);
  });

  it('leaves content tags that are not ours behind for the removal path to handle', async () => {
    const db = makeDb({ [META]: lake() });
    const result = await reconcileDataLakeFallbackTags([tag('acme:legal')], {
      db,
      previousTags: [tag(META), tag('acme:legal')],
    });
    expect(names(result)).toEqual(['acme:legal']);
  });

  it('keeps the stamp when the meta-tag is still present', async () => {
    const db = makeDb({ [META]: lake() });
    const result = await reconcileDataLakeFallbackTags([tag(META), tag('acme:uncategorized')], {
      db,
      previousTags: [tag(META), tag('acme:uncategorized')],
    });
    expect(names(result)).toEqual(['acme:uncategorized', META]);
  });

  it('re-stamps when the retracted tag was the only thing satisfying a remaining nested prefix', async () => {
    // Prefixes can nest ('a:' and 'a:b:' both pass validation). The departing lake's
    // 'a:b:uncategorized' does satisfy 'a:', so judging satisfaction before the retraction
    // would skip the addition and then remove the tag it counted on, leaving the file in
    // lake 'a:' with no category at all.
    const db = makeDb(
      {
        'datalake:outer': lake({ id: 'outer', fileTagPrefix: 'a:', datalakeTag: 'datalake:outer' }),
        'datalake:inner': lake({ id: 'inner', fileTagPrefix: 'a:b:', datalakeTag: 'datalake:inner' }),
      },
      [] // cross-scope, so the overlap gate does not fire and the ordering is what is tested
    );
    const result = await reconcileDataLakeFallbackTags([tag('datalake:outer'), tag('a:b:uncategorized')], {
      db,
      previousTags: [tag('datalake:outer'), tag('datalake:inner'), tag('a:b:uncategorized')],
    });
    expect(names(result)).toEqual(['a:uncategorized', 'datalake:outer']);
  });

  it('keeps a shared prefix stamp when only one of two lakes is dropped', async () => {
    const db = makeDb({
      [META]: lake(),
      'datalake:beta': lake({ id: 'lake2', slug: 'beta', datalakeTag: 'datalake:beta' }),
    });
    const result = await reconcileDataLakeFallbackTags([tag(META), tag('acme:uncategorized')], {
      db,
      previousTags: [tag(META), tag('datalake:beta'), tag('acme:uncategorized')],
    });
    expect(names(result)).toEqual(['acme:uncategorized', META]);
  });
});

describe('createDataLakeFallbackTagger', () => {
  it('looks a lake up once across many files in the same batch', async () => {
    const db = makeDb({ [META]: lake() });
    const applyFallbackTags = createDataLakeFallbackTagger({ db });

    const results = await Promise.all([
      applyFallbackTags([tag(META)]),
      applyFallbackTags([tag(META)]),
      applyFallbackTags([tag(META)]),
    ]);

    expect(db.dataLakes.findByDatalakeTag).toHaveBeenCalledTimes(1);
    for (const result of results) expect(names(result)).toEqual(['acme:uncategorized', META]);
  });
});

/**
 * The gate itself, as the backfill migration consumes it. The reconciler cases above already
 * cover the decisions it reaches through the write doors; these pin the SHAPE the migration
 * branches on, which those cases cannot see because the reconciler collapses it to a prefix.
 */
describe('decideStampPrefix', () => {
  it('permits a healthy lake and reports the trimmed prefix', async () => {
    const db = makeDb({ [META]: lake({ fileTagPrefix: '  acme:  ' }) });
    expect(await decideStampPrefix(lake({ fileTagPrefix: '  acme:  ' }), db)).toEqual({
      stamp: true,
      prefix: 'acme:',
    });
  });

  it.each([
    ['an unanchorable prefix', 'acme', 'unusable-prefix'],
    ['an empty prefix', '', 'unusable-prefix'],
    ['the reserved namespace', 'datalake:', 'reserved-namespace'],
    ['the reserved namespace in mixed case', 'DataLake:x:', 'reserved-namespace'],
  ])('refuses %s', async (_label, fileTagPrefix, reason) => {
    const db = makeDb({});
    expect(await decideStampPrefix(lake({ fileTagPrefix }), db)).toEqual({ stamp: false, reason });
  });

  it('refuses an overlapping prefix and names the clashing lakes', async () => {
    const db = makeDb({}, [
      lake(),
      lake({ id: 'lake2', name: 'Other', slug: 'other', fileTagPrefix: 'acme:hr:', datalakeTag: 'datalake:other' }),
    ]);
    expect(await decideStampPrefix(lake(), db)).toEqual({
      stamp: false,
      reason: 'prefix-overlap',
      detail: '"Other" (acme:hr:)',
    });
  });

  it('flags a failed overlap lookup instead of deciding for the caller', async () => {
    // The write doors stamp anyway; the migration refuses. Neither direction belongs in the gate,
    // so it permits and surfaces the flag - a plain `{stamp:true}` here would silently give the
    // bulk mint the write door's fail-open.
    const db = makeDb({});
    db.dataLakes.find = vi.fn(async () => {
      throw new Error('mongo down');
    }) as unknown as typeof db.dataLakes.find;
    expect(await decideStampPrefix(lake(), db)).toEqual({
      stamp: true,
      prefix: 'acme:',
      overlapCheckFailed: true,
    });
  });
});

describe('decideStampPrefix - static registry prefixes', () => {
  const registryPrefix = DATA_LAKES[0]?.fileTagPrefix;

  it('refuses a prefix that overlaps a built-in lake', async () => {
    // The registry read arm has no ownership conjunct, so a tag under its prefix is readable by
    // everyone who can reach that lake. The collision query cannot see registry lakes at all -
    // they have no Mongo rows - so this is a separate check, not a duplicate of the one below it.
    const db = makeDb({});
    expect(await decideStampPrefix(lake({ fileTagPrefix: registryPrefix }), db)).toEqual({
      stamp: false,
      reason: 'registry-prefix-overlap',
    });
  });

  it('refuses a prefix that NESTS under a built-in lake', async () => {
    const db = makeDb({});
    const decision = await decideStampPrefix(lake({ fileTagPrefix: `${registryPrefix}legal:` }), db);
    expect(decision).toEqual({ stamp: false, reason: 'registry-prefix-overlap' });
  });

  it('still stamps an unrelated prefix', async () => {
    const db = makeDb({});
    expect(await decideStampPrefix(lake({ fileTagPrefix: 'totally-unrelated:' }), db)).toEqual({
      stamp: true,
      prefix: 'totally-unrelated:',
    });
  });
});
