import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyCorpusAction, type ApplyCorpusActionAdapters, type CorpusActionRequest } from './applyCorpusAction';

const removeFileFromDataLake = vi.hoisted(() => vi.fn());
const setDataLakeFileTags = vi.hoisted(() => vi.fn());

vi.mock('./removeFileFromDataLake', () => ({ removeFileFromDataLake }));
vi.mock('./setDataLakeFileTags', () => ({ setDataLakeFileTags }));

const LAKE_ID = 'lake1';
const OWNER = 'owner-1';

const lake = (over: Record<string, unknown> = {}) => ({
  id: LAKE_ID,
  name: 'Policies',
  createdByUserId: OWNER,
  status: 'active',
  datalakeTag: 'datalake:lake1',
  fileTagPrefix: 'policies:',
  ...over,
});

const finding = (over: Record<string, unknown> = {}) => ({
  id: 'finding-1',
  lakeId: LAKE_ID,
  kind: 'metric-disagreement',
  subject: 'uptime %',
  detector: 'lexical',
  status: 'open',
  documentCount: 2,
  sources: [
    { fabFileId: 'doc-a', fileName: 'a.md', excerpt: 'Uptime is 99.9%' },
    { fabFileId: 'doc-b', fileName: 'b.md', excerpt: 'Uptime is 95%' },
  ],
  ...over,
});

const member = (id: string) => ({ id, userId: OWNER, tags: [{ name: 'datalake:lake1', strength: 1 }] });

const actor = { userId: OWNER, isAdmin: false };

function makeDeps(
  over: {
    lake?: unknown;
    finding?: unknown;
    files?: Record<string, unknown>;
    /** Other dynamic lakes owned by OWNER, keyed by id - what `findIdsCreatedBy` returns. */
    otherLakes?: Record<string, unknown>;
  } = {}
) {
  const record = vi.fn(async (input: unknown) => input);
  const setLakeSupersession = vi.fn(async () => true);
  const clearLakeSupersession = vi.fn(async () => true);
  const files: Record<string, unknown> = over.files ?? {
    'doc-a': member('doc-a'),
    'doc-b': member('doc-b'),
  };
  const theLake = (over.lake ?? lake()) as { id: string };
  return {
    record,
    setLakeSupersession,
    clearLakeSupersession,
    deps: {
      db: {
        dataLakes: {
          findById: vi.fn(async (id: string) =>
            id === theLake.id ? theLake : ((over.otherLakes as Record<string, unknown> | undefined)?.[id] ?? null)
          ),
          findIdsCreatedBy: vi.fn(async () => Object.keys(over.otherLakes ?? {})),
        },
        dataLakeAccessGrants: { listByLake: vi.fn(async () => []) },
        fabFiles: {
          findById: vi.fn(async (id: string) => files[id] ?? null),
          setLakeSupersession,
          clearLakeSupersession,
          // Mirrors what the real repository method reads off `supersededInLakes` - select:false on
          // the schema means the cycle walk can no longer read it straight off `findById`.
          getLakeSupersessionWinner: vi.fn(async (id: string, lakeId: string) => {
            const file = files[id] as
              { supersededInLakes?: { dataLakeId: string; supersededByFabFileId: string }[] } | undefined;
            return file?.supersededInLakes?.find(r => r.dataLakeId === lakeId)?.supersededByFabFileId ?? null;
          }),
        },
        dataLakeFindings: { findById: vi.fn(async () => over.finding ?? finding()) },
        dataLakeCorpusActions: { record },
      },
      // The real bag is the intersection of three doors' Pick<> types; the two delegated doors are
      // mocked here and never read theirs, so only the adapters this module itself touches are
      // supplied. Cast rather than filled in, so the fixture stays about this door's own logic.
    } as unknown as ApplyCorpusActionAdapters,
  };
}

const run = (request: CorpusActionRequest, over?: Parameters<typeof makeDeps>[0]) => {
  const { deps, record, setLakeSupersession, clearLakeSupersession } = makeDeps(over);
  return {
    promise: applyCorpusAction(actor, LAKE_ID, 'finding-1', request, deps),
    record,
    setLakeSupersession,
    clearLakeSupersession,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  removeFileFromDataLake.mockResolvedValue({ success: true, fileCount: 1, totalSizeBytes: 1 });
  setDataLakeFileTags.mockResolvedValue({
    success: true,
    fileCount: 1,
    totalSizeBytes: 1,
    tags: { added: ['policies:current'], removed: [], retained: [], current: ['policies:current'] },
    primaryTagCleared: false,
  });
});

describe('applyCorpusAction merge', () => {
  it('removes each retired document through the removal door and audits the outcome', async () => {
    const { promise, record } = run({ action: 'merge', keepFabFileId: 'doc-a', retireFabFileIds: ['doc-b'] });
    const result = await promise;

    expect(removeFileFromDataLake).toHaveBeenCalledTimes(1);
    expect(removeFileFromDataLake).toHaveBeenCalledWith(actor, LAKE_ID, 'doc-b', expect.anything());
    expect(result.targets).toEqual([
      { fabFileId: 'doc-a', fileName: 'a.md', role: 'kept' },
      { fabFileId: 'doc-b', fileName: 'b.md', role: 'retired' },
    ]);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'merge', lakeId: LAKE_ID, findingId: 'finding-1', actorUserId: OWNER })
    );
  });

  it('refuses a document the finding does not cite', async () => {
    const { promise } = run({ action: 'merge', keepFabFileId: 'doc-a', retireFabFileIds: ['stranger'] });
    await expect(promise).rejects.toThrow(/not one of the documents this finding is about/);
    expect(removeFileFromDataLake).not.toHaveBeenCalled();
  });

  it('refuses to both keep and retire the same document', async () => {
    const { promise } = run({ action: 'merge', keepFabFileId: 'doc-a', retireFabFileIds: ['doc-a'] });
    await expect(promise).rejects.toThrow(/cannot both keep and retire/);
  });

  it('refuses when the kept document has since left the lake - a stale finding citing it is not proof', async () => {
    const { promise } = run(
      { action: 'merge', keepFabFileId: 'doc-a', retireFabFileIds: ['doc-b'] },
      { files: { 'doc-a': { id: 'doc-a', userId: OWNER, tags: [] }, 'doc-b': member('doc-b') } }
    );
    await expect(promise).rejects.toThrow(/document to keep is not a member/);
    expect(removeFileFromDataLake).not.toHaveBeenCalled();
  });
});

describe('applyCorpusAction supersede', () => {
  it('writes the lake-scoped marker the retrieval collapse reads', async () => {
    const { promise, setLakeSupersession, record } = run({
      action: 'supersede',
      keepFabFileId: 'doc-a',
      retireFabFileId: 'doc-b',
    });
    const result = await promise;

    expect(setLakeSupersession).toHaveBeenCalledWith('doc-b', {
      dataLakeId: LAKE_ID,
      supersededByFabFileId: 'doc-a',
      decidedByUserId: OWNER,
      decidedAt: expect.any(Date),
    });
    // Suppression, not deletion: nothing leaves the corpus, which is the property most easily
    // misread about this action.
    expect(result.detail).toEqual({ suppressedFromRanking: 'doc-b', removedFromCorpus: false });
    expect(removeFileFromDataLake).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'supersede' }));
  });

  it('refuses when the winner is not a live member of the lake', async () => {
    const { promise, setLakeSupersession } = run(
      { action: 'supersede', keepFabFileId: 'doc-a', retireFabFileId: 'doc-b' },
      { files: { 'doc-b': member('doc-b') } }
    );
    await expect(promise).rejects.toThrow(/File not found in this data lake/);
    expect(setLakeSupersession).not.toHaveBeenCalled();
  });

  it('refuses a self-supersede', async () => {
    const { promise } = run({ action: 'supersede', keepFabFileId: 'doc-a', retireFabFileId: 'doc-a' });
    await expect(promise).rejects.toThrow(/cannot supersede itself/);
  });

  it('refuses to retire a document that belongs to more than one lake by meta-tag - the ruling would never be honored', async () => {
    const multiLakeDoc = {
      ...member('doc-b'),
      tags: [
        { name: 'datalake:lake1', strength: 1 },
        { name: 'datalake:other-lake', strength: 1 },
      ],
    };
    const { promise, setLakeSupersession } = run(
      { action: 'supersede', keepFabFileId: 'doc-a', retireFabFileId: 'doc-b' },
      { files: { 'doc-a': member('doc-a'), 'doc-b': multiLakeDoc } }
    );
    await expect(promise).rejects.toThrow(/belongs to more than one data lake/);
    expect(setLakeSupersession).not.toHaveBeenCalled();
  });

  it(
    'refuses to retire a document whose ONLY datalake meta-tag names a foreign lake - member here ' +
      'by prefix alone, but it also claims a lake this write can never honor',
    async () => {
      // In-lake via the prefix arm only (no 'datalake:lake1' tag at all), but the single meta-tag
      // it does carry names a different lake entirely. Before the fix this passed
      // `memberOfMoreThanOneLakeByMetaTag` (only one datalake:* tag) and resolved to `lake.id` via
      // the prefix arm, so the write went through and reported a suppression the collapse would
      // never honor for anyone reading through lake2's own scope.
      const foreignMetaTagDoc = {
        ...member('doc-b'),
        tags: [
          { name: 'policies:doc', strength: 1 },
          { name: 'datalake:lake2', strength: 1 },
        ],
      };
      const { promise, setLakeSupersession } = run(
        { action: 'supersede', keepFabFileId: 'doc-a', retireFabFileId: 'doc-b' },
        { files: { 'doc-a': member('doc-a'), 'doc-b': foreignMetaTagDoc } }
      );
      await expect(promise).rejects.toThrow(/belongs to more than one data lake/);
      expect(setLakeSupersession).not.toHaveBeenCalled();
    }
  );

  it(
    "allows a supersede that the guard would otherwise refuse only because the owner's own " +
      'non-active lake shares a content-tag prefix - that lake can never grant an attribution, ' +
      'because the read scope this guard mirrors excludes it',
    async () => {
      const draftLakeId = 'lake-draft';
      const draftLake = lake({
        id: draftLakeId,
        status: 'draft',
        datalakeTag: 'datalake:draftlake',
        fileTagPrefix: 'draft:',
        createdByUserId: OWNER,
      });
      const doc = {
        ...member('doc-b'),
        tags: [
          { name: 'policies:doc', strength: 1 },
          { name: 'draft:something', strength: 1 },
        ],
      };
      const { promise, setLakeSupersession } = run(
        { action: 'supersede', keepFabFileId: 'doc-a', retireFabFileId: 'doc-b' },
        { files: { 'doc-a': member('doc-a'), 'doc-b': doc }, otherLakes: { [draftLakeId]: draftLake } }
      );
      await promise;
      expect(setLakeSupersession).toHaveBeenCalled();
    }
  );

  it(
    'refuses to retire a document ambiguous only by the dynamic-lake prefix arm - a second tag ' +
      'carries no `datalake:<slug>` meta-tag, only a content prefix matching another lake OWNER owns',
    async () => {
      const otherLakeId = 'lake2';
      const otherLake = lake({
        id: otherLakeId,
        datalakeTag: 'datalake:lake2',
        fileTagPrefix: 'legal:',
        createdByUserId: OWNER,
      });
      // Only ONE datalake:<slug> meta-tag - `memberOfMoreThanOneLakeByMetaTag` alone would miss this.
      // The second tag matches lake2's prefix, and lake2 is owned by the same user as the file, so
      // the dynamic-lake prefix arm resolves it too - exactly the gap the prefix-arm check closes.
      const prefixAmbiguousDoc = {
        ...member('doc-b'),
        tags: [
          { name: 'datalake:lake1', strength: 1 },
          { name: 'legal:contract', strength: 1 },
        ],
      };
      const { promise, setLakeSupersession } = run(
        { action: 'supersede', keepFabFileId: 'doc-a', retireFabFileId: 'doc-b' },
        { files: { 'doc-a': member('doc-a'), 'doc-b': prefixAmbiguousDoc }, otherLakes: { [otherLakeId]: otherLake } }
      );
      await expect(promise).rejects.toThrow(/belongs to more than one data lake/);
      expect(setLakeSupersession).not.toHaveBeenCalled();
    }
  );

  it(
    'refuses to retire a document ambiguous by the static-registry prefix arm - a content tag ' +
      'matching a compile-time DATA_LAKES prefix needs no owned lake or DB read to attribute',
    async () => {
      const staticRegistryAmbiguousDoc = {
        ...member('doc-b'),
        tags: [
          { name: 'policies:doc', strength: 1 },
          // 'opti:' is DATA_LAKES's always-present static-registry lake prefix (opti-knowledge).
          { name: 'opti:something', strength: 1 },
        ],
      };
      const { promise, setLakeSupersession } = run(
        { action: 'supersede', keepFabFileId: 'doc-a', retireFabFileId: 'doc-b' },
        { files: { 'doc-a': member('doc-a'), 'doc-b': staticRegistryAmbiguousDoc } }
      );
      await expect(promise).rejects.toThrow(/belongs to more than one data lake/);
      expect(setLakeSupersession).not.toHaveBeenCalled();
    }
  );

  it("propagates rather than swallows a failure resolving the owner's other lakes", async () => {
    const { deps } = makeDeps({ files: { 'doc-a': member('doc-a'), 'doc-b': member('doc-b') } });
    (deps.db.dataLakes.findIdsCreatedBy as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('lookup boom'));

    await expect(
      applyCorpusAction(
        actor,
        LAKE_ID,
        'finding-1',
        { action: 'supersede', keepFabFileId: 'doc-a', retireFabFileId: 'doc-b' },
        deps
      )
    ).rejects.toThrow(/lookup boom/);
  });

  it('allows a retiring document whose content tag matches only a prefix the file owner does not own a lake for', async () => {
    // 'legal:contract' looks structurally like it could match a prefix, but no lake owned by this
    // file's owner (nor the static registry) carries that prefix, so it is not a real attribution
    // signal - matching what `attributeFileToLakeIds` itself would resolve at collapse time.
    const singleLakeDoc = {
      ...member('doc-b'),
      tags: [
        { name: 'datalake:lake1', strength: 1 },
        { name: 'legal:contract', strength: 1 },
      ],
    };
    const { promise, setLakeSupersession } = run(
      { action: 'supersede', keepFabFileId: 'doc-a', retireFabFileId: 'doc-b' },
      { files: { 'doc-a': member('doc-a'), 'doc-b': singleLakeDoc } }
    );
    await promise;
    expect(setLakeSupersession).toHaveBeenCalled();
  });

  it('refuses a write that would close a supersession cycle', async () => {
    // doc-b (the document this request wants to KEEP) is already ruled superseded-by doc-a for
    // this lake. Writing "doc-a superseded by doc-b" on top would close a 2-cycle: doc-a's new
    // entry points to doc-b, doc-b's existing entry points to doc-a.
    const keepAlreadyRuledBehindRetire = {
      ...member('doc-b'),
      supersededInLakes: [
        { dataLakeId: LAKE_ID, supersededByFabFileId: 'doc-a', decidedByUserId: OWNER, decidedAt: new Date() },
      ],
    };
    const { promise, setLakeSupersession } = run(
      { action: 'supersede', keepFabFileId: 'doc-b', retireFabFileId: 'doc-a' },
      { files: { 'doc-a': member('doc-a'), 'doc-b': keepAlreadyRuledBehindRetire } }
    );
    await expect(promise).rejects.toThrow(/already ruled superseded/);
    expect(setLakeSupersession).not.toHaveBeenCalled();
  });
});

describe('applyCorpusAction unsupersede', () => {
  it('clears the ruling and records the document as restored', async () => {
    const { promise, clearLakeSupersession, record } = run({ action: 'unsupersede', fabFileId: 'doc-b' });
    const result = await promise;

    expect(clearLakeSupersession).toHaveBeenCalledWith('doc-b', LAKE_ID);
    expect(result.targets).toEqual([{ fabFileId: 'doc-b', fileName: 'b.md', role: 'restored' }]);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'unsupersede' }));
  });

  it('refuses when there was no ruling to clear', async () => {
    const { deps, record } = makeDeps();
    deps.db.fabFiles.clearLakeSupersession = vi.fn(async () => false);
    await expect(
      applyCorpusAction(actor, LAKE_ID, 'finding-1', { action: 'unsupersede', fabFileId: 'doc-b' }, deps)
    ).rejects.toThrow(/not superseded in this data lake/);
    expect(record).not.toHaveBeenCalled();
  });
});

describe('applyCorpusAction retag', () => {
  it('delegates to the tag door and records its diff', async () => {
    const { promise, record } = run({ action: 'retag', fabFileId: 'doc-a', tags: ['policies:current'] });
    const result = await promise;

    expect(setDataLakeFileTags).toHaveBeenCalledWith(actor, LAKE_ID, 'doc-a', ['policies:current'], expect.anything());
    expect(result.targets).toEqual([{ fabFileId: 'doc-a', fileName: 'a.md', role: 'retagged' }]);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'retag', detail: expect.objectContaining({ tags: expect.anything() }) })
    );
  });
});

describe('applyCorpusAction guards', () => {
  it('refuses a finding belonging to another lake without saying it exists', async () => {
    const { promise } = run(
      { action: 'merge', keepFabFileId: 'doc-a', retireFabFileIds: ['doc-b'] },
      { finding: finding({ lakeId: 'other-lake' }) }
    );
    await expect(promise).rejects.toThrow(/Finding not found/);
  });

  it('refuses a finding a curator already ruled on', async () => {
    const { promise } = run(
      { action: 'merge', keepFabFileId: 'doc-a', retireFabFileIds: ['doc-b'] },
      { finding: finding({ status: 'dismissed' }) }
    );
    await expect(promise).rejects.toThrow(/already been ruled on/);
    expect(removeFileFromDataLake).not.toHaveBeenCalled();
  });

  it('refuses when the lake does not exist', async () => {
    const { deps } = makeDeps();
    deps.db.dataLakes.findById = vi.fn(async () => null);
    await expect(
      applyCorpusAction(
        actor,
        LAKE_ID,
        'finding-1',
        { action: 'merge', keepFabFileId: 'doc-a', retireFabFileIds: ['doc-b'] },
        deps
      )
    ).rejects.toThrow(/Data lake not found/);
  });

  it('refuses to act on a fallback (static-registry) lake before reading any finding', async () => {
    const { deps, record } = makeDeps({ lake: lake({ id: 'opti-knowledge', createdByUserId: '' }) });
    await expect(
      applyCorpusAction(
        { userId: OWNER, isAdmin: true },
        'opti-knowledge',
        'finding-1',
        { action: 'merge', keepFabFileId: 'doc-a', retireFabFileIds: ['doc-b'] },
        deps
      )
    ).rejects.toThrow(/built into the platform/);
    expect(deps.db.dataLakeFindings.findById).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses a supersede when setLakeSupersession finds nothing to write (the file vanished between read and write)', async () => {
    const { deps, record } = makeDeps();
    deps.db.fabFiles.setLakeSupersession = vi.fn(async () => false);
    await expect(
      applyCorpusAction(
        actor,
        LAKE_ID,
        'finding-1',
        { action: 'supersede', keepFabFileId: 'doc-a', retireFabFileId: 'doc-b' },
        deps
      )
    ).rejects.toThrow(/File not found in this data lake/);
    expect(record).not.toHaveBeenCalled();
  });

  it('retries a failing audit write before giving up, and still throws once retries are exhausted', async () => {
    const { deps, record } = makeDeps();
    (deps.db.dataLakeCorpusActions.record as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('write boom'));
    await expect(
      applyCorpusAction(actor, LAKE_ID, 'finding-1', { action: 'retag', fabFileId: 'doc-a', tags: [] }, deps)
    ).rejects.toThrow('write boom');
    expect(record).toHaveBeenCalledTimes(3);
  });

  it('recovers from a transient audit-write failure without losing the outcome', async () => {
    const { deps, record } = makeDeps();
    (deps.db.dataLakeCorpusActions.record as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({});
    const result = await applyCorpusAction(
      actor,
      LAKE_ID,
      'finding-1',
      { action: 'retag', fabFileId: 'doc-a', tags: [] },
      deps
    );
    expect(result.action).toBe('retag');
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('refuses an actor with no manage rung on the lake', async () => {
    const { deps } = makeDeps();
    await expect(
      applyCorpusAction(
        { userId: 'stranger', isAdmin: false },
        LAKE_ID,
        'finding-1',
        { action: 'merge', keepFabFileId: 'doc-a', retireFabFileIds: ['doc-b'] },
        deps
      )
    ).rejects.toThrow(/do not have permission/);
  });

  it('records the API-key principal rather than the human when a key is acting', async () => {
    const { deps, record } = makeDeps();
    await applyCorpusAction(
      { ...actor, auditPrincipal: { principalKind: 'api-key', principalId: 'key-9', onBehalfOfUserId: OWNER } },
      LAKE_ID,
      'finding-1',
      { action: 'supersede', keepFabFileId: 'doc-a', retireFabFileId: 'doc-b' },
      deps
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: { principalKind: 'api-key', principalId: 'key-9', onBehalfOfUserId: OWNER },
        rung: 'creator',
      })
    );
  });

  it('audits only after the mutation succeeded', async () => {
    removeFileFromDataLake.mockRejectedValueOnce(new Error('boom'));
    const { promise, record } = run({ action: 'merge', keepFabFileId: 'doc-a', retireFabFileIds: ['doc-b'] });
    await expect(promise).rejects.toThrow('boom');
    expect(record).not.toHaveBeenCalled();
  });

  it('audits a merge that failed PART WAY, naming only the members that really went', async () => {
    // The first removal committed and cannot be rolled back, so the alternative to this row is
    // membership changed with no trail saying who changed it. `partial` is what keeps the row from
    // claiming the whole merge happened.
    const finding3 = finding({
      sources: [
        { fabFileId: 'doc-a', fileName: 'a.md', excerpt: 'x' },
        { fabFileId: 'doc-b', fileName: 'b.md', excerpt: 'y' },
        { fabFileId: 'doc-c', fileName: 'c.md', excerpt: 'z' },
      ],
    });
    removeFileFromDataLake.mockResolvedValueOnce({ success: true }).mockRejectedValueOnce(new Error('boom'));

    const { promise, record } = run(
      { action: 'merge', keepFabFileId: 'doc-a', retireFabFileIds: ['doc-b', 'doc-c'] },
      { finding: finding3 }
    );
    await expect(promise).rejects.toThrow('boom');

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'merge',
        detail: { removedFabFileIds: ['doc-b'], partial: true, requestedFabFileIds: ['doc-b', 'doc-c'] },
        targets: [
          { fabFileId: 'doc-a', fileName: 'a.md', role: 'kept' },
          { fabFileId: 'doc-b', fileName: 'b.md', role: 'retired' },
        ],
      })
    );
  });
});
