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
      fabfilechunks: {
        findByFabFileId: vi.fn().mockResolvedValue([{ id: 'c1', text: 'chunk body', vector: [0.1] }]),
      },
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
    expect(ctx.db.fabfilechunks!.findByFabFileId).not.toHaveBeenCalled();
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
    expect(ctx.db.fabfilechunks!.findByFabFileId).not.toHaveBeenCalled();
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
