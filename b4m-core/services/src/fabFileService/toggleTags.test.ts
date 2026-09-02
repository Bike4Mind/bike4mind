import { beforeEach, describe, it, expect, vi } from 'vitest';
import { SettingScopeLevel, type IDataLakeDocument, type IScopedSetting, type ScopeRef } from '@bike4mind/common';
import { invalidateScopedSettingsCache, invalidateSettingsCache } from '@bike4mind/utils';
import { toggleTags } from './toggleTags';

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

// `toJSON` is non-enumerable, matching a real Mongoose document: it must not show up in a
// structural `toEqual` diff, and the production code's `Object.assign`-onto-a-live-document bug
// (an own-property assignment invisible to `toJSON`, dropped by `res.json`) can only be caught by
// a mock document that actually behaves like one - a bare plain object masks it. See
// SharableDocumentModel.findAccessibleById for the real repository's own `.toJSON()` call.
const file = (id: string, tags: { name: string; strength: number }[] = []) => {
  const doc = { id, userId: 'owner', tags };
  Object.defineProperty(doc, 'toJSON', { value: () => ({ ...doc }), enumerable: false });
  return doc;
};

/** Attaches the same non-enumerable `toJSON` to a raw file literal that doesn't already have one. */
const withToJSON = <T extends { id: string }>(f: T): T => {
  if (typeof (f as unknown as { toJSON?: unknown }).toJSON === 'function') return f;
  const copy = { ...f };
  Object.defineProperty(copy, 'toJSON', { value: () => ({ ...copy }), enumerable: false });
  return copy;
};

const makeAdapters = (files: ReturnType<typeof file>[], lakeDoc: IDataLakeDocument | null = lake()) => {
  const filesWithToJSON = files.map(withToJSON);
  // A mutable store so pushTagsByFabFileId/pullTagsByFabFileId mutate what findById returns next,
  // exactly as the real atomic repository methods would - the backfill step re-reads after the
  // per-tag loop, so its correctness depends on that read seeing the loop's own writes.
  const store = new Map(filesWithToJSON.map(f => [f.id, { ...f, tags: [...f.tags] }]));

  return {
    db: {
      fabFiles: {
        shareable: { findAllAccessibleByIds: vi.fn().mockResolvedValue(filesWithToJSON) },
        findById: vi.fn(async (id: string) => store.get(id) ?? null),
        pullTagsByFabFileId: vi.fn(async (id: string, names: string[]) => {
          const doc = store.get(id);
          if (!doc) return 0;
          doc.tags = doc.tags.filter(t => !names.includes(t.name));
          return 1;
        }),
        pushTagsByFabFileId: vi.fn(async (id: string, names: string[], strength = 0) => {
          const doc = store.get(id);
          if (!doc) return 0;
          const toAdd = names.filter(name => !doc.tags.some(t => t.name === name));
          doc.tags.push(...toAdd.map(name => ({ name, strength })));
          return toAdd.length;
        }),
        computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 3, totalSizeBytes: 99, totalChunkedChars: 0 }),
      },
      fileTags: { touchLastActivityBy: vi.fn() },
      dataLakes: {
        findByDatalakeTag: vi.fn().mockResolvedValue(lakeDoc),
        setStats: vi.fn(),
        activateIfDraft: vi.fn(),
        // No prefix collisions in these tests; the tagger's own collision/reserved-namespace
        // logic is covered by fallbackLakeTags.test.ts, not re-tested here.
        find: vi.fn().mockResolvedValue([]),
      },
      users: { findById: vi.fn().mockResolvedValue({ id: 'owner', isAdmin: false }) },
    },
    store,
  };
};

// real repositories; the mocks implement only the methods under test.
const run = (adapters: ReturnType<typeof makeAdapters>, params: unknown) =>
  toggleTags('owner', params, adapters as any);

describe('toggleTags - ordinary tags', () => {
  it('adds an absent tag with the caller casing intact and counts it', async () => {
    const adapters = makeAdapters([file('f1')]);

    await run(adapters, { ids: ['f1'], tags: ['MixedCase'] });

    // Not lowercased: the old whole-array rewrite stored `mixedcase`, silently recasing the tag.
    expect(adapters.db.fabFiles.pushTagsByFabFileId).toHaveBeenCalledWith('f1', ['MixedCase']);
    expect(adapters.db.fileTags.touchLastActivityBy).toHaveBeenCalledWith({ name: 'MixedCase', userId: 'owner' });
  });

  it('removes a present tag by its STORED spelling, not the caller spelling', async () => {
    const adapters = makeAdapters([file('f1', [{ name: 'Foo', strength: 0 }])]);

    await run(adapters, { ids: ['f1'], tags: ['foo'] });

    // The pull is case-sensitive, so passing the caller's `foo` would remove nothing while the tag
    // was still marked as used.
    expect(adapters.db.fabFiles.pullTagsByFabFileId).toHaveBeenCalledWith('f1', ['Foo']);
    expect(adapters.db.fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
    expect(adapters.db.fileTags.touchLastActivityBy).toHaveBeenCalledWith({ name: 'foo', userId: 'owner' });
  });

  it('removes every stored casing of the tag at once', async () => {
    const adapters = makeAdapters([
      file('f1', [
        { name: 'Foo', strength: 0 },
        { name: 'foo', strength: 0 },
      ]),
    ]);

    await run(adapters, { ids: ['f1'], tags: ['FOO'] });

    expect(adapters.db.fabFiles.pullTagsByFabFileId).toHaveBeenCalledWith('f1', ['Foo', 'foo']);
  });

  it('toggles each file independently within one call', async () => {
    const adapters = makeAdapters([file('f1', [{ name: 'shared', strength: 0 }]), file('f2')]);

    await run(adapters, { ids: ['f1', 'f2'], tags: ['shared'] });

    expect(adapters.db.fabFiles.pullTagsByFabFileId).toHaveBeenCalledWith('f1', ['shared']);
    expect(adapters.db.fabFiles.pushTagsByFabFileId).toHaveBeenCalledWith('f2', ['shared']);
    // One on, one off. The old registry counter netted these to zero and wrote nothing; a timestamp
    // has no such cancellation - the user acted on `shared`, so it is marked used exactly once.
    expect(adapters.db.fileTags.touchLastActivityBy).toHaveBeenCalledTimes(1);
    expect(adapters.db.fileTags.touchLastActivityBy).toHaveBeenCalledWith({ name: 'shared', userId: 'owner' });
  });

  it('returns freshly re-read documents rather than the pre-write snapshot', async () => {
    const adapters = makeAdapters([file('f1')]);
    const afterWrite = [file('f1', [{ name: 'new-tag', strength: 0 }])];
    adapters.db.fabFiles.shareable.findAllAccessibleByIds
      .mockResolvedValueOnce([file('f1')])
      .mockResolvedValueOnce(afterWrite);

    const result = await run(adapters, { ids: ['f1'], tags: ['new-tag'] });

    expect(result).toEqual(afterWrite);
    expect(adapters.db.fabFiles.shareable.findAllAccessibleByIds).toHaveBeenCalledTimes(2);
  });

  it('acts once on a tag repeated in the same request', async () => {
    const adapters = makeAdapters([file('f1')]);

    await run(adapters, { ids: ['f1'], tags: ['foo', 'FOO'] });

    // The second pass would read the same pre-write snapshot and write again, toggling the tag
    // straight back off.
    expect(adapters.db.fabFiles.pushTagsByFabFileId).toHaveBeenCalledTimes(1);
    expect(adapters.db.fileTags.touchLastActivityBy).toHaveBeenCalledWith({ name: 'foo', userId: 'owner' });
  });

  it('refuses the whole call when any requested file is inaccessible', async () => {
    const adapters = makeAdapters([file('f1')]);

    await expect(run(adapters, { ids: ['f1', 'f2'], tags: ['x'] })).rejects.toThrow(/not accessible/i);
    expect(adapters.db.fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
  });
});

describe('toggleTags - data lake meta-tags', () => {
  it('leaving a lake clears the prefixed content tags too, not just the meta-tag', async () => {
    const adapters = makeAdapters([
      file('f1', [
        { name: 'datalake:lake', strength: 1 },
        { name: 'lk:invoices', strength: 1 },
        { name: 'keep-me', strength: 0 },
      ]),
    ]);

    await run(adapters, { ids: ['f1'], tags: ['datalake:lake'] });

    // The lake read scope admits a file on the meta-tag OR the fileTagPrefix, so dropping only
    // the meta-tag left the file in the lake's browse and retrieval.
    expect(adapters.db.fabFiles.pullTagsByFabFileId).toHaveBeenCalledWith('f1', ['datalake:lake', 'lk:invoices']);
  });

  it('joining a lake stamps the canonical meta-tag at the membership strength', async () => {
    const adapters = makeAdapters([file('f1')]);

    await run(adapters, { ids: ['f1'], tags: ['datalake:lake'] });

    expect(adapters.db.fabFiles.pushTagsByFabFileId).toHaveBeenCalledWith('f1', ['datalake:lake'], 1);
  });

  it('recomputes the lake stats in both directions', async () => {
    const leaving = makeAdapters([file('f1', [{ name: 'datalake:lake', strength: 1 }])]);
    await run(leaving, { ids: ['f1'], tags: ['datalake:lake'] });
    expect(leaving.db.dataLakes.setStats).toHaveBeenCalledWith('lake1', {
      fileCount: 3,
      totalSizeBytes: 99,
      totalChunkedChars: 0,
    });

    const joining = makeAdapters([file('f1')]);
    await run(joining, { ids: ['f1'], tags: ['datalake:lake'] });
    expect(joining.db.dataLakes.setStats).toHaveBeenCalledWith('lake1', {
      fileCount: 3,
      totalSizeBytes: 99,
      totalChunkedChars: 0,
    });
  });

  it('activates a draft lake the toggle just added a file to (#1342)', async () => {
    // The door the bug was reported through. It never wrote status itself - only batch creation
    // did - so a lake filled this way stayed draft and never reached Discover or retrieval.
    const adapters = makeAdapters([file('f1')], lake({ status: 'draft' }));

    await run(adapters, { ids: ['f1'], tags: ['datalake:lake'] });

    expect(adapters.db.dataLakes.activateIfDraft).toHaveBeenCalledWith('lake1');
  });

  it('recomputes a lake once for the whole batch, not once per file', async () => {
    const adapters = makeAdapters([
      file('f1', [{ name: 'datalake:lake', strength: 1 }]),
      file('f2', [{ name: 'datalake:lake', strength: 1 }]),
      file('f3'),
    ]);

    await run(adapters, { ids: ['f1', 'f2', 'f3'], tags: ['datalake:lake'] });

    expect(adapters.db.fabFiles.computeDataLakeStats).toHaveBeenCalledTimes(1);
    expect(adapters.db.dataLakes.setStats).toHaveBeenCalledTimes(1);
  });

  it('keeps lake membership out of the user tag registry', async () => {
    const adapters = makeAdapters([file('f1')]);

    await run(adapters, { ids: ['f1'], tags: ['datalake:lake'] });

    // A meta-tag is lake membership, not an entry in the user's own tag list, and no other lake
    // door touches the registry either.
    expect(adapters.db.fileTags.touchLastActivityBy).not.toHaveBeenCalled();
  });

  it('resolves a mixed-case meta-tag from the caller to its real lake', async () => {
    const adapters = makeAdapters([file('f1', [{ name: 'datalake:lake', strength: 1 }])]);

    await run(adapters, { ids: ['f1'], tags: ['DataLake:Lake'] });

    expect(adapters.db.dataLakes.findByDatalakeTag).toHaveBeenCalledWith('datalake:lake');
    expect(adapters.db.fabFiles.pullTagsByFabFileId).toHaveBeenCalledWith('f1', ['datalake:lake']);
  });

  it('stamps the canonical meta-tag when the file carries one in another casing', async () => {
    // No read arm matches a non-canonical meta-tag, so it confers no membership and the file is
    // not yet in the lake. The inert string is left where it is.
    const adapters = makeAdapters([file('f1', [{ name: 'DataLake:Lake', strength: 1 }])]);

    await run(adapters, { ids: ['f1'], tags: ['datalake:lake'] });

    expect(adapters.db.fabFiles.pushTagsByFabFileId).toHaveBeenCalledWith('f1', ['datalake:lake'], 1);
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('looks a lake up once per resolver, even across several files', async () => {
    const adapters = makeAdapters([file('f1'), file('f2')]);

    await run(adapters, { ids: ['f1', 'f2'], tags: ['datalake:lake'] });

    // Two independently-memoized lookups, each shared across the whole batch: resolveLake (the
    // join/leave decision) and the fallback tagger's own resolvePrefix (the backfill). Neither
    // knows about the other's cache, matching how every other lake door wires the tagger in.
    expect(adapters.db.dataLakes.findByDatalakeTag).toHaveBeenCalledTimes(2);
  });

  it('refuses a meta-tag that names no lake, without writing anything', async () => {
    const adapters = makeAdapters([file('f1')], null);

    await expect(run(adapters, { ids: ['f1'], tags: ['datalake:ghost'] })).rejects.toThrow(/only the creator/i);
    expect(adapters.db.fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('refuses a lake the caller cannot manage', async () => {
    const adapters = makeAdapters([file('f1')], lake({ createdByUserId: 'someone-else' }));

    await expect(run(adapters, { ids: ['f1'], tags: ['datalake:lake'] })).rejects.toThrow(
      /do not have permission to add/i
    );
    expect(adapters.db.fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
    // A rejected join must not still trigger recomputeLakeStats - that would let a mere file-share
    // recipient force-publish a draft lake they have no relationship to via activateIfDraft.
    expect(adapters.db.dataLakes.setStats).not.toHaveBeenCalled();
    expect(adapters.db.dataLakes.activateIfDraft).not.toHaveBeenCalled();
  });

  it('refuses to leave a lake the caller cannot manage, without recomputing stats', async () => {
    const adapters = makeAdapters(
      [file('f1', [{ name: 'datalake:lake', strength: 1 }])],
      lake({ createdByUserId: 'someone-else' })
    );

    await expect(run(adapters, { ids: ['f1'], tags: ['datalake:lake'] })).rejects.toThrow(
      /do not have permission to remove/i
    );
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
    expect(adapters.db.dataLakes.setStats).not.toHaveBeenCalled();
  });

  it('treats a concurrent removal as the outcome the caller asked for', async () => {
    const adapters = makeAdapters([file('f1', [{ name: 'datalake:lake', strength: 1 }])]);
    // The file lost the tag between this call's read and its write.
    adapters.db.fabFiles.findById = vi.fn().mockResolvedValue(file('f1'));

    await expect(run(adapters, { ids: ['f1'], tags: ['datalake:lake'] })).resolves.toBeDefined();
  });

  it('adds the meta-tag to a file that only carries the prefixed tag', async () => {
    const adapters = makeAdapters([file('f1', [{ name: 'lk:invoices', strength: 1 }])]);

    await run(adapters, { ids: ['f1'], tags: ['datalake:lake'] });

    // The caller asked to toggle the meta-tag, and the file does not carry it.
    expect(adapters.db.fabFiles.pushTagsByFabFileId).toHaveBeenCalledWith('f1', ['datalake:lake'], 1);
  });

  it('still recomputes stats and surfaces the error when one file of a batch fails', async () => {
    const adapters = makeAdapters([
      file('f1', [{ name: 'datalake:lake', strength: 1 }]),
      file('f2', [{ name: 'datalake:lake', strength: 1 }]),
    ]);
    adapters.db.fabFiles.pullTagsByFabFileId = vi.fn(async (id: string) => {
      if (id === 'f2') throw new Error('write failed');
      return 1;
    });

    await expect(run(adapters, { ids: ['f1', 'f2'], tags: ['datalake:lake'] })).rejects.toThrow(/write failed/);
    // f1's removal committed, so the lake's counts must reflect it rather than stay stale.
    expect(adapters.db.dataLakes.setStats).toHaveBeenCalledTimes(1);
  });
});

// A join above stamps only the meta-tag (addFileToLake never touches content tags), and a leave
// clears every prefixed tag under that lake's own prefix - the fallback tagger's own reconciler
// logic (additions, retractions, nested/shared prefixes, reserved namespace, collisions) is
// covered exhaustively in fallbackLakeTags.test.ts. These pin only that toggleTags WIRES it in
// correctly: called with the right state, its recommendation applied as atomic ops, and skipped
// when neither this call nor the file's prior state involves a lake at all.
describe('toggleTags - lake content-tag backfill', () => {
  it('stamps a fallback content tag when a join leaves the file with none', async () => {
    const adapters = makeAdapters([file('f1')]);

    await run(adapters, { ids: ['f1'], tags: ['datalake:lake'] });

    expect(adapters.db.fabFiles.pushTagsByFabFileId).toHaveBeenCalledWith('f1', ['lk:uncategorized'], 1);
    expect(
      adapters.store
        .get('f1')
        ?.tags.map(t => t.name)
        .sort()
    ).toEqual(['datalake:lake', 'lk:uncategorized']);
  });

  it('does not stamp a fallback tag when the join already carries a qualifying content tag', async () => {
    const adapters = makeAdapters([file('f1', [{ name: 'lk:invoices', strength: 1 }])]);

    await run(adapters, { ids: ['f1'], tags: ['datalake:lake'] });

    const pushedNames = adapters.db.fabFiles.pushTagsByFabFileId.mock.calls.flatMap(call => call[1]);
    expect(pushedNames).not.toContain('lk:uncategorized');
  });

  it('backfills when an ordinary-tag removal strips a file last qualifying content tag', async () => {
    // The file stays a MEMBER of the lake throughout - only its one content tag is toggled off,
    // with no meta-tag ever mentioned in this request.
    const adapters = makeAdapters([
      file('f1', [
        { name: 'datalake:lake', strength: 1 },
        { name: 'lk:invoices', strength: 1 },
      ]),
    ]);

    await run(adapters, { ids: ['f1'], tags: ['lk:invoices'] });

    expect(adapters.db.fabFiles.pullTagsByFabFileId).toHaveBeenCalledWith('f1', ['lk:invoices']);
    expect(adapters.db.fabFiles.pushTagsByFabFileId).toHaveBeenCalledWith('f1', ['lk:uncategorized'], 1);
    expect(
      adapters.store
        .get('f1')
        ?.tags.map(t => t.name)
        .sort()
    ).toEqual(['datalake:lake', 'lk:uncategorized']);
  });

  it('issues no extra write on leave: removeFileFromLake already cleared the fallback tag', async () => {
    const adapters = makeAdapters([
      file('f1', [
        { name: 'datalake:lake', strength: 1 },
        { name: 'lk:uncategorized', strength: 1 },
      ]),
    ]);

    await run(adapters, { ids: ['f1'], tags: ['datalake:lake'] });

    // One pull for the leave (meta-tag + fallback tag together); no separate retraction call.
    expect(adapters.db.fabFiles.pullTagsByFabFileId).toHaveBeenCalledTimes(1);
    expect(adapters.db.fabFiles.pullTagsByFabFileId).toHaveBeenCalledWith('f1', ['datalake:lake', 'lk:uncategorized']);
    expect(adapters.db.fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('skips the backfill entirely for a plain tag toggle with no lake involvement', async () => {
    const adapters = makeAdapters([file('f1', [{ name: 'user-tag', strength: 0 }])]);
    const findByIdSpy = adapters.db.fabFiles.findById;

    await run(adapters, { ids: ['f1'], tags: ['user-tag'] });

    // No meta-tag in the request and none on the file beforehand: nothing to reconcile, so the
    // extra re-read this step needs never happens.
    expect(findByIdSpy).not.toHaveBeenCalled();
  });
});

describe('toggleTags - prefix-arm-only membership (no meta-tag on the file)', () => {
  const runAs = (userId: string, adapters: ReturnType<typeof makeAdapters>, params: unknown) =>
    toggleTags(userId, params, adapters as any);

  it('toggling off the last prefix tag removes the file from the lake and recomputes stats', async () => {
    const adapters = makeAdapters([file('f1', [{ name: 'lk:invoices', strength: 1 }])]);
    adapters.db.dataLakes.find = vi.fn().mockResolvedValue([lake()]);

    await run(adapters, { ids: ['f1'], tags: ['lk:invoices'] });

    expect(adapters.store.get('f1')?.tags).toEqual([]);
    expect(adapters.db.dataLakes.setStats).toHaveBeenCalledWith('lake1', {
      fileCount: 3,
      totalSizeBytes: 99,
      totalChunkedChars: 0,
    });
  });

  it('refuses a non-manager actor before any write in the batch', async () => {
    const adapters = makeAdapters([file('f1', [{ name: 'lk:invoices', strength: 1 }])]);
    adapters.db.dataLakes.find = vi.fn().mockResolvedValue([lake({ createdByUserId: 'owner' })]);
    adapters.db.users.findById = vi.fn().mockResolvedValue({ id: 'editor', isAdmin: false });

    await expect(runAs('editor', adapters, { ids: ['f1'], tags: ['lk:invoices'] })).rejects.toThrow(
      /do not have permission to remove/i
    );
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
    expect(adapters.db.dataLakes.setStats).not.toHaveBeenCalled();
  });

  it('one un-manageable leave anywhere in a multi-file batch aborts the whole request', async () => {
    const adapters = makeAdapters([
      file('f1', [{ name: 'unrelated', strength: 0 }]),
      file('f2', [{ name: 'lk:invoices', strength: 1 }]),
    ]);
    adapters.db.dataLakes.find = vi.fn().mockResolvedValue([lake({ createdByUserId: 'owner' })]);
    adapters.db.users.findById = vi.fn().mockResolvedValue({ id: 'editor', isAdmin: false });

    await expect(runAs('editor', adapters, { ids: ['f1', 'f2'], tags: ['unrelated', 'lk:invoices'] })).rejects.toThrow(
      /do not have permission to remove/i
    );
    // f1's unrelated-tag toggle never ran either - the gate for the WHOLE batch fires up front.
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
    expect(adapters.db.fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('toggling off one of two tags under the same prefix is an ordinary edit, no lake write', async () => {
    const adapters = makeAdapters([
      file('f1', [
        { name: 'lk:a', strength: 1 },
        { name: 'lk:b', strength: 1 },
      ]),
    ]);
    adapters.db.dataLakes.find = vi.fn().mockResolvedValue([lake()]);

    await run(adapters, { ids: ['f1'], tags: ['lk:a'] });

    expect(adapters.db.dataLakes.setStats).not.toHaveBeenCalled();
    expect(adapters.store.get('f1')?.tags.map(t => t.name)).toEqual(['lk:b']);
  });

  it('surfaces the prefix-arm join count on the returned file, and it survives a JSON round-trip', async () => {
    // Regression test for a real bug: the count used to be assigned onto the live Mongoose
    // document via Object.assign, which `res.json` (via the schema's toJSON) silently dropped -
    // the caller-facing trap-defusal toast could never fire. `file()`'s mock toJSON mirrors that
    // real serialization boundary, so this fails the same way the production code did before the
    // fix if the count is attached the wrong way.
    const adapters = makeAdapters([file('f1')]);
    adapters.db.dataLakes.find = vi.fn().mockResolvedValue([lake()]);

    const result = await run(adapters, { ids: ['f1'], tags: ['lk:invoices'] });

    const serialized = JSON.parse(JSON.stringify(result));
    expect(serialized[0].prefixArmJoinedLakeCount).toBe(1);
  });

  it('toggling a prefix tag ON is never a leave, and recomputes when the actor manages the lake', async () => {
    const adapters = makeAdapters([file('f1')]);
    adapters.db.dataLakes.find = vi.fn().mockResolvedValue([lake()]);

    // 'owner' both owns the file (file()'s default) and manages the lake (lake()'s default).
    await run(adapters, { ids: ['f1'], tags: ['lk:invoices'] });

    expect(adapters.db.dataLakes.setStats).toHaveBeenCalledWith('lake1', {
      fileCount: 3,
      totalSizeBytes: 99,
      totalChunkedChars: 0,
    });
  });

  // MEMBERSHIP needs no gate (the read-side predicate grants it purely on the tag), but the
  // stats recompute's activation side effect also flips a draft lake to active - a one-way
  // publication change a mere file-share recipient must not be able to force onto a lake they do
  // not manage. Stats still get corrected (so they don't drift forever), just never the
  // activation.
  it('corrects stats but never activates on a prefix-arm join by an actor who cannot manage the lake', async () => {
    const adapters = makeAdapters([{ id: 'f1', userId: 'owner', tags: [] }], lake({ status: 'draft' }));
    adapters.db.dataLakes.find = vi.fn().mockResolvedValue([lake({ createdByUserId: 'owner', status: 'draft' })]);
    adapters.db.users.findById = vi.fn().mockResolvedValue({ id: 'editor', isAdmin: false });

    const runAs = (userId: string, params: unknown) => toggleTags(userId, params, adapters as any);
    await runAs('editor', { ids: ['f1'], tags: ['lk:invoices'] });

    expect(adapters.db.dataLakes.setStats).toHaveBeenCalledWith('lake1', {
      fileCount: 3,
      totalSizeBytes: 99,
      totalChunkedChars: 0,
    });
    expect(adapters.db.dataLakes.activateIfDraft).not.toHaveBeenCalled();
  });

  it('recomputes a shared lake once for a batch where every file leaves it', async () => {
    const adapters = makeAdapters([
      file('f1', [{ name: 'lk:invoices', strength: 1 }]),
      file('f2', [{ name: 'lk:invoices', strength: 1 }]),
    ]);
    adapters.db.dataLakes.find = vi.fn().mockResolvedValue([lake()]);

    await run(adapters, { ids: ['f1', 'f2'], tags: ['lk:invoices'] });

    expect(adapters.db.dataLakes.setStats).toHaveBeenCalledTimes(1);
  });

  it('does not re-stamp a fallback content tag for the lake just left via its prefix arm', async () => {
    const adapters = makeAdapters([file('f1', [{ name: 'lk:invoices', strength: 1 }])]);
    adapters.db.dataLakes.find = vi.fn().mockResolvedValue([lake()]);

    await run(adapters, { ids: ['f1'], tags: ['lk:invoices'] });

    expect(adapters.db.fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('still stamps the fallback for a different meta-tag lake joined in the same request', async () => {
    const prefixLake = lake({ id: 'prefixLake', datalakeTag: 'datalake:prefixlake', fileTagPrefix: 'lk:' });
    const metaLake = lake({ id: 'metaLake', datalakeTag: 'datalake:metalake', fileTagPrefix: 'ml:' });
    const adapters = makeAdapters([file('f1', [{ name: 'lk:invoices', strength: 1 }])], metaLake);
    adapters.db.dataLakes.find = vi.fn().mockResolvedValue([prefixLake]);

    await run(adapters, { ids: ['f1'], tags: ['lk:invoices', 'datalake:metalake'] });

    // The prefix-arm leave's sweep must be visible to the backfill's re-read, so the join into
    // metaLake still gets its fallback content tag.
    expect(adapters.db.fabFiles.pushTagsByFabFileId).toHaveBeenCalledWith('f1', ['ml:uncategorized'], 1);
  });

  it('anchors on the file owner, not the caller (admin case)', async () => {
    const adapters = makeAdapters([{ id: 'f1', userId: 'someone-else', tags: [{ name: 'lk:invoices', strength: 1 }] }]);
    adapters.db.dataLakes.find = vi.fn().mockResolvedValue([lake({ createdByUserId: 'someone-else' })]);
    adapters.db.users.findById = vi.fn().mockResolvedValue({ id: 'admin', isAdmin: true });

    await runAs('admin', adapters, { ids: ['f1'], tags: ['lk:invoices'] });

    expect(adapters.db.dataLakes.setStats).toHaveBeenCalledWith('lake1', {
      fileCount: 3,
      totalSizeBytes: 99,
      totalChunkedChars: 0,
    });
  });

  it('issues no extra dataLakes.find when no requested tag has a colon', async () => {
    const adapters = makeAdapters([file('f1', [{ name: 'lk:invoices', strength: 1 }])]);
    const findSpy = vi.fn().mockResolvedValue([lake()]);
    adapters.db.dataLakes.find = findSpy;

    await run(adapters, { ids: ['f1'], tags: ['plain'] });

    expect(findSpy).not.toHaveBeenCalled();
  });

  it('the predictor agrees with the loop when a file stores both casings of a tag', async () => {
    const adapters = makeAdapters([
      file('f1', [
        { name: 'Foo', strength: 0 },
        { name: 'foo', strength: 0 },
        { name: 'lk:invoices', strength: 1 },
      ]),
    ]);
    adapters.db.dataLakes.find = vi.fn().mockResolvedValue([lake()]);

    // Dropping 'foo' (unrelated to the lake) alongside the prefix tag must not confuse the
    // leave prediction - the lake's prefix tag is still the thing being evaluated.
    await run(adapters, { ids: ['f1'], tags: ['FOO', 'lk:invoices'] });

    expect(adapters.db.dataLakes.setStats).toHaveBeenCalledWith('lake1', {
      fileCount: 3,
      totalSizeBytes: 99,
      totalChunkedChars: 0,
    });
    expect(adapters.store.get('f1')?.tags.map(t => t.name)).toEqual([]);
  });

  it('a concurrent removal between the toggle and the sweep is the outcome the caller asked for', async () => {
    const adapters = makeAdapters([file('f1', [{ name: 'lk:invoices', strength: 1 }])]);
    adapters.db.dataLakes.find = vi.fn().mockResolvedValue([lake()]);
    // The prefix tag is gone by the time removeFileFromLake's own lookup runs.
    const realFindById = adapters.db.fabFiles.findById;
    adapters.db.fabFiles.findById = vi.fn(async (id: string) => {
      const doc = await realFindById(id);
      return doc ? { ...doc, tags: [] } : doc;
    });

    await expect(run(adapters, { ids: ['f1'], tags: ['lk:invoices'] })).resolves.toBeDefined();
    expect(adapters.db.dataLakes.setStats).toHaveBeenCalledWith('lake1', {
      fileCount: 3,
      totalSizeBytes: 99,
      totalChunkedChars: 0,
    });
  });
});

describe('toggleTags - static-registry prefix (e.g. opti:), no owning lake document', () => {
  const runAs = (userId: string, adapters: ReturnType<typeof makeAdapters>, params: unknown) =>
    toggleTags(userId, params, adapters as any);

  it('refuses a non-admin newly applying a registry-prefixed tag, before any write', async () => {
    const adapters = makeAdapters([file('f1')]);

    await expect(run(adapters, { ids: ['f1'], tags: ['opti:report'] })).rejects.toThrow(
      /only an admin can change this data lake/i
    );
    expect(adapters.db.fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('allows an admin to apply a registry-prefixed tag', async () => {
    const adapters = makeAdapters([file('f1')]);
    adapters.db.users.findById = vi.fn().mockResolvedValue({ id: 'admin', isAdmin: true });

    await runAs('admin', adapters, { ids: ['f1'], tags: ['opti:report'] });

    expect(adapters.store.get('f1')?.tags.map(t => t.name)).toEqual(['opti:report']);
  });

  it('allows a non-admin to remove a legacy registry-prefixed tag already on the file', async () => {
    const adapters = makeAdapters([file('f1', [{ name: 'opti:report', strength: 0 }])]);

    await run(adapters, { ids: ['f1'], tags: ['opti:report'] });

    expect(adapters.store.get('f1')?.tags).toEqual([]);
  });

  it('refuses the whole batch when one file would newly join, even if another is only leaving', async () => {
    const adapters = makeAdapters([file('f1', [{ name: 'opti:existing', strength: 0 }]), file('f2')]);

    await expect(run(adapters, { ids: ['f1', 'f2'], tags: ['opti:existing', 'opti:new'] })).rejects.toThrow(
      /only an admin can change this data lake/i
    );
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
    expect(adapters.db.fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
  });
});

/**
 * The admission contract at this door (#1680). Every test above uses a lake declaring no
 * `requiredPassageTokenTarget`, so the gate short-circuits and their behavior is unchanged. These
 * cover both membership signals this door can create, and the leave it must never refuse.
 */
describe('toggleTags - admission contract', () => {
  const MODEL = 'text-embedding-3-small';

  const settingsDb = (platform: Record<string, string>, overrides: Array<Partial<IScopedSetting>> = []) => ({
    adminSettings: {
      findBySettingNames: vi.fn(async (names: string[]) =>
        names.filter(n => platform[n] != null).map(n => ({ settingName: n, settingValue: platform[n] }))
      ),
      findAll: vi.fn(async () =>
        Object.entries(platform).map(([settingName, settingValue]) => ({ settingName, settingValue }))
      ),
    },
    scopedSettings: {
      findOverrides: vi.fn(
        async (scopes: ScopeRef[], names: string[]) =>
          overrides.filter(
            o =>
              names.includes(o.settingName as string) &&
              scopes.some(s => s.scopeLevel === o.scopeLevel && s.scopeId === o.scopeId)
          ) as IScopedSetting[]
      ),
    },
  });

  const enforcing: Partial<IScopedSetting> = {
    scopeLevel: SettingScopeLevel.Lake as IScopedSetting['scopeLevel'],
    scopeId: 'lake1',
    settingName: 'EnforceLakeAdmission',
    settingValue: 'true',
  };

  /**
   * A lake that REQUIRES 1000 while the owner policy is 512, with the lever ON unless `off`.
   * `dataLakes.find` returns the lake so the prefix-arm candidate resolution can see it - the
   * default harness returns [], which would make a prefix-arm join undetectable.
   */
  const withPolicy = (files: ReturnType<typeof file>[], { off = false }: { off?: boolean } = {}) => {
    const lakeDoc = lake({ requiredPassageTokenTarget: 1000 });
    const base = makeAdapters(files, lakeDoc);
    base.db.dataLakes.find = vi.fn().mockResolvedValue([lakeDoc]);
    return {
      ...base,
      db: {
        ...base.db,
        ...settingsDb({ defaultEmbeddingModel: MODEL, DefaultChunkSize: '512' }, off ? [] : [enforcing]),
      },
    };
  };

  beforeEach(() => {
    invalidateSettingsCache();
    invalidateScopedSettingsCache();
  });

  it('refuses a META-TAG join when the lake enforces and the chunk policy disagrees', async () => {
    const adapters = withPolicy([file('f1')]);

    await expect(run(adapters as never, { ids: ['f1'], tags: ['datalake:lake'] })).rejects.toThrow(
      /requires passages of 1000/
    );
    expect(adapters.db.fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('refuses a PREFIX-ARM join too - the membership signal with no meta-tag involved', async () => {
    // This is the half that gating only `datalake:*` would have left open.
    const adapters = withPolicy([file('f1')]);

    await expect(run(adapters as never, { ids: ['f1'], tags: ['lk:invoices'] })).rejects.toThrow(
      /requires passages of 1000/
    );
    expect(adapters.db.fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('never refuses a LEAVE, even while the file fails the contract for the lake it is exiting', async () => {
    // The regression that matters most: a refused removal would trap content in a lake it cannot
    // be retrieved from. This door is direction-neutral, so only the join branch may be graded.
    const adapters = withPolicy([file('f1', [{ name: 'datalake:lake', strength: 1 }])]);

    await run(adapters as never, { ids: ['f1'], tags: ['datalake:lake'] });

    expect(adapters.db.fabFiles.pullTagsByFabFileId).toHaveBeenCalledWith('f1', ['datalake:lake']);
  });

  it('allows the join when the lever is off - report-only is the default', async () => {
    const adapters = withPolicy([file('f1')], { off: true });

    await run(adapters as never, { ids: ['f1'], tags: ['datalake:lake'] });

    expect(adapters.db.fabFiles.pushTagsByFabFileId).toHaveBeenCalled();
  });

  it('refuses a multi-file batch WHOLE - a conforming file must not be joined before the refusal', async () => {
    // Files are toggled concurrently, so grading next to the write would let f1's join land and then
    // throw for f2, leaving the caller an error that reads as "nothing happened" over a partly
    // applied request. f1's chunks were built at 1000 so it conforms; f2 is unchunked and predicts
    // 512 against the lake's required 1000.
    const conforming = { ...file('f1'), chunkedPassageTokenTarget: 1000 };
    const adapters = withPolicy([conforming as never, file('f2')]);

    await expect(run(adapters as never, { ids: ['f1', 'f2'], tags: ['datalake:lake'] })).rejects.toThrow(
      /requires passages of 1000/
    );
    expect(adapters.db.fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('grades a chunked file on its recorded target rather than the owner chunk policy', async () => {
    // Owner policy is 512 and the lake requires 1000; this file's chunks were built at 1000, so it
    // conforms even though a prediction from policy would have refused it.
    const chunked = { ...file('f1'), chunkedPassageTokenTarget: 1000 };
    const lakeDoc = lake({ requiredPassageTokenTarget: 1000 });
    const base = makeAdapters([chunked as never], lakeDoc);
    base.db.dataLakes.find = vi.fn().mockResolvedValue([lakeDoc]);
    const adapters = {
      ...base,
      db: { ...base.db, ...settingsDb({ defaultEmbeddingModel: MODEL, DefaultChunkSize: '512' }, [enforcing]) },
    };

    await run(adapters as never, { ids: ['f1'], tags: ['datalake:lake'] });

    expect(adapters.db.fabFiles.pushTagsByFabFileId).toHaveBeenCalled();
  });
});
