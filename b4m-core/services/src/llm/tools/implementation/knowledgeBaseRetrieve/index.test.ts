import { describe, it, expect, vi, beforeEach } from 'vitest';

// Path A (direct file_id) bypasses fabfiles.search, so the query-builder exclusion never runs
// on it. getDynamicDataLakeAccess is only reached on the shared branch AFTER the in-memory guard;
// stub it so these tests exercise the guard, not lake resolution.
const getDynamicDataLakeAccessMock = vi.fn().mockResolvedValue({
  dataLakeTags: [],
  dataLakeTagPrefixes: [],
  scopedTagPrefixes: [],
});
vi.mock('../../../../dataLakeService/getDynamicDataLakeTags', () => ({
  getDynamicDataLakeAccess: (...args: unknown[]) => getDynamicDataLakeAccessMock(...args),
}));

import { knowledgeBaseRetrieveTool } from './index';
import type { ToolContext } from '../../base/types';

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() } as never;

const FILE_ID = 'file-1';

function makeFile(overrides: Record<string, unknown> = {}) {
  return {
    id: FILE_ID,
    fileName: 'MARK - Retired Protocol.pdf',
    vectorized: true,
    deletedAt: null,
    archivedAt: null,
    tags: [],
    users: [],
    groups: [],
    ...overrides,
  };
}

/**
 * Keyset-paging stand-in for the chunk text reader, implementing the REAL cursor arithmetic. A mock
 * that returns a canned page per call cannot observe a wrong cursor, which is the defect paging
 * introduces.
 */
function pagedTextChunkRepo(rows: Array<{ id: string; text: string }>) {
  return {
    findTextsByFabFileId: vi.fn(async (_id: string, opts?: { limit?: number; afterChunkId?: string }) =>
      rows
        .filter(r => (opts?.afterChunkId ? r.id > opts.afterChunkId : true))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, opts?.limit ?? rows.length)
        .map(r => ({ id: r.id, text: r.text }))
    ),
    countByFabFileId: vi.fn(async () => rows.length),
  };
}

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: 'u1',
    user: { id: 'u1', groups: [] } as never,
    sessionId: 's1',
    logger,
    statusUpdate: vi.fn().mockResolvedValue(undefined),
    retrievalFilter: { excludeFilenameMarkers: ['MARK'], vectorizedOnly: true },
    db: {
      fabfiles: {
        findByIdAndUserId: vi.fn(),
        findById: vi.fn(),
        search: vi.fn(),
      },
      fabfilechunks: pagedTextChunkRepo([{ id: 'c1', text: 'chunk body' }]),
    } as never,
    ...overrides,
  } as ToolContext;
}

async function runById(context: ToolContext) {
  const tool = knowledgeBaseRetrieveTool.implementation(context, undefined);
  return tool.toolFn({ file_id: FILE_ID }) as Promise<string>;
}

beforeEach(() => {
  getDynamicDataLakeAccessMock.mockClear();
});

describe('retrieve_knowledge_content — by-id (Path A) retrieval exclusion', () => {
  it('OWNED branch: a MARK file is treated as not-found (leaks no existence) and no chunks are read', async () => {
    const ctx = makeContext();
    (ctx.db.fabfiles!.findByIdAndUserId as ReturnType<typeof vi.fn>).mockResolvedValue(makeFile());

    const out = await runById(ctx);

    expect(out).toContain(`No document found with ID "${FILE_ID}"`);
    expect(ctx.db.fabfilechunks!.findTextsByFabFileId).not.toHaveBeenCalled();
  });

  it('OWNED branch: an allowed (clean, vectorized) file IS retrieved', async () => {
    const ctx = makeContext();
    (ctx.db.fabfiles!.findByIdAndUserId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFile({ fileName: 'Current Protocol.pdf' })
    );

    const out = await runById(ctx);

    expect(out).toContain('Retrieved content from');
    expect(out).toContain('chunk body');
  });

  it('OWNED branch: an unvectorized file is excluded when vectorizedOnly is set', async () => {
    const ctx = makeContext();
    (ctx.db.fabfiles!.findByIdAndUserId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFile({ fileName: 'Current Protocol.pdf', vectorized: false })
    );

    const out = await runById(ctx);
    expect(out).toContain(`No document found with ID "${FILE_ID}"`);
  });

  it('SHARED branch: a MARK file the user could otherwise access is still excluded', async () => {
    const ctx = makeContext();
    (ctx.db.fabfiles!.findByIdAndUserId as ReturnType<typeof vi.fn>).mockResolvedValue(null); // not owned
    (ctx.db.fabfiles!.findById as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFile({ users: [{ userId: 'u1', permissions: ['read'] }] }) // share access WOULD be granted
    );

    const out = await runById(ctx);

    expect(out).toContain(`No document found with ID "${FILE_ID}"`);
    // Guard short-circuits the if-condition before lake resolution / chunk read.
    expect(ctx.db.fabfilechunks!.findTextsByFabFileId).not.toHaveBeenCalled();
  });

  it('SHARED branch: a clean shared file IS retrieved', async () => {
    const ctx = makeContext();
    (ctx.db.fabfiles!.findByIdAndUserId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (ctx.db.fabfiles!.findById as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFile({ fileName: 'Shared Guide.pdf', users: [{ userId: 'u1', permissions: ['read'] }] })
    );

    const out = await runById(ctx);
    expect(out).toContain('Retrieved content from');
  });

  it('no filter set: a MARK file is retrieved unchanged (opt-in only)', async () => {
    const ctx = makeContext({ retrievalFilter: undefined });
    (ctx.db.fabfiles!.findByIdAndUserId as ReturnType<typeof vi.fn>).mockResolvedValue(makeFile());

    const out = await runById(ctx);
    expect(out).toContain('Retrieved content from');
  });

  it('QUERY/TAG path (Path B): a marked file from search results is excluded, clean file kept', async () => {
    const ctx = makeContext();
    (ctx.db.fabfiles!.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [makeFile({ id: 'm', fileName: 'MARK - retired.pdf' }), makeFile({ id: 'c', fileName: 'Clean Guide.pdf' })],
    });

    // No file_id -> Path B (tag/query search). getDynamicDataLakeAccess is stubbed above.
    const tool = knowledgeBaseRetrieveTool.implementation(ctx, undefined);
    const out = (await tool.toolFn({ query: 'retired guide' })) as string;

    expect(out).toContain('Clean Guide.pdf');
    expect(out).not.toContain('MARK - retired.pdf');
  });
});

describe('retrieve_knowledge_content agent kbScope enforcement', () => {
  function makeScopedContext(fileIds: string[], overrides: Partial<ToolContext> = {}): ToolContext {
    return makeContext({ retrievalFilter: undefined, kbScope: { fileIds }, ...overrides });
  }

  it('out-of-scope file_id is rejected BEFORE any DB lookup and leaks nothing', async () => {
    const ctx = makeScopedContext(['some-other-file']);

    const out = await runById(ctx);

    expect(out).toContain(`No document found with ID "${FILE_ID}"`);
    expect(ctx.db.fabfiles!.findById).not.toHaveBeenCalled();
    expect(ctx.db.fabfiles!.findByIdAndUserId).not.toHaveBeenCalled();
    expect(getDynamicDataLakeAccessMock).not.toHaveBeenCalled();
  });

  it('in-scope file_id is retrieved directly - membership is the authorization', async () => {
    const ctx = makeScopedContext([FILE_ID]);
    (ctx.db.fabfiles!.findById as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFile({ fileName: 'Curated Doc.pdf' })
    );

    const out = await runById(ctx);

    expect(out).toContain('Retrieved content from');
    expect(out).toContain('chunk body');
    expect(ctx.db.fabfiles!.findByIdAndUserId).not.toHaveBeenCalled();
    expect(getDynamicDataLakeAccessMock).not.toHaveBeenCalled();
  });

  it('a missing in-scope file returns the SAME message as an out-of-scope id (no existence oracle)', async () => {
    const inScopeMissing = makeScopedContext([FILE_ID]);
    (inScopeMissing.db.fabfiles!.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const outMissing = await runById(inScopeMissing);

    const outOfScope = makeScopedContext(['some-other-file']);
    const outForbidden = await runById(outOfScope);

    expect(outMissing).toBe(outForbidden);
  });

  it('an archived in-scope file reads as not-found', async () => {
    const ctx = makeScopedContext([FILE_ID]);
    (ctx.db.fabfiles!.findById as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFile({ fileName: 'Curated Doc.pdf', archivedAt: new Date() })
    );

    const out = await runById(ctx);
    expect(out).toContain(`No document found with ID "${FILE_ID}"`);
  });

  it('the retrieval-exclusion guard still applies to an in-scope file', async () => {
    const ctx = makeScopedContext([FILE_ID], {
      retrievalFilter: { excludeFilenameMarkers: ['MARK'], vectorizedOnly: true },
    });
    (ctx.db.fabfiles!.findById as ReturnType<typeof vi.fn>).mockResolvedValue(makeFile());

    const out = await runById(ctx);
    expect(out).toContain(`No document found with ID "${FILE_ID}"`);
  });

  it('empty scope: file_id request reads nothing and touches no DB', async () => {
    const ctx = makeScopedContext([]);

    const out = await runById(ctx);

    expect(out).toContain(`No document found with ID "${FILE_ID}"`);
    expect(ctx.db.fabfiles!.findById).not.toHaveBeenCalled();
    expect(ctx.db.fabfiles!.findByIdAndUserId).not.toHaveBeenCalled();
    expect(ctx.db.fabfiles!.search).not.toHaveBeenCalled();
  });

  it('empty scope: query request returns the generic no-documents message without searching', async () => {
    const ctx = makeScopedContext([]);
    const tool = knowledgeBaseRetrieveTool.implementation(ctx, undefined);

    const out = (await tool.toolFn({ query: 'anything' })) as string;

    expect(out).toContain('No documents found');
    expect(ctx.db.fabfiles!.search).not.toHaveBeenCalled();
  });

  it('scoped Path B search restricts to the scope with no sharing or lake expansion', async () => {
    const ctx = makeScopedContext(['a', 'b']);
    (ctx.db.fabfiles!.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [makeFile({ id: 'a', fileName: 'Scoped Guide.pdf' })],
    });
    const tool = knowledgeBaseRetrieveTool.implementation(ctx, undefined);

    const out = (await tool.toolFn({ query: 'guide' })) as string;

    expect(out).toContain('Scoped Guide.pdf');
    const [, , filters, , , opts] = (ctx.db.fabfiles!.search as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(filters.restrictToFileIds).toEqual(['a', 'b']);
    expect(opts.includeShared).toBe(false);
    expect(opts.userGroups).toEqual([]);
    expect(opts.dataLakeTags).toBeUndefined();
    // Curated files match even when owned by another user - the scope is the authority.
    expect(opts.skipOwnership).toBe(true);
    expect(getDynamicDataLakeAccessMock).not.toHaveBeenCalled();
  });

  it('unscoped regression: the shared branch still resolves owner-wide lake access', async () => {
    const ctx = makeContext({ retrievalFilter: undefined });
    (ctx.db.fabfiles!.findByIdAndUserId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (ctx.db.fabfiles!.findById as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFile({ fileName: 'Shared Guide.pdf', users: [{ userId: 'u1', permissions: ['read'] }] })
    );

    const out = await runById(ctx);

    expect(out).toContain('Retrieved content from');
    expect(getDynamicDataLakeAccessMock).toHaveBeenCalled();
  });
});

/**
 * Retrieval-scoped lake-prompt injection (#1108). Retrieving a trusted lake's CONTENT prepends that
 * lake's operating instructions (defended); the agent-scoped branch never does. This is the
 * keyword-fallback deployments' grounding surface - search returns metadata there, content enters
 * here. Trust is covered by getDataLakePrompts.test.ts; here we lock the WIRING.
 */
describe('retrieve_knowledge_content scoped lake-prompt injection (#1108)', () => {
  const lake = {
    id: 'lakeX',
    slug: 'x',
    name: 'Lake X',
    fileTagPrefix: 'x:',
    datalakeTag: 'datalake:x',
    createdByUserId: 'u1',
    status: 'active',
    systemPrompt: 'Prefer the 2026 revision.',
  };

  function lakeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return makeContext({
      retrievalFilter: undefined,
      db: {
        fabfiles: {
          findByIdAndUserId: vi
            .fn()
            .mockResolvedValue(makeFile({ fileName: 'Doc.pdf', tags: [{ name: 'datalake:x' }] })),
          findById: vi.fn().mockResolvedValue(makeFile({ fileName: 'Doc.pdf', tags: [{ name: 'datalake:x' }] })),
          search: vi.fn(),
        },
        fabfilechunks: pagedTextChunkRepo([{ id: 'c1', text: 'chunk body' }]),
        dataLakes: {
          findActiveByUserTags: vi.fn(),
          findActiveByUserTagsAndEntitlements: vi.fn().mockResolvedValue([lake]),
        },
      } as never,
      ...overrides,
    });
  }

  it('unscoped: prepends the retrieved lake prompt ahead of the document content', async () => {
    const out = await runById(lakeCtx());
    expect(out).toContain('[Data Lake Instructions]');
    expect(out).toContain('[Data Lake - Lake X]\nPrefer the 2026 revision.');
    expect(out).toContain('chunk body');
    expect(out.indexOf('[Data Lake - Lake X]')).toBeLessThan(out.indexOf('Retrieved content from'));
  });

  it('agent-scoped: never injects a lake prompt, even for a lake-tagged file', async () => {
    const ctx = lakeCtx({ kbScope: { fileIds: [FILE_ID] } as never });
    const out = await knowledgeBaseRetrieveTool.implementation(ctx, undefined).toolFn({ file_id: FILE_ID });
    expect(out).not.toContain('[Data Lake -');
    expect(out).toContain('chunk body');
  });

  it('dedupes across repeated retrieves: the same lake is injected once per completion', async () => {
    // One tool instance = one completion; its injectedLakeTags closure must survive across calls
    // (MAX_RETRIEVES allows two). A per-call set would re-inject the prompt on the second retrieve.
    const tool = knowledgeBaseRetrieveTool.implementation(lakeCtx(), undefined);
    const first = (await tool.toolFn({ file_id: FILE_ID })) as string;
    const second = (await tool.toolFn({ file_id: FILE_ID })) as string;
    expect(first).toContain('[Data Lake - Lake X]');
    expect(second).not.toContain('[Data Lake - Lake X]');
    expect(second).toContain('chunk body');
  });
});

// Org Groups Phase 2b (#1174): exercise the dormant `user.groups` consumer in the by-id
// (Path A) in-memory access guard with a NON-empty array. A file is group-accessible only
// when the user is a member of a group whose entry on the file grants read or write - the
// same per-entry semantics the $elemMatch query enforces, checked here in memory.
describe('retrieve_knowledge_content - group-shared access (Path A)', () => {
  type GroupShare = { groupId: string; permissions: string[] };
  const sharedFileCtx = (userGroups: string[], fileGroups: GroupShare[]) => {
    const ctx = makeContext({ retrievalFilter: undefined, user: { id: 'u1', groups: userGroups } as never });
    (ctx.db.fabfiles!.findByIdAndUserId as ReturnType<typeof vi.fn>).mockResolvedValue(null); // not owned
    (ctx.db.fabfiles!.findById as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFile({ fileName: 'Group Shared.pdf', groups: fileGroups })
    );
    return ctx;
  };

  it('a member of a group granted read retrieves the file', async () => {
    const out = await runById(sharedFileCtx(['g1'], [{ groupId: 'g1', permissions: ['read'] }]));
    expect(out).toContain('Retrieved content from');
  });

  it('a member of a group granted write also retrieves the file', async () => {
    const out = await runById(sharedFileCtx(['g1'], [{ groupId: 'g1', permissions: ['write'] }]));
    expect(out).toContain('Retrieved content from');
  });

  it('a non-member is denied (reads as not-found)', async () => {
    const out = await runById(sharedFileCtx(['g-other'], [{ groupId: 'g1', permissions: ['read'] }]));
    expect(out).toContain(`No document found with ID "${FILE_ID}"`);
  });

  it('a member whose group grants neither read nor write is denied', async () => {
    const out = await runById(sharedFileCtx(['g1'], [{ groupId: 'g1', permissions: ['share'] }]));
    expect(out).toContain(`No document found with ID "${FILE_ID}"`);
  });

  // g1 (the user's group) grants only `share`; `read` is granted to g2, which the user is
  // NOT in. The per-entry `.some()` must not combine them into a grant.
  it('does not leak read granted to a different group (no cross-entry match)', async () => {
    const out = await runById(
      sharedFileCtx(
        ['g1'],
        [
          { groupId: 'g1', permissions: ['share'] },
          { groupId: 'g2', permissions: ['read'] },
        ]
      )
    );
    expect(out).toContain(`No document found with ID "${FILE_ID}"`);
  });

  it('a user with no groups is denied (empty array is the prod no-op)', async () => {
    const out = await runById(sharedFileCtx([], [{ groupId: 'g1', permissions: ['read'] }]));
    expect(out).toContain(`No document found with ID "${FILE_ID}"`);
  });
});

/**
 * The chunk read is paged and stops at the file's share of the char budget. Before this it read every
 * chunk of the file and then sliced, hydrating a whole document to throw most of it away.
 */
describe('retrieve_knowledge_content bounds its chunk read', () => {
  const bigChunks = (count: number, charsEach: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `chunk-${String(i).padStart(6, '0')}`,
      text: `C${i}-`.padEnd(charsEach, 'x'),
    }));

  const ctxWithChunks = (rows: Array<{ id: string; text: string }>) => {
    const ctx = makeContext({ retrievalFilter: {} });
    (ctx.db as { fabfilechunks: unknown }).fabfilechunks = pagedTextChunkRepo(rows);
    (ctx.db.fabfiles!.findByIdAndUserId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFile({ fileName: 'Handbook.pdf' })
    );
    return ctx;
  };

  it('stops paging once the character budget is met', async () => {
    // 400 chunks of 100 chars against the 8000-char default: the walk must not drain the file.
    const ctx = ctxWithChunks(bigChunks(400, 100));

    const out = await runById(ctx);

    const reader = (ctx.db.fabfilechunks as { findTextsByFabFileId: ReturnType<typeof vi.fn> }).findTextsByFabFileId;
    const rowsRead = reader.mock.calls.length * 50;
    expect(rowsRead).toBeLessThan(400);
    expect(out).toContain('C0-');
  });

  it('advances the cursor across pages instead of re-reading the first', async () => {
    const ctx = ctxWithChunks(bigChunks(120, 100));

    await runById(ctx);

    const reader = (ctx.db.fabfilechunks as { findTextsByFabFileId: ReturnType<typeof vi.fn> }).findTextsByFabFileId;
    const cursors = reader.mock.calls.map(c => c[1]?.afterChunkId);
    expect(cursors[0]).toBeUndefined();
    expect(new Set(cursors).size).toBe(cursors.length);
  });

  it('reports the FILE chunk count, not the number it happened to read', async () => {
    // Reporting chunks-read as "Chunks" would tell the model a partial file was the whole one.
    const ctx = ctxWithChunks(bigChunks(400, 100));

    const out = await runById(ctx);

    expect(out).toMatch(/Chunks: 400 \(\d+ read\)/);
    expect(out).toContain('truncated at budget');
  });

  it('reports a bare count and no truncation when the whole file fits', async () => {
    // Healthy path: a warning or a hedge that fires here is one nobody reads.
    const ctx = ctxWithChunks(bigChunks(3, 100));

    const out = await runById(ctx);

    expect(out).toContain('Chunks: 3 |');
    expect(out).not.toContain('read)');
    expect(out).not.toContain('truncated at budget');
  });

  it('refuses a context whose chunk repository lacks the paged reader', async () => {
    // Guard the methods, not the repository: a truthiness check passes a partial adapter straight
    // through to a TypeError mid-retrieval.
    const ctx = makeContext({ retrievalFilter: {} });
    (ctx.db as { fabfilechunks: unknown }).fabfilechunks = { findByFabFileId: vi.fn() };

    const out = await runById(ctx);

    expect(out).toContain('chunk reader unavailable');
  });
});

/**
 * Zero-chunk replies point at content already inlined in the prompt (#1163) instead of implying
 * the file is unreachable, but only for files the caller actually inlined this turn
 * (context.inlinedAttachmentIds) - a lake doc genuinely still indexing is not inline anywhere, so
 * claiming otherwise would be false.
 */
describe('retrieve_knowledge_content zero-chunk wording for inlined attachments (#1163)', () => {
  const zeroChunkRepo = () => pagedTextChunkRepo([]);

  it('a zero-chunk file that IS inlined points the model at the already-provided content', async () => {
    const ctx = makeContext({ retrievalFilter: undefined, inlinedAttachmentIds: [FILE_ID] });
    (ctx.db as { fabfilechunks: unknown }).fabfilechunks = zeroChunkRepo();
    (ctx.db.fabfiles!.findByIdAndUserId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFile({ fileName: 'Report.pdf' })
    );

    const out = await runById(ctx);

    expect(out).toContain('"Report.pdf"');
    expect(out).toContain('already provided earlier in this conversation');
    expect(out).not.toContain('may not have been processed');
    expect(out).not.toContain('no indexed content');
  });

  it('a zero-chunk file NOT in inlinedAttachmentIds keeps the honest still-indexing wording', async () => {
    const ctx = makeContext({ retrievalFilter: undefined }); // inlinedAttachmentIds omitted entirely
    (ctx.db as { fabfilechunks: unknown }).fabfilechunks = zeroChunkRepo();
    (ctx.db.fabfiles!.findByIdAndUserId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFile({ fileName: 'Report.pdf' })
    );

    const out = await runById(ctx);

    expect(out).toContain('indexing may still be in progress');
    expect(out).not.toContain('already provided earlier in this conversation');
  });

  it('two zero-chunk matches: only the inlined one is named as already-available', async () => {
    const ctx = makeContext({ retrievalFilter: undefined, inlinedAttachmentIds: ['inlined-file'] });
    (ctx.db as { fabfilechunks: unknown }).fabfilechunks = zeroChunkRepo();
    (ctx.db.fabfiles!.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        makeFile({ id: 'inlined-file', fileName: 'Inlined.pdf' }),
        makeFile({ id: 'deferred-file', fileName: 'Deferred.pdf' }),
      ],
    });

    const tool = knowledgeBaseRetrieveTool.implementation(ctx, undefined);
    const out = (await tool.toolFn({ query: 'q' })) as string;

    expect(out).toContain('"Inlined.pdf"');
    expect(out).not.toContain('Deferred.pdf');
  });

  it('a metadata-search miss (Path B) also points at an inlined attachment, not just a zero-chunk match', async () => {
    // Ground-truth catch: a freshly-attached file whose name/tags/notes do not match the query
    // never reaches the zero-chunk branch at all - it fails the metadata search itself.
    const ctx = makeContext({ retrievalFilter: undefined, inlinedAttachmentIds: ['f1'] });
    (ctx.db.fabfiles!.search as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [] });

    const tool = knowledgeBaseRetrieveTool.implementation(ctx, undefined);
    const out = (await tool.toolFn({ query: 'unrelated phrase' })) as string;

    expect(out).toContain('No documents found matching');
    expect(out).toContain('already included directly in the conversation above');
  });

  it('a metadata-search miss with no inlined attachments is unchanged', async () => {
    const ctx = makeContext({ retrievalFilter: undefined }); // inlinedAttachmentIds omitted
    (ctx.db.fabfiles!.search as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [] });

    const tool = knowledgeBaseRetrieveTool.implementation(ctx, undefined);
    const out = (await tool.toolFn({ query: 'unrelated phrase' })) as string;

    expect(out).toBe(
      'No documents found matching query "unrelated phrase". Try broadening your search with search_knowledge_base.'
    );
  });

  it('regression: a file with at least one real chunk is unaffected by the zero-chunk wording', async () => {
    const ctx = makeContext({ retrievalFilter: undefined, inlinedAttachmentIds: [FILE_ID] });
    (ctx.db as { fabfilechunks: unknown }).fabfilechunks = pagedTextChunkRepo([
      { id: 'c1', text: 'real content body' },
    ]);
    (ctx.db.fabfiles!.findByIdAndUserId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFile({ fileName: 'Report.pdf' })
    );

    const out = await runById(ctx);

    expect(out).toContain('Retrieved content from');
    expect(out).toContain('real content body');
    expect(out).not.toContain('indexing may still be in progress');
  });
});

/**
 * The two guards on the paged read that no other test reaches: the page cap, and the cursor that
 * fails to advance. Both were added with the paging and neither would fail if it were deleted.
 */
describe('retrieve_knowledge_content paged-read guards', () => {
  const PAGE_SIZE = 50;
  const MAX_PAGES = 200;
  const CAP_CHUNKS = PAGE_SIZE * MAX_PAGES; // 10000: the most the cap can read

  const ctxWith = (repo: unknown) => {
    const ctx = makeContext({ retrievalFilter: {} });
    (ctx.db as { fabfilechunks: unknown }).fabfilechunks = repo;
    (ctx.db.fabfiles!.findByIdAndUserId as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFile({ fileName: 'Handbook.pdf' })
    );
    return ctx;
  };

  /**
   * `max_chars` at the absolute maximum is what makes the page cap reachable AT ALL. Even a chunk with
   * empty text accrues one separator character, so at the 8000 default the character budget always
   * ends the walk before 10000 chunks and the cap is dead code. That is worth knowing on its own.
   */
  const runBigBudget = (ctx: ToolContext) => {
    const tool = knowledgeBaseRetrieveTool.implementation(ctx, undefined);
    return tool.toolFn({ file_id: FILE_ID, max_chars: 16000 }) as Promise<string>;
  };

  const emptyChunks = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `c-${String(i).padStart(7, '0')}`, text: '' }));

  it('names the page cap, not the budget, when the cap is what stopped the walk', async () => {
    // One page-worth beyond what the cap can read, so chunks are genuinely left unread.
    const ctx = ctxWith(pagedTextChunkRepo(emptyChunks(CAP_CHUNKS + PAGE_SIZE)));

    const out = await runBigBudget(ctx);

    expect(out).toContain('truncated at the chunk-page cap');
    expect(out).not.toContain('truncated at budget');
  });

  it('does not call a whole file truncated just because it ended on the last allowed page', async () => {
    // Exactly what the cap can read, nothing left over: delivered whole, so no truncation label at all.
    const ctx = ctxWith(pagedTextChunkRepo(emptyChunks(CAP_CHUNKS)));

    const out = await runBigBudget(ctx);

    expect(out).not.toContain('truncated at the chunk-page cap');
    expect(out).toContain(`Chunks: ${CAP_CHUNKS} |`);
  });

  it('skips the count query when the walk already reached the end of the file', async () => {
    // A short page proves exhaustion for this reader (it applies no filter), so chunksRead already IS
    // the file's chunk count and the extra round trip buys nothing. This is the normal shape for a file
    // inside the budget, and it runs once per delivered file.
    const repo = pagedTextChunkRepo([
      { id: 'c-0000001', text: 'alpha' },
      { id: 'c-0000002', text: 'beta' },
    ]);
    const ctx = ctxWith(repo);

    const out = await runById(ctx);

    expect(repo.countByFabFileId).not.toHaveBeenCalled();
    expect(out).toContain('Chunks: 2 |');
  });

  it('still asks for the count when a budget or cap cut the walk short', async () => {
    // Cut short, so chunksRead is NOT the file total and the count is the only honest source for it.
    const ctx = ctxWith(pagedTextChunkRepo(emptyChunks(CAP_CHUNKS + PAGE_SIZE)));
    const repo = ctx.db.fabfilechunks as unknown as { countByFabFileId: ReturnType<typeof vi.fn> };

    await runBigBudget(ctx);

    expect(repo.countByFabFileId).toHaveBeenCalled();
  });

  it('stops on a cursor that does not advance instead of re-reading the same page', async () => {
    // A repository ignoring afterChunkId. The throw is caught by the tool's own handler and surfaced as
    // a refusal string rather than propagating - the point is that it STOPS, not that it rejects.
    const stuck = {
      findTextsByFabFileId: vi.fn(async () =>
        Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: `c-${String(i).padStart(7, '0')}`, text: 'body' }))
      ),
      countByFabFileId: vi.fn(async () => 99999),
    };

    const out = await runById(ctxWith(stuck));

    expect(out).toContain('error occurred while retrieving');
    // Bounded: it did not drain the page cap re-reading page one.
    expect(stuck.findTextsByFabFileId.mock.calls.length).toBeLessThan(4);
  });
});
