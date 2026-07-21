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
  semanticDataLakeSearchMock.mockClear().mockResolvedValue({ results: [], totalChunksSearched: 0, filesInScope: 0 });
  fileScopedSemanticSearchMock.mockClear().mockResolvedValue({ results: [], totalChunksSearched: 0, filesInScope: 0 });
});

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
