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

beforeEach(() => getDynamicDataLakeAccessMock.mockClear());

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
