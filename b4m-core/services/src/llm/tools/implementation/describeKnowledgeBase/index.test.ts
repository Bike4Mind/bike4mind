import { describe, it, expect, vi, beforeEach } from 'vitest';

const getDynamicDataLakeAccessMock = vi.fn();
vi.mock('../../../../dataLakeService/getDynamicDataLakeTags', () => ({
  getDynamicDataLakeAccess: (...args: unknown[]) => getDynamicDataLakeAccessMock(...args),
}));

import { describeKnowledgeBaseTool } from './index';
import type { ToolContext } from '../../base/types';

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** A DB lake: membership carries the creator its prefix arm is anchored to. */
const dynamicLake = {
  id: 'lake1',
  name: 'Research Library',
  slug: 'research',
  datalakeTag: 'datalake:org1:research',
  fileTagPrefix: 'acme:',
  membership: {
    kind: 'owned' as const,
    datalakeTag: 'datalake:org1:research',
    fileTagPrefix: 'acme:',
    creatorUserId: 'owner1',
  },
  source: 'dynamic' as const,
};

/** A static-registry lake: no creator, so its prefix arm is unanchored. */
const registryLake = {
  id: 'lake2',
  name: 'Shared KB',
  slug: 'shared',
  datalakeTag: 'datalake:shared',
  fileTagPrefix: 'opti:',
  membership: { kind: 'registry' as const, datalakeTag: 'datalake:shared', fileTagPrefix: 'opti:' },
  source: 'registry' as const,
};

const emptyStats = { fileCount: 12, totalSizeBytes: 1024 * 1024, totalChunkedChars: 0 };
const emptyHealth = {
  chunkedFiles: 0,
  fullyVectorizedFiles: 0,
  failedFiles: 0,
  inFlightFiles: 0,
  totalChunks: 0,
  totalEmbeddedChunks: 0,
};

function makeContext(
  overrides: Partial<ToolContext> = {},
  fabfilesOverrides: Record<string, unknown> = {}
): ToolContext {
  return {
    userId: 'u1',
    user: { id: 'u1', groups: ['g1'] } as never,
    sessionId: 's1',
    logger: logger as never,
    statusUpdate: vi.fn().mockResolvedValue(undefined),
    db: {
      fabfiles: {
        computeDataLakeStats: vi.fn().mockResolvedValue(emptyStats),
        countDataLakeTopicTags: vi.fn().mockResolvedValue([{ tag: 'oncology', count: 5 }]),
        summarizeDataLakeIndexingHealth: vi.fn().mockResolvedValue(emptyHealth),
        findDataLakeMembershipMembers: vi.fn().mockResolvedValue([]),
        search: vi.fn().mockResolvedValue({ data: [], total: 0, hasMore: false }),
        ...fabfilesOverrides,
      },
      fabfilechunks: { distinctRetrievalIndexModelsByFabFileIds: vi.fn().mockResolvedValue([]) },
      dataLakes: { findById: vi.fn().mockResolvedValue(null) },
      adminSettings: { getSettingsValue: vi.fn().mockResolvedValue('text-embedding-3-large') },
    } as never,
    ...overrides,
  } as ToolContext;
}

const run = (context: ToolContext) =>
  describeKnowledgeBaseTool.implementation(context, undefined).toolFn({}) as Promise<string>;

beforeEach(() => {
  // `logger` is module-level and shared, so a test asserting a warn was NOT emitted would otherwise
  // see the previous test's.
  logger.log.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
  getDynamicDataLakeAccessMock.mockReset().mockResolvedValue({
    dataLakeTags: [dynamicLake.datalakeTag],
    dataLakeTagPrefixes: [],
    scopedTagPrefixes: [dynamicLake.fileTagPrefix],
    lakes: [dynamicLake],
  });
});

describe('describe_knowledge_base', () => {
  it('reports the lake name, size, topics and embedding model', async () => {
    const out = await run(makeContext());
    expect(out).toContain('Research Library (dynamic lake)');
    expect(out).toContain('Corpus size: 12 document(s)');
    expect(out).toContain('oncology (5)');
    expect(out).toContain('Embedding model for new ingests (platform default): text-embedding-3-large');
  });

  it('reads every data source through the SAME lake membership scope, not a hand-rolled predicate', async () => {
    const ctx = makeContext();
    await run(ctx);
    const fabfiles = ctx.db.fabfiles as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(fabfiles.computeDataLakeStats).toHaveBeenCalledWith(dynamicLake.membership);
    expect(fabfiles.countDataLakeTopicTags).toHaveBeenCalledWith(dynamicLake.membership, expect.any(Number));
    expect(fabfiles.summarizeDataLakeIndexingHealth).toHaveBeenCalledWith(dynamicLake.membership);
    expect(fabfiles.findDataLakeMembershipMembers).toHaveBeenCalledWith(dynamicLake.membership, expect.any(Number));
    // The aggregate path must not pay search's countDocuments for a total it already has.
    expect(fabfiles.search).not.toHaveBeenCalled();
  });

  it('works for a registry lake through its own registry membership scope', async () => {
    getDynamicDataLakeAccessMock.mockResolvedValue({
      dataLakeTags: [],
      dataLakeTagPrefixes: [registryLake.fileTagPrefix],
      scopedTagPrefixes: [],
      lakes: [registryLake],
    });
    const ctx = makeContext();
    const out = await run(ctx);
    expect(out).toContain('Shared KB (registry lake)');
    const fabfiles = ctx.db.fabfiles as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(fabfiles.computeDataLakeStats).toHaveBeenCalledWith(registryLake.membership);
  });

  it('describes several libraries, each under its own heading', async () => {
    getDynamicDataLakeAccessMock.mockResolvedValue({
      dataLakeTags: [],
      dataLakeTagPrefixes: [],
      scopedTagPrefixes: [],
      lakes: [dynamicLake, registryLake],
    });
    const out = await run(makeContext());
    expect(out).toContain('Research Library (dynamic lake)');
    expect(out).toContain('Shared KB (registry lake)');
  });

  it('reports pipeline health from the whole-lake scalar read, in-flight kept distinct from failed', async () => {
    const ctx = makeContext(
      {},
      {
        summarizeDataLakeIndexingHealth: vi.fn().mockResolvedValue({
          chunkedFiles: 3,
          fullyVectorizedFiles: 1,
          failedFiles: 2,
          inFlightFiles: 1,
          totalChunks: 9,
          totalEmbeddedChunks: 4,
        }),
      }
    );
    const out = await run(ctx);
    expect(out).toContain('3 chunked');
    expect(out).toContain('1 fully vectorized');
    // A member still being indexed is neither done nor broken - it must not be folded into either.
    expect(out).toContain('1 still indexing');
    // The scalar read spans the WHOLE membership, so a pre-chunk extraction failure (invisible to
    // findDataLakeHealthMembers' chunk-bearing $match) is counted here.
    expect(out).toContain('2 failed');
    expect(out).toContain('9 chunk(s) total (4 carrying a vector)');
  });

  it('derives folder structure from relativePath using the shared discriminator, not a truthy check', async () => {
    // 'readme.txt' with relativePath === fileName is a FLAT upload (the picker's fallback), not a
    // folder - the exact ambiguity folderKeyOf exists to resolve. 'docs/readme.txt' IS a folder.
    const files = [
      { fileName: 'readme.txt', relativePath: 'readme.txt' },
      { fileName: 'notes.md', relativePath: 'docs/notes.md' },
      { fileName: 'plan.md', relativePath: 'docs/plan.md' },
    ];
    const ctx = makeContext({}, { findDataLakeMembershipMembers: vi.fn().mockResolvedValue(files) });
    const out = await run(ctx);
    expect(out).toContain('docs (2)');
    expect(out).toContain('(no folder) (1)');
    expect(out).not.toContain('sampled from');
  });

  it('omits description/status/last-ingest when the lake has no backing document (e.g. a registry lake)', async () => {
    const ctx = makeContext();
    const out = await run(ctx);
    expect(out).not.toContain('Description:');
    expect(out).not.toContain('Status:');
    expect(out).not.toContain('Last ingest:');
  });

  it('logs (rather than silently swallowing) a lake-document lookup failure, and still reports the rest', async () => {
    const ctx = makeContext();
    (ctx.db.dataLakes!.findById as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('connection reset'));
    const out = await run(ctx);
    expect(out).toContain('Corpus size: 12 document(s)');
    expect(out).not.toContain('Description:');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('lake document lookup failed'), expect.any(Error));
  });

  it('includes description, status and last ingest when the lake document resolves', async () => {
    const lastSyncAt = new Date('2026-08-01T00:00:00.000Z');
    const ctx = makeContext({}, {});
    (ctx.db.dataLakes!.findById as ReturnType<typeof vi.fn>).mockResolvedValue({
      description: 'Internal research papers',
      status: 'active',
      lastSyncAt,
    });
    const out = await run(ctx);
    expect(out).toContain('Description: Internal research papers');
    expect(out).toContain('Status: active');
    expect(out).toContain(lastSyncAt.toISOString());
  });

  it('reports "not configured" when no default embedding model is set', async () => {
    const ctx = makeContext({}, {});
    (ctx.db.adminSettings.getSettingsValue as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const out = await run(ctx);
    expect(out).toContain('Embedding model for new ingests (platform default): not configured');
  });

  describe('agent-scoped knowledge base (kbScope)', () => {
    it('reports a fixed file-set size without resolving owner-wide lake access', async () => {
      const ctx = makeContext({ kbScope: { fileIds: ['f1', 'f2'] } });
      const out = await run(ctx);
      expect(getDynamicDataLakeAccessMock).not.toHaveBeenCalled();
      expect(out).toContain("This agent's knowledge base is a fixed set of 2 document(s)");
    });

    it('a scope of nothing describes nothing and resolves no lake access', async () => {
      const ctx = makeContext({ kbScope: { fileIds: [] } });
      const out = await run(ctx);
      expect(out).toContain('no documents');
      expect(getDynamicDataLakeAccessMock).not.toHaveBeenCalled();
    });
  });

  it('with no accessible lake, says so rather than fabricating a corpus shape', async () => {
    getDynamicDataLakeAccessMock.mockResolvedValue({
      dataLakeTags: [],
      dataLakeTagPrefixes: [],
      scopedTagPrefixes: [],
      lakes: [],
    });
    const out = await run(makeContext());
    expect(out).toContain('no data lake / curated library');
    expect(out).toContain('count_knowledge_base');
  });

  it('says the description is unavailable rather than letting a failure become a guess', async () => {
    const ctx = makeContext({}, { computeDataLakeStats: vi.fn().mockRejectedValue(new Error('mongo down')) });
    const out = await run(ctx);
    expect(out).toContain('Could not describe');
    expect(out).toContain('rather than guessing');
  });

  it('only looks up a backing document for a DYNAMIC lake - a registry id is a slug, not an ObjectId', async () => {
    getDynamicDataLakeAccessMock.mockResolvedValue({
      dataLakeTags: [],
      dataLakeTagPrefixes: [registryLake.fileTagPrefix],
      scopedTagPrefixes: [],
      lakes: [registryLake],
    });
    const ctx = makeContext();
    const out = await run(ctx);
    // findById has no ObjectId guard, so asking it for 'lake2' would throw a CastError on the
    // NORMAL registry path and log it as the genuine DB error the warn is reserved for.
    expect(ctx.db.dataLakes!.findById).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(out).toContain('Shared KB (registry lake)');
  });

  it('discloses folder sampling only when the member scan actually overflowed', async () => {
    // findDataLakeMembershipMembers fetches one row past the bound to signal overflow.
    const members = Array.from({ length: 501 }, (_, i) => ({
      fabFileId: `f${i}`,
      fileName: `doc${i}.md`,
      relativePath: `docs/doc${i}.md`,
    }));
    const ctx = makeContext({}, { findDataLakeMembershipMembers: vi.fn().mockResolvedValue(members) });
    const out = await run(ctx);
    expect(out).toContain('sampled from 500 files');
    // The extra overflow row is trimmed back off, so the count reflects the bound exactly.
    expect(out).toContain('docs (500)');
  });

  it('reports the models the corpus was actually embedded with, not just the platform default', async () => {
    const ctx = makeContext(
      {},
      {
        findDataLakeMembershipMembers: vi
          .fn()
          .mockResolvedValue([{ fabFileId: 'f1', fileName: 'a.md', relativePath: null }]),
      }
    );
    (
      ctx.db.fabfilechunks!.distinctRetrievalIndexModelsByFabFileIds as ReturnType<typeof vi.fn>
    ).mockResolvedValue(['text-embedding-ada-002']);
    const out = await run(ctx);
    expect(ctx.db.fabfilechunks!.distinctRetrievalIndexModelsByFabFileIds).toHaveBeenCalledWith(['f1']);
    // The stale model is the point: this is the lake where retrieval quietly returns less than the
    // platform default would suggest.
    expect(out).toContain('Embedded with (sampled from this corpus): text-embedding-ada-002');
    expect(out).toContain('Embedding model for new ingests (platform default): text-embedding-3-large');
  });

  it('still describes the lake when the embedding-model sample fails', async () => {
    const ctx = makeContext(
      {},
      {
        findDataLakeMembershipMembers: vi
          .fn()
          .mockResolvedValue([{ fabFileId: 'f1', fileName: 'a.md', relativePath: null }]),
      }
    );
    (ctx.db.fabfilechunks!.distinctRetrievalIndexModelsByFabFileIds as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('chunk read failed')
    );
    const out = await run(ctx);
    expect(out).toContain('Corpus size: 12 document(s)');
    expect(out).not.toContain('Embedded with');
  });

  it('distinguishes the corpus total from what this turn retrieved', async () => {
    const out = await run(makeContext());
    expect(out).toContain('not what was retrieved this turn');
  });
});

describe('describe_knowledge_base honours the session retrieval-exclusion contract', () => {
  /**
   * A session carrying excludeFilenameMarkers/vectorizedOnly says those documents stay OUT of
   * grounding, and tools/base/types.ts documents that contract as failing OPEN for any tool that
   * skips it. A corpus size, a topic list or a folder name computed over the withheld documents
   * discloses exactly what the session withheld, so the aggregate path must not be taken at all.
   */
  const excluded = {
    id: 'f1',
    fileName: 'DRAFT - internal.pdf',
    relativePath: null,
    fileSize: 100,
    vectorized: true,
    chunkCount: 2,
    embeddedChunkCount: 2,
    error: null,
    tags: [{ name: 'secret-topic' }, { name: 'acme:uncategorized' }],
  };
  const kept = {
    id: 'f2',
    fileName: 'oncology-review.pdf',
    relativePath: 'papers/oncology-review.pdf',
    fileSize: 400,
    vectorized: true,
    chunkCount: 3,
    embeddedChunkCount: 3,
    error: null,
    tags: [{ name: 'oncology' }, { name: 'oncology' }, { name: 'acme:' }],
  };

  it('walks and filters in memory rather than aggregating over the withheld documents', async () => {
    const search = vi.fn().mockResolvedValue({ data: [excluded, kept], total: 2, hasMore: false });
    const ctx = makeContext({ retrievalFilter: { excludeFilenameMarkers: ['draft'] } } as never, { search });
    const fabfiles = ctx.db.fabfiles as unknown as Record<string, ReturnType<typeof vi.fn>>;
    const out = await run(ctx);

    // None of the aggregations may run: not one of them has an exclusion arm.
    expect(fabfiles.computeDataLakeStats).not.toHaveBeenCalled();
    expect(fabfiles.countDataLakeTopicTags).not.toHaveBeenCalled();
    expect(fabfiles.summarizeDataLakeIndexingHealth).not.toHaveBeenCalled();
    // The DB pre-filter is best-effort, so the options still carry it...
    expect(search).toHaveBeenCalledWith(
      'u1',
      '',
      {},
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ excludeFilenameMarkers: ['draft'], lakeMemberships: [dynamicLake.membership] })
    );
    // ...and the in-memory pass is what the reported figures are actually built from.
    expect(out).toContain('Corpus size: 1 document(s)');
    expect(out).not.toContain('secret-topic');
    expect(out).not.toContain('DRAFT');
    expect(out).toContain('oncology (1)');
    expect(out).toContain('papers (1)');
  });

  it('excludes membership-signal tags in memory exactly as the aggregate does', async () => {
    const search = vi.fn().mockResolvedValue({ data: [kept], total: 1, hasMore: false });
    const ctx = makeContext({ retrievalFilter: { vectorizedOnly: true } } as never, { search });
    const out = await run(ctx);
    // `acme:` and `acme:uncategorized` say how the file became a MEMBER, not what it is about; and
    // a doubled 'oncology' is one document, not two.
    expect(out).toContain('Top topics: oncology (1)');
    expect(out).not.toContain('acme:');
  });

  it('derives health from the surviving rows with embeddedChunkCount, never vectorizedChunkCount', async () => {
    const rows = [
      { ...kept, id: 'a', chunkCount: 4, vectorizedChunkCount: 4, embeddedChunkCount: 4, error: null },
      // vectorizedChunkCount counts an oversized un-embeddable chunk as done; embeddedChunkCount
      // does not. This row is NOT fully vectorized.
      { ...kept, id: 'b', chunkCount: 4, vectorizedChunkCount: 4, embeddedChunkCount: 2, error: null },
      // A legacy empty-string error is not a failure - the evaluator's hasError needs a NON-EMPTY
      // string, and `{ $ne: null }` would have called this one broken.
      { ...kept, id: 'c', chunkCount: 2, vectorizedChunkCount: 2, embeddedChunkCount: 2, error: '' },
      // Extraction failed before chunking: no chunks at all, but a real failure.
      { ...kept, id: 'd', chunkCount: 0, vectorizedChunkCount: null, embeddedChunkCount: null, error: 'boom' },
    ];
    const search = vi.fn().mockResolvedValue({ data: rows, total: rows.length, hasMore: false });
    const ctx = makeContext({ retrievalFilter: { vectorizedOnly: true } } as never, { search });
    const out = await run(ctx);
    expect(out).toContain('3 chunked');
    expect(out).toContain('2 fully vectorized');
    expect(out).toContain('1 still indexing');
    expect(out).toContain('1 failed');
  });

  it('reports a floor, and says so, when the walk hits its scan bound', async () => {
    const page = Array.from({ length: 200 }, (_, i) => ({ ...kept, id: `f${i}` }));
    const search = vi.fn().mockResolvedValue({ data: page, total: 5000, hasMore: true });
    const ctx = makeContext({ retrievalFilter: { vectorizedOnly: true } } as never, { search });
    const out = await run(ctx);
    expect(search).toHaveBeenCalledTimes(10);
    expect(out).toContain('Corpus size: at least 2000 document(s)');
    expect(out).toContain('read them as floors');
  });

  it('takes the aggregate path when the session withholds nothing', async () => {
    const ctx = makeContext({ retrievalFilter: { excludeFilenameMarkers: ['  ', ''] } } as never);
    const fabfiles = ctx.db.fabfiles as unknown as Record<string, ReturnType<typeof vi.fn>>;
    await run(ctx);
    expect(fabfiles.computeDataLakeStats).toHaveBeenCalled();
    expect(fabfiles.search).not.toHaveBeenCalled();
  });
});

describe('describe_knowledge_base honours the personal-corpus scope', () => {
  it('never enumerates the owner lakes when the session corpus is personal', async () => {
    const ctx = makeContext({ suppressLakeArms: true } as never);
    await run(ctx);
    expect(getDynamicDataLakeAccessMock).not.toHaveBeenCalled();
  });
});

describe('describe_knowledge_base narrows lake access to the session lake', () => {
  it('describes only the session lake, never naming an unrelated one', async () => {
    getDynamicDataLakeAccessMock.mockResolvedValue({
      dataLakeTags: ['datalake:mine', 'datalake:unrelated'],
      dataLakeTagPrefixes: ['mine:', 'unrel:'],
      scopedTagPrefixes: [],
      lakes: [
        {
          id: 'l1',
          name: 'mine',
          datalakeTag: 'datalake:mine',
          fileTagPrefix: 'mine:',
          membership: { kind: 'registry', datalakeTag: 'datalake:mine', fileTagPrefix: 'mine:' },
          source: 'registry',
        },
        {
          id: 'l2',
          name: 'Unrelated-Product-KB',
          datalakeTag: 'datalake:unrelated',
          fileTagPrefix: 'unrel:',
          membership: { kind: 'registry', datalakeTag: 'datalake:unrelated', fileTagPrefix: 'unrel:' },
          source: 'registry',
        },
      ],
    });
    const out = await run(makeContext({ sessionRetrievalTags: ['datalake:mine'] } as never));
    expect(out).not.toContain('Unrelated-Product-KB');
  });
});
