import { describe, it, expect, vi, beforeEach } from 'vitest';

const getDynamicDataLakeAccessMock = vi.fn();
vi.mock('../../../../dataLakeService/getDynamicDataLakeTags', () => ({
  getDynamicDataLakeAccess: (...args: unknown[]) => getDynamicDataLakeAccessMock(...args),
}));

import { describeKnowledgeBaseTool } from './index';
import type { ToolContext } from '../../base/types';

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

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

function makeContext(
  overrides: Partial<ToolContext> = {},
  fabfilesOverrides: Record<string, unknown> = {}
): ToolContext {
  return {
    userId: 'u1',
    user: { id: 'u1', groups: ['g1'] } as never,
    sessionId: 's1',
    logger,
    statusUpdate: vi.fn().mockResolvedValue(undefined),
    db: {
      fabfiles: {
        computeDataLakeStats: vi.fn().mockResolvedValue(emptyStats),
        countDataLakeTopicTags: vi.fn().mockResolvedValue([{ tag: 'oncology', count: 5 }]),
        findDataLakeHealthMembers: vi.fn().mockResolvedValue([]),
        search: vi.fn().mockResolvedValue({ data: [], total: 0, hasMore: false }),
        ...fabfilesOverrides,
      },
      dataLakes: { findById: vi.fn().mockResolvedValue(null) },
      adminSettings: { getSettingsValue: vi.fn().mockResolvedValue('text-embedding-3-large') },
    } as never,
    ...overrides,
  } as ToolContext;
}

const run = (context: ToolContext) =>
  describeKnowledgeBaseTool.implementation(context, undefined).toolFn({}) as Promise<string>;

beforeEach(() => {
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
    expect(out).toContain('Embedding model in use: text-embedding-3-large');
  });

  it('reads every data source through the SAME lake membership scope, not a hand-rolled predicate', async () => {
    const ctx = makeContext();
    await run(ctx);
    const fabfiles = ctx.db.fabfiles as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(fabfiles.computeDataLakeStats).toHaveBeenCalledWith(dynamicLake.membership);
    expect(fabfiles.countDataLakeTopicTags).toHaveBeenCalledWith(dynamicLake.membership, expect.any(Number));
    expect(fabfiles.findDataLakeHealthMembers).toHaveBeenCalledWith(dynamicLake.membership, expect.any(Number));
    expect(fabfiles.search).toHaveBeenCalledWith(
      'u1',
      '',
      {},
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        lakeMemberships: [dynamicLake.membership],
        restrictToDataLake: true,
        includeShared: true,
      })
    );
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

  it('derives pipeline health from raw member rows: chunked, fully vectorized, and failed', async () => {
    const health = [
      { chunkCount: 4, vectorizedChunkCount: 4, error: null },
      { chunkCount: 2, vectorizedChunkCount: 1, error: null }, // chunked, not fully vectorized
      { chunkCount: 0, vectorizedChunkCount: null, error: null }, // unchunked
      { chunkCount: 3, vectorizedChunkCount: null, error: 'extraction failed' }, // failed
    ];
    const ctx = makeContext({}, { findDataLakeHealthMembers: vi.fn().mockResolvedValue(health) });
    const out = await run(ctx);
    // 3 of the 4 rows carry chunkCount > 0 (the unchunked row does not); only the first is fully
    // vectorized; only the fourth carries an error.
    expect(out).toContain('3 chunked');
    expect(out).toContain('1 fully vectorized');
    expect(out).toContain('1 failed');
    expect(out).toContain('9 chunk(s) total');
  });

  it('derives folder structure from relativePath using the shared discriminator, not a truthy check', async () => {
    // 'readme.txt' with relativePath === fileName is a FLAT upload (the picker's fallback), not a
    // folder - the exact ambiguity folderKeyOf exists to resolve. 'docs/readme.txt' IS a folder.
    const files = [
      { fileName: 'readme.txt', relativePath: 'readme.txt' },
      { fileName: 'notes.md', relativePath: 'docs/notes.md' },
      { fileName: 'plan.md', relativePath: 'docs/plan.md' },
    ];
    const ctx = makeContext({}, { search: vi.fn().mockResolvedValue({ data: files, total: 3, hasMore: false }) });
    const out = await run(ctx);
    expect(out).toContain('docs (2)');
    expect(out).toContain('(no folder) (1)');
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
    expect(out).toContain('Embedding model in use: not configured');
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

  it('distinguishes the corpus total from what this turn retrieved', async () => {
    const out = await run(makeContext());
    expect(out).toContain('not what was retrieved this turn');
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
