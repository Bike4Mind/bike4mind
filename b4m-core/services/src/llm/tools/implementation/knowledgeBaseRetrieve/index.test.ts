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
});
