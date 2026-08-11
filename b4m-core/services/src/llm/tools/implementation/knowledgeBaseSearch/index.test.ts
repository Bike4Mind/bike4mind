import { describe, it, expect, vi, beforeEach } from 'vitest';

// Keyword-fallback path calls getDynamicDataLakeAccess; stub it. Semantic path is forced to
// bail (no fabfilechunks/adminSettings/apiKeys on db), so these tests exercise the keyword arm.
const getDynamicDataLakeAccessMock = vi.fn().mockResolvedValue({
  dataLakeTags: [],
  dataLakeTagPrefixes: [],
  scopedTagPrefixes: [],
});
vi.mock('../../../../dataLakeService/getDynamicDataLakeTags', () => ({
  getDynamicDataLakeAccess: (...args: unknown[]) => getDynamicDataLakeAccessMock(...args),
}));

// Semantic entrypoints mocked so the scoped tests can assert WHICH arm the dispatch picked
// without standing up embeddings; both default to no-hit so the keyword arm runs after.
const semanticDataLakeSearchMock = vi.fn();
const fileScopedSemanticSearchMock = vi.fn();
vi.mock('../../../../dataLakeService/semanticDataLakeSearch', () => ({
  semanticDataLakeSearch: (...args: unknown[]) => semanticDataLakeSearchMock(...args),
  fileScopedSemanticSearch: (...args: unknown[]) => fileScopedSemanticSearchMock(...args),
}));

// Keep the utils barrel real except the tokenizer (avoids tiktoken init in unit tests).
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return { ...actual, createTokenizer: () => ({ countTokens: async () => 3 }) };
});

const getEffectiveLLMApiKeysMock = vi.fn().mockResolvedValue({ openai: 'k' });
vi.mock('../../../../apiKeyService', () => ({
  getEffectiveLLMApiKeys: (...args: unknown[]) => getEffectiveLLMApiKeysMock(...args),
}));

import { knowledgeBaseSearchTool } from './index';
import { emptyEmbeddingMismatchReport } from '../../../../dataLakeService/embeddingMismatch';
import type { ToolContext } from '../../base/types';

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: 'u1',
    user: { id: 'u1', groups: [] } as never,
    sessionId: 's1',
    logger,
    statusUpdate: vi.fn().mockResolvedValue(undefined),
    retrievalFilter: { excludeFilenameMarkers: ['MARK'], vectorizedOnly: true },
    db: {
      // Only fabfiles wired -> trySemanticKbSearch returns null (no chunk/adminSettings/apiKey
      // deps), so the keyword fallback runs.
      fabfiles: {
        search: vi.fn().mockResolvedValue({
          data: [
            { id: 'm', fileName: 'MARK - retired.pdf', tags: [], vectorized: true, mimeType: 'application/pdf' },
            { id: 'c', fileName: 'Clean retired notes.pdf', tags: [], vectorized: true, mimeType: 'application/pdf' },
          ],
          total: 2,
        }),
      },
    } as never,
    ...overrides,
  } as ToolContext;
}

async function run(context: ToolContext) {
  const tool = knowledgeBaseSearchTool.implementation(context, undefined);
  return tool.toolFn({ query: 'retired notes' }) as Promise<string>;
}

beforeEach(() => {
  getDynamicDataLakeAccessMock.mockClear();
  // Mirrors the real result shape: chunksScored/embeddingMismatch are required on the service's
  // return type, and these mocks are untyped, so omitting them surfaces only at runtime.
  semanticDataLakeSearchMock.mockClear().mockResolvedValue(emptySemanticResult());
  fileScopedSemanticSearchMock.mockClear().mockResolvedValue(emptySemanticResult());
});

const ADA = 'text-embedding-ada-002';
const SMALL_3 = 'text-embedding-3-small';

const emptySemanticResult = () => ({
  results: [],
  totalChunksSearched: 0,
  filesInScope: 0,
  chunksScored: 0,
  embeddingModel: ADA,
  embeddingMismatch: emptyEmbeddingMismatchReport(),
});

/** A report describing one file withheld for being embedded with another model. */
const mismatchReport = () => {
  const report = emptyEmbeddingMismatchReport();
  report.excludedFiles = {
    count: 1,
    models: [SMALL_3],
    estimatedChunks: 12,
    sample: [{ fileId: 'f9', fileName: 'foreign.md', embeddingModel: SMALL_3 }],
  };
  report.partial = true;
  return report;
};

describe('search_knowledge_base keyword fallback retrieval exclusion', () => {
  it('drops a marked file from keyword results but keeps the clean one', async () => {
    const out = await run(makeContext());
    expect(out).toContain('Clean retired notes.pdf');
    expect(out).not.toContain('MARK - retired.pdf');
  });

  it('forwards the exclusion options to the DB pre-filter', async () => {
    const ctx = makeContext();
    await run(ctx);
    const opts = (ctx.db.fabfiles!.search as ReturnType<typeof vi.fn>).mock.calls[0][5];
    expect(opts).toMatchObject({ excludeFilenameMarkers: ['MARK'], vectorizedOnly: true });
  });

  it('no filter (default): the marked file is returned unchanged (opt-in only)', async () => {
    const out = await run(makeContext({ retrievalFilter: undefined }));
    expect(out).toContain('MARK - retired.pdf');
    expect(out).toContain('Clean retired notes.pdf');
  });
});

/**
 * attachmentInlineNotice (#1163): a still-chunking attachment must not read as inaccessible when
 * its raw content is already inlined elsewhere in the prompt. Exercises the keyword-fallback path
 * (the same one every other test in this file drives via bare makeContext()).
 */
describe('search_knowledge_base attachmentInlineNotice for inlined attachments (#1163)', () => {
  it('zero hits + a FULLY inlined attachment: notes it may not be searchable yet but is already in the conversation', async () => {
    const ctx = makeContext({
      retrievalFilter: undefined,
      inlinedAttachmentIds: ['f1'],
      fullyInlinedAttachmentIds: ['f1'],
    });
    (ctx.db.fabfiles!.search as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [], total: 0 });

    const out = await run(ctx);

    // Hedged ("may") rather than asserted: deferral to retrieval is the exception, so most
    // inlined attachments here are ordinary, fully-searchable files where a zero-hit result
    // just means the query missed (#1163 review).
    expect(out).toContain('may not be indexed for search yet');
    expect(out).toContain('Their content was already included directly in the conversation above');
    expect(out).not.toContain('PART of their content');
  });

  it('zero hits + a PARTIALLY inlined attachment: does not claim the whole document is already above', async () => {
    // inlinedAttachmentIds without a matching fullyInlinedAttachmentIds entry: delivered as a
    // cosine excerpt or a truncated head (#1163 review, bot round 3 nit).
    const ctx = makeContext({ retrievalFilter: undefined, inlinedAttachmentIds: ['f1'] });
    (ctx.db.fabfiles!.search as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [], total: 0 });

    const out = await run(ctx);

    expect(out).toContain('may not be indexed for search yet');
    expect(out).toContain('PART of their content was already included directly in the conversation above');
    expect(out).not.toContain('Their content was already included');
  });

  it('zero hits + no inlinedAttachmentIds: baseline message with no added suffix (regression)', async () => {
    const ctx = makeContext({ retrievalFilter: undefined });
    (ctx.db.fabfiles!.search as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [], total: 0 });

    const out = await run(ctx);

    expect(out).toBe('No documents found matching your search query in your knowledge base.');
  });

  it('a hit that IS fully inlined: notes retrieve_knowledge_content is unnecessary for it', async () => {
    const ctx = makeContext({
      retrievalFilter: undefined,
      inlinedAttachmentIds: ['m'],
      fullyInlinedAttachmentIds: ['m'],
    });

    const out = await run(ctx);

    expect(out).toContain('"MARK - retired.pdf" are attached to this conversation');
    expect(out).toContain('do not need retrieve_knowledge_content');
  });

  it('a hit that is inlined but only PARTIALLY (excerpt/truncated head): does not claim retrieval is unneeded', async () => {
    // inlinedAttachmentIds without a matching fullyInlinedAttachmentIds entry: delivered as a
    // cosine excerpt or a truncated head, not the whole file (#1163 review).
    const ctx = makeContext({ retrievalFilter: undefined, inlinedAttachmentIds: ['m'] });

    const out = await run(ctx);

    expect(out).toContain('"MARK - retired.pdf" are attached to this conversation');
    expect(out).toContain('may still surface additional passages');
    expect(out).not.toContain('do not need retrieve_knowledge_content');
  });

  it('a hit that is NOT inlined: no note is appended', async () => {
    const ctx = makeContext({ retrievalFilter: undefined, inlinedAttachmentIds: ['not-a-match'] });

    const out = await run(ctx);

    expect(out).not.toContain('are attached to this conversation');
  });

  it('the empty-kbScope early return stays byte-identical even with inlinedAttachmentIds set', async () => {
    const ctx = makeContext({ retrievalFilter: undefined, kbScope: { fileIds: [] }, inlinedAttachmentIds: ['f1'] });

    const out = await run(ctx);

    expect(out).toBe('No documents found matching your search query in your knowledge base.');
    expect(ctx.db.fabfiles!.search).not.toHaveBeenCalled();
  });
});

describe('search_knowledge_base semantic fallback logging', () => {
  // fabfiles + fabfilechunks must both be wired to reach resolveEmbeddingContext at all -
  // trySemanticKbSearch bails (silently, no log) before that if either is missing.
  function makeSemanticContext(overrides: { adminSettings?: unknown; apiKeys?: unknown }): ToolContext {
    return makeContext({
      db: {
        fabfiles: { search: vi.fn().mockResolvedValue({ data: [], total: 0 }) },
        fabfilechunks: { findVectorsByFabFileIds: vi.fn().mockResolvedValue([]) },
        adminSettings: overrides.adminSettings,
        apiKeys: overrides.apiKeys,
      } as never,
    });
  }

  beforeEach(() => {
    (logger.warn as ReturnType<typeof vi.fn>).mockClear();
  });

  it('warns naming the missing adapter when adminSettings/apiKeys are not wired', async () => {
    await run(makeSemanticContext({}));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('adminSettings adapter not wired'));
  });

  it('warns that no defaultEmbeddingModel is configured when adapters are wired but the setting is unset', async () => {
    const context = makeSemanticContext({
      adminSettings: { getSettingsValue: vi.fn().mockResolvedValue(undefined) },
      apiKeys: {},
    });
    await run(context);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no defaultEmbeddingModel configured'));
  });

  it('warns naming the missing provider credential when the model is configured but keyless', async () => {
    getEffectiveLLMApiKeysMock.mockResolvedValueOnce({});
    const context = makeSemanticContext({
      adminSettings: { getSettingsValue: vi.fn().mockResolvedValue(ADA) },
      apiKeys: {},
    });
    await run(context);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no credential for provider'));
  });

  it('does not log a fallback warning when the embedding context resolves successfully', async () => {
    const context = makeSemanticContext({
      adminSettings: { getSettingsValue: vi.fn().mockResolvedValue(ADA) },
      apiKeys: {},
    });
    await run(context);
    const fallbackWarnings = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(call =>
      String(call[0]).includes('falling back to keyword search')
    );
    expect(fallbackWarnings).toHaveLength(0);
  });

  it('warns when fabfilechunks is not wired, before resolveEmbeddingContext ever runs', async () => {
    // The default makeContext() only wires fabfiles, not fabfilechunks - this is the earlier,
    // real-production-reachable gate trySemanticKbSearch checks before calling
    // resolveEmbeddingContext at all (unlike the type-guaranteed adminSettings/apiKeys check).
    await run(makeContext());
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('fabfiles/fabfilechunks not wired'));
  });
});

describe('search_knowledge_base agent kbScope enforcement', () => {
  // Context with full semantic deps so the scoped SEMANTIC arm engages (not just keyword).
  function makeScopedContext(fileIds: string[] | undefined, overrides: Partial<ToolContext> = {}): ToolContext {
    return makeContext({
      retrievalFilter: undefined,
      kbScope: fileIds === undefined ? undefined : { fileIds },
      db: {
        fabfiles: {
          search: vi.fn().mockResolvedValue({
            data: [{ id: 'a', fileName: 'Scoped doc.pdf', tags: [], vectorized: true, mimeType: 'application/pdf' }],
            total: 1,
          }),
        },
        fabfilechunks: { findVectorsByFabFileIds: vi.fn() },
        adminSettings: { getSettingsValue: vi.fn().mockResolvedValue('text-embedding-ada-002') },
        apiKeys: {},
        usageEvents: { record: vi.fn() },
      } as never,
      ...overrides,
    });
  }

  it('scoped: the semantic arm uses the file-scoped search, never owner-wide access', async () => {
    const ctx = makeScopedContext(['a', 'b']);
    await run(ctx);

    expect(fileScopedSemanticSearchMock).toHaveBeenCalledTimes(1);
    expect(fileScopedSemanticSearchMock.mock.calls[0][0]).toMatchObject({ fileIds: ['a', 'b'] });
    expect(semanticDataLakeSearchMock).not.toHaveBeenCalled();
    expect(getDynamicDataLakeAccessMock).not.toHaveBeenCalled();
  });

  it('scoped: the keyword arm restricts to the scope with no sharing or lake expansion', async () => {
    const ctx = makeScopedContext(['a', 'b']);
    await run(ctx);

    const searchMock = ctx.db.fabfiles!.search as ReturnType<typeof vi.fn>;
    expect(searchMock).toHaveBeenCalledTimes(1);
    const [, , filters, , , opts] = searchMock.mock.calls[0];
    expect(filters.restrictToFileIds).toEqual(['a', 'b']);
    expect(opts.includeShared).toBe(false);
    expect(opts.userGroups).toEqual([]);
    expect(opts.dataLakeTags).toBeUndefined();
    // Curated files match even when owned by another user - the scope is the authority.
    expect(opts.skipOwnership).toBe(true);
    expect(getDynamicDataLakeAccessMock).not.toHaveBeenCalled();
  });

  it('empty scope returns the generic no-results message without touching the DB or either arm', async () => {
    const ctx = makeScopedContext([]);
    const out = await run(ctx);

    expect(out).toContain('No documents found');
    expect(ctx.db.fabfiles!.search).not.toHaveBeenCalled();
    expect(fileScopedSemanticSearchMock).not.toHaveBeenCalled();
    expect(getDynamicDataLakeAccessMock).not.toHaveBeenCalled();
  });

  it('scoped no-hit status carries no data-lake framing', async () => {
    const ctx = makeScopedContext(['a']);
    (ctx.db.fabfiles!.search as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [], total: 0 });
    await run(ctx);

    const statusCalls = (ctx.statusUpdate as ReturnType<typeof vi.fn>).mock.calls.map(c => String(c[1]));
    expect(statusCalls.some(s => s.includes("this agent's knowledge base"))).toBe(true);
    expect(statusCalls.every(s => !s.includes('data lake') && !s.includes('data-lake'))).toBe(true);
  });

  it('unscoped regression: owner-wide access resolution still runs', async () => {
    const ctx = makeScopedContext(undefined);
    await run(ctx);

    expect(getDynamicDataLakeAccessMock).toHaveBeenCalled();
    expect(fileScopedSemanticSearchMock).not.toHaveBeenCalled();
    const [, , filters, , , opts] = (ctx.db.fabfiles!.search as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(filters.restrictToFileIds).toBeUndefined();
    expect(opts.includeShared).toBe(true);
  });
});

describe('search_knowledge_base partial-corpus disclosure', () => {
  const hit = {
    chunkId: 'c1',
    fileId: 'f1',
    fileName: 'Handbook.pdf',
    fileTags: [],
    chunkText: 'pto accrues monthly',
    score: 0.81,
  };
  const scanOf = (overrides: Record<string, unknown>) => ({
    truncated: false,
    fileBudgetHit: false,
    chunkBudgetHit: false,
    filesMatching: 3,
    filesScoped: 3,
    filesScanned: 3,
    chunksScanned: 9,
    chunksSkippedDimensionMismatch: 0,
    annFilesQueried: 0,
    annHits: 0,
    budgets: { maxFiles: 20000, maxChunks: 100000 },
    ...overrides,
  });

  // The unscoped semantic arm bails when no lake is accessible, so grant one.
  beforeEach(() => {
    getDynamicDataLakeAccessMock.mockResolvedValue({
      dataLakeTags: ['datalake:x'],
      dataLakeTagPrefixes: [],
      scopedTagPrefixes: [],
    });
  });

  /** Unlike makeContext, this wires every dep the semantic arm needs so it actually runs. */
  function semanticContext(overrides: Partial<ToolContext> = {}): ToolContext {
    return makeContext({
      retrievalFilter: undefined,
      db: {
        fabfiles: { search: vi.fn().mockResolvedValue({ data: [], total: 0 }), getAccessibleFiles: vi.fn() },
        fabfilechunks: { findVectorsByFabFileIds: vi.fn() },
        adminSettings: { getSettingsValue: vi.fn().mockResolvedValue('text-embedding-ada-002') },
        apiKeys: {},
        usageEvents: { record: vi.fn() },
      } as never,
      ...overrides,
    });
  }

  it('unscoped arm: a truncated scan warns the model not to claim the library holds nothing more', async () => {
    semanticDataLakeSearchMock.mockResolvedValue({
      results: [hit],
      totalChunksSearched: 100000,
      filesInScope: 2314,
      scan: scanOf({ truncated: true, chunkBudgetHit: true, filesScanned: 800, filesMatching: 2314 }),
    });

    const out = await run(semanticContext());

    expect(out).toContain('covered only 800 of 2314 documents');
    expect(out).toContain('Do not state or imply the knowledge base has nothing further');
    expect(out).toContain('pto accrues monthly');
  });

  it('unscoped arm: a complete scan produces no notice at all', async () => {
    semanticDataLakeSearchMock.mockResolvedValue({
      results: [hit],
      totalChunksSearched: 9,
      filesInScope: 3,
      scan: scanOf({}),
    });

    const out = await run(semanticContext());

    expect(out).not.toContain('covered only');
    expect(out).not.toContain('NOTE:');
  });

  it('scoped (agent kbScope) arm gets the same disclosure - neither surface may hide it', async () => {
    fileScopedSemanticSearchMock.mockResolvedValue({
      results: [hit],
      totalChunksSearched: 100000,
      filesInScope: 500,
      scan: scanOf({ truncated: true, fileBudgetHit: true, filesScanned: 200, filesMatching: 500 }),
    });

    const out = await run(semanticContext({ kbScope: { fileIds: ['f1'] } as never }));

    expect(fileScopedSemanticSearchMock).toHaveBeenCalled();
    expect(out).toContain('covered only 200 of 500 documents');
  });

  it('forwards the resolved scan budgets into the search', async () => {
    semanticDataLakeSearchMock.mockResolvedValue({
      results: [hit],
      totalChunksSearched: 9,
      filesInScope: 3,
      scan: scanOf({}),
    });

    await run(semanticContext());

    expect(semanticDataLakeSearchMock.mock.calls[0][0]).toHaveProperty('budgets');
  });
});

/**
 * Retrieval-scoped lake-prompt injection on the MODEL-DRIVEN path (#1108). When a semantic search
 * grounds on a trusted lake's files, that lake's operating instructions are prepended (defended) to
 * the tool result; when it grounds on nothing lake-owned, nothing is injected. The agent-scoped arm
 * never injects. Trust itself is covered by getDataLakePrompts.test.ts - here we lock the WIRING.
 */
describe('search_knowledge_base scoped lake-prompt injection (#1108)', () => {
  const lakeHit = (fileTags: string[]) => ({
    chunkId: 'c1',
    fileId: 'f1',
    fileName: 'Handbook.pdf',
    fileTags,
    chunkText: 'pto accrues monthly',
    score: 0.81,
  });
  const scan = {
    truncated: false,
    fileBudgetHit: false,
    chunkBudgetHit: false,
    filesMatching: 1,
    filesScoped: 1,
    filesScanned: 1,
    chunksScanned: 1,
    chunksSkippedDimensionMismatch: 0,
    budgets: { maxFiles: 20000, maxChunks: 100000 },
  };
  const makeLake = (overrides: Record<string, unknown> = {}) => ({
    id: 'lakeX',
    slug: 'x',
    name: 'Lake X',
    fileTagPrefix: 'x:',
    datalakeTag: 'datalake:x',
    createdByUserId: 'u1',
    status: 'active',
    systemPrompt: 'Prefer the 2026 revision.',
    ...overrides,
  });

  // Semantic deps wired AND db.dataLakes present so the real getAccessibleDataLakePrompts runs.
  function semCtx(lakes: Array<Record<string, unknown>>, overrides: Partial<ToolContext> = {}): ToolContext {
    return makeContext({
      retrievalFilter: undefined,
      db: {
        fabfiles: { search: vi.fn().mockResolvedValue({ data: [], total: 0 }), getAccessibleFiles: vi.fn() },
        fabfilechunks: { findVectorsByFabFileIds: vi.fn() },
        adminSettings: { getSettingsValue: vi.fn().mockResolvedValue('text-embedding-ada-002') },
        apiKeys: {},
        usageEvents: { record: vi.fn() },
        dataLakes: {
          findActiveByUserTags: vi.fn(),
          findActiveByUserTagsAndEntitlements: vi.fn().mockResolvedValue(lakes),
        },
      } as never,
      ...overrides,
    });
  }

  beforeEach(() => {
    getDynamicDataLakeAccessMock.mockResolvedValue({
      dataLakeTags: ['datalake:x'],
      dataLakeTagPrefixes: [],
      scopedTagPrefixes: [],
    });
  });

  it('prepends the retrieved lake prompt (defended) ahead of the passages', async () => {
    semanticDataLakeSearchMock.mockResolvedValue({ results: [lakeHit(['datalake:x'])], scan });
    const out = await run(semCtx([makeLake()]));
    expect(out).toContain('[Data Lake Instructions]');
    expect(out).toContain('[Data Lake - Lake X]\nPrefer the 2026 revision.');
    // The passage content still follows the injected prompt.
    expect(out).toContain('pto accrues monthly');
    expect(out.indexOf('[Data Lake - Lake X]')).toBeLessThan(out.indexOf('pto accrues monthly'));
  });

  it('#1163: appends the inlined-attachment note on the SEMANTIC arm too, not just the keyword fallback', async () => {
    // A lake-accessible user with a still-chunking attachment now un-short-circuits
    // userHasAccessibleKnowledgeLake (ChatCompletionProcess.ts), so this arm - not just the
    // keyword one - is exactly where such a user lands. Ground-truth review caught this arm
    // returning early with no notice at all.
    semanticDataLakeSearchMock.mockResolvedValue({ results: [lakeHit(['datalake:x'])], scan });
    const out = await run(semCtx([makeLake()], { inlinedAttachmentIds: ['f1'] }));
    expect(out).toContain('pto accrues monthly');
    expect(out).toContain('"Handbook.pdf"');
    expect(out).toContain('already included above');
  });

  it('#1163 (bot round 4 nit): names an inlined file once even when multiple ranked passages come from it', async () => {
    // rankedResults is per-PASSAGE, so a top-K hit can carry several chunks from the same file -
    // the notice must not repeat that file's name once per passage.
    semanticDataLakeSearchMock.mockResolvedValue({
      results: [
        lakeHit(['datalake:x']),
        { ...lakeHit(['datalake:x']), chunkId: 'c2', chunkText: 'sick leave accrues separately' },
      ],
      scan,
    });
    const out = await run(semCtx([makeLake()], { inlinedAttachmentIds: ['f1'] }));
    expect(out.split('"Handbook.pdf"').length - 1).toBe(1);
  });

  it('injects nothing when the grounded files carry no lake tag', async () => {
    semanticDataLakeSearchMock.mockResolvedValue({ results: [lakeHit([])], scan });
    const out = await run(semCtx([makeLake()]));
    expect(out).not.toContain('[Data Lake -');
    expect(out).toContain('pto accrues monthly');
  });

  it('dedupes across repeated searches: the same lake is injected once per completion', async () => {
    semanticDataLakeSearchMock.mockResolvedValue({ results: [lakeHit(['datalake:x'])], scan });
    // One tool instance = one completion, so its closure carries the injected-tags set.
    const tool = knowledgeBaseSearchTool.implementation(semCtx([makeLake()]), undefined);
    const first = (await tool.toolFn({ query: 'pto' })) as string;
    const second = (await tool.toolFn({ query: 'pto again' })) as string;
    expect(first).toContain('[Data Lake - Lake X]');
    expect(second).not.toContain('[Data Lake - Lake X]');
    // The second search still returns its passages - only the repeated prompt is suppressed.
    expect(second).toContain('pto accrues monthly');
  });

  it('agent-scoped arm never injects a lake prompt, even when results carry lake tags', async () => {
    fileScopedSemanticSearchMock.mockResolvedValue({ results: [lakeHit(['datalake:x'])], scan });
    const out = await run(semCtx([makeLake()], { kbScope: { fileIds: ['f1'] } as never }));
    expect(fileScopedSemanticSearchMock).toHaveBeenCalled();
    expect(out).not.toContain('[Data Lake -');
    expect(out).toContain('pto accrues monthly');
  });

  it('marks a retrieved no-prompt lake as injected so a later search does not re-resolve it', async () => {
    // The lake resolves to no block (empty systemPrompt), but its tag is still marked injected up
    // front - so a second search over the same lake short-circuits before hitting the DB again.
    semanticDataLakeSearchMock.mockResolvedValue({ results: [lakeHit(['datalake:x'])], scan });
    const ctx = semCtx([makeLake({ systemPrompt: '' })]);
    const findMock = (ctx.db.dataLakes as { findActiveByUserTagsAndEntitlements: ReturnType<typeof vi.fn> })
      .findActiveByUserTagsAndEntitlements;
    const tool = knowledgeBaseSearchTool.implementation(ctx, undefined);
    const first = (await tool.toolFn({ query: 'a' })) as string;
    await tool.toolFn({ query: 'b' });
    expect(first).not.toContain('[Data Lake -'); // empty prompt -> nothing injected
    expect(findMock).toHaveBeenCalledTimes(1); // second search never re-resolved the lake
  });
});

describe('search_knowledge_base embedding-mismatch disclosure', () => {
  // Distinct from the truncated-scan disclosure above: that says how much of the corpus was
  // REACHED, this says whether what was reached could be COMPARED. Both can be true at once.
  function makeSemanticContext(overrides: Partial<ToolContext> = {}): ToolContext {
    return makeContext({
      retrievalFilter: undefined,
      db: {
        fabfiles: {
          search: vi.fn().mockResolvedValue({
            data: [{ id: 'k', fileName: 'Keyword doc.pdf', tags: [], vectorized: true, mimeType: 'application/pdf' }],
            total: 1,
          }),
        },
        fabfilechunks: { findVectorsByFabFileIds: vi.fn() },
        adminSettings: { getSettingsValue: vi.fn().mockResolvedValue(ADA) },
        apiKeys: {},
        usageEvents: { record: vi.fn() },
      } as never,
      ...overrides,
    });
  }

  beforeEach(() => {
    getDynamicDataLakeAccessMock.mockResolvedValue({
      dataLakeTags: ['datalake:x'],
      dataLakeTagPrefixes: [],
      scopedTagPrefixes: [],
    });
  });

  it('tells the MODEL about withheld content, in the string it actually receives', async () => {
    semanticDataLakeSearchMock.mockResolvedValue({
      ...emptySemanticResult(),
      results: [{ chunkId: 'c1', fileId: 'f1', fileName: 'a.md', fileTags: [], chunkText: 'body', score: 0.8 }],
      embeddingMismatch: mismatchReport(),
    });

    const out = await run(makeSemanticContext());

    expect(out).toContain('body');
    expect(out).toContain(SMALL_3);
    expect(out).toContain('partial');
  });

  it('says nothing extra when the corpus is consistent', async () => {
    semanticDataLakeSearchMock.mockResolvedValue({
      ...emptySemanticResult(),
      results: [{ chunkId: 'c1', fileId: 'f1', fileName: 'a.md', fileTags: [], chunkText: 'body', score: 0.8 }],
    });

    const out = await run(makeSemanticContext());

    expect(out).toContain('body');
    expect(out).not.toContain('partial');
  });

  it('carries the notice through the keyword fall-through when everything was withheld', async () => {
    // The worst case: no semantic hits BECAUSE every matching file was excluded. The arm has no
    // output, keyword search answers instead, and the notice has to survive that hand-off - on
    // BOTH channels: the model's tool string AND the human-visible status/promptMeta write, which
    // previously only ran inside emitSemanticCitables (never reached when semantic found nothing).
    semanticDataLakeSearchMock.mockResolvedValue({
      ...emptySemanticResult(),
      results: [],
      embeddingMismatch: mismatchReport(),
    });

    const ctx = makeSemanticContext();
    const out = await run(ctx);

    expect(ctx.db.fabfiles!.search).toHaveBeenCalledTimes(1);
    expect(out).toContain('Keyword doc.pdf');
    expect(out).toContain(SMALL_3);
    const calls = (ctx.statusUpdate as ReturnType<typeof vi.fn>).mock.calls;
    const withWarning = calls.find(c => (c[0] as { promptMeta?: { warnings?: string[] } })?.promptMeta?.warnings);
    expect(withWarning).toBeDefined();
    expect((withWarning![0] as { promptMeta: { warnings: string[] } }).promptMeta.warnings[0]).toContain(SMALL_3);
    expect(withWarning![1]).toContain('partial results');
  });

  it('surfaces the notice on the status line even when keyword search ALSO finds nothing', async () => {
    semanticDataLakeSearchMock.mockResolvedValue({
      ...emptySemanticResult(),
      results: [],
      embeddingMismatch: mismatchReport(),
    });
    const ctx = makeSemanticContext({
      db: {
        fabfiles: { search: vi.fn().mockResolvedValue({ data: [], total: 0 }) },
        fabfilechunks: { findVectorsByFabFileIds: vi.fn() },
        adminSettings: { getSettingsValue: vi.fn().mockResolvedValue(ADA) },
        apiKeys: {},
        usageEvents: { record: vi.fn() },
      } as never,
    });

    const out = await run(ctx);

    expect(out).toContain(SMALL_3);
    const calls = (ctx.statusUpdate as ReturnType<typeof vi.fn>).mock.calls;
    const withWarning = calls.find(c => (c[0] as { promptMeta?: { warnings?: string[] } })?.promptMeta?.warnings);
    expect(withWarning).toBeDefined();
    expect(withWarning![1]).toContain('partial results');
  });

  it('does not invent a notice when the semantic arm throws', async () => {
    semanticDataLakeSearchMock.mockRejectedValue(new Error('embedding provider down'));

    const out = await run(makeSemanticContext());

    expect(out).toContain('Keyword doc.pdf');
    expect(out).not.toContain('partial');
  });

  it('repeats the last notice on the capped call, which runs no search of its own', async () => {
    semanticDataLakeSearchMock.mockResolvedValue({
      ...emptySemanticResult(),
      results: [{ chunkId: 'c1', fileId: 'f1', fileName: 'a.md', fileTags: [], chunkText: 'body', score: 0.8 }],
      embeddingMismatch: mismatchReport(),
    });
    const ctx = makeSemanticContext();
    const tool = knowledgeBaseSearchTool.implementation(ctx, undefined);
    for (let i = 0; i < 3; i++) {
      await tool.toolFn({ query: 'q' });
    }
    // The 4th call is capped: no search runs, so without carrying the notice forward it would be
    // silently dropped from the model's view even though the corpus is still mid-migration.
    const capped = await tool.toolFn({ query: 'q' });
    expect(capped).toContain('STOP searching');
    expect(capped).toContain(SMALL_3);
  });

  it('accretes the warning onto promptMeta alongside the citables', async () => {
    semanticDataLakeSearchMock.mockResolvedValue({
      ...emptySemanticResult(),
      results: [{ chunkId: 'c1', fileId: 'f1', fileName: 'a.md', fileTags: [], chunkText: 'body', score: 0.8 }],
      embeddingMismatch: mismatchReport(),
    });

    const ctx = makeSemanticContext();
    await run(ctx);

    const calls = (ctx.statusUpdate as ReturnType<typeof vi.fn>).mock.calls;
    const withWarning = calls.find(c => (c[0] as { promptMeta?: { warnings?: string[] } })?.promptMeta?.warnings);
    expect(withWarning).toBeDefined();
    expect((withWarning![0] as { promptMeta: { warnings: string[] } }).promptMeta.warnings[0]).toContain(SMALL_3);
  });
});
