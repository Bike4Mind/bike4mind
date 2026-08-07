import { describe, it, expect, vi, beforeEach } from 'vitest';

const getDynamicDataLakeAccessMock = vi.fn();
vi.mock('../../../../dataLakeService/getDynamicDataLakeTags', () => ({
  getDynamicDataLakeAccess: (...args: unknown[]) => getDynamicDataLakeAccessMock(...args),
}));

import { knowledgeBaseCountTool } from './index';
import type { ToolContext } from '../../base/types';

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

/** A DB lake: membership carries the creator its prefix arm is anchored to. */
const dynamicLake = {
  id: 'lake1',
  name: 'Research Library',
  slug: 'research',
  datalakeTag: 'datalake:org1:research',
  fileTagPrefix: 'acme:',
  membership: { datalakeTag: 'datalake:org1:research', fileTagPrefix: 'acme:', creatorUserId: 'owner1' },
  source: 'dynamic' as const,
};

/** A static-registry lake: no creator, so it can only be counted through the OPEN prefix arm. */
const registryLake = {
  id: 'lake2',
  name: 'Shared KB',
  slug: 'shared',
  datalakeTag: 'datalake:shared',
  fileTagPrefix: 'opti:',
  source: 'registry' as const,
};

function makeContext(overrides: Partial<ToolContext> = {}, search?: ReturnType<typeof vi.fn>): ToolContext {
  return {
    userId: 'u1',
    user: { id: 'u1', groups: ['g1'] } as never,
    sessionId: 's1',
    logger,
    statusUpdate: vi.fn().mockResolvedValue(undefined),
    db: {
      fabfiles: { search: search ?? vi.fn().mockResolvedValue({ data: [], total: 585, hasMore: false }) },
    } as never,
    ...overrides,
  } as ToolContext;
}

const run = (context: ToolContext) =>
  knowledgeBaseCountTool.implementation(context, undefined).toolFn({}) as Promise<string>;

const searchCalls = (context: ToolContext) => (context.db.fabfiles!.search as ReturnType<typeof vi.fn>).mock.calls;

beforeEach(() => {
  getDynamicDataLakeAccessMock.mockReset().mockResolvedValue({
    dataLakeTags: [dynamicLake.datalakeTag],
    dataLakeTagPrefixes: [],
    scopedTagPrefixes: [dynamicLake.fileTagPrefix],
    lakes: [dynamicLake],
  });
});

describe('count_knowledge_base', () => {
  it('reports the lake total by name', async () => {
    const out = await run(makeContext());
    expect(out).toContain('Research Library: 585 document(s)');
    expect(out).not.toContain('at least');
  });

  it('counts a DB lake through the lake membership scope, restricted to that lake', async () => {
    // Parity with the single-lake browse (GET /api/data-lakes/:id/articles) is the whole point:
    // the number has to be the one the lake's page shows, or the user reads it as a wrong answer.
    const ctx = makeContext();
    await run(ctx);
    expect(searchCalls(ctx)[0][5]).toMatchObject({
      lakeMembership: dynamicLake.membership,
      restrictToDataLake: true,
      includeShared: true,
      userGroups: ['g1'],
    });
    expect(searchCalls(ctx)[0][5]).not.toHaveProperty('dataLakeTags');
  });

  it('counts a registry lake through the OPEN prefix arm instead', async () => {
    // A registry lake's files carry no meta-tag, so a membership-scope count would return 0.
    getDynamicDataLakeAccessMock.mockResolvedValue({
      dataLakeTags: [],
      dataLakeTagPrefixes: [registryLake.fileTagPrefix],
      scopedTagPrefixes: [],
      lakes: [registryLake],
    });
    const ctx = makeContext();
    await run(ctx);
    expect(searchCalls(ctx)[0][5]).toMatchObject({
      dataLakeTags: [registryLake.datalakeTag],
      dataLakeTagPrefixes: [registryLake.fileTagPrefix],
      restrictToDataLake: true,
    });
    expect(searchCalls(ctx)[0][5]).not.toHaveProperty('lakeMembership');
  });

  it('totals several libraries and names each', async () => {
    getDynamicDataLakeAccessMock.mockResolvedValue({
      dataLakeTags: [],
      dataLakeTagPrefixes: [],
      scopedTagPrefixes: [],
      lakes: [dynamicLake, registryLake],
    });
    const out = await run(makeContext());
    expect(out).toContain('Research Library: 585 document(s)');
    expect(out).toContain('Shared KB: 585 document(s)');
    expect(out).toContain('Total across 2 libraries: 1170 document(s)');
  });

  it('forbids the infrastructure answers the missing capability used to provoke', async () => {
    const out = await run(makeContext());
    expect(out).toContain('never');
    expect(out).toContain('SQL, storage consoles or other infrastructure steps');
  });

  describe('retrieval exclusion', () => {
    // The DB clause is best-effort (it depends on a regex engine and a lowercase field that may
    // be unpopulated), so on an exclusion-enabled session countDocuments overstates. Counting has
    // to walk the documents and apply the authoritative in-memory predicate.
    const excluded = { retrievalFilter: { excludeFilenameMarkers: ['MARK'], vectorizedOnly: false } };

    const page = (files: { fileName: string }[], hasMore: boolean) => ({ data: files, total: 999, hasMore });

    it('drops excluded documents from the count rather than trusting the DB total', async () => {
      const search = vi
        .fn()
        .mockResolvedValue(
          page(
            [{ fileName: 'MARK - retired.pdf' }, { fileName: 'Clean one.pdf' }, { fileName: 'Clean two.pdf' }],
            false
          )
        );
      const out = await run(makeContext(excluded, search));
      expect(out).toContain('Research Library: 2 document(s)');
      expect(out).not.toContain('999');
    });

    it('forwards the exclusion options to the DB pre-filter too', async () => {
      const ctx = makeContext(excluded);
      await run(ctx);
      expect(searchCalls(ctx)[0][5]).toMatchObject({ excludeFilenameMarkers: ['MARK'], vectorizedOnly: false });
    });

    it('reports a floor, never a guess, when the scan bound is reached', async () => {
      const search = vi.fn().mockResolvedValue(page([{ fileName: 'Clean.pdf' }], true));
      const out = await run(makeContext(excluded, search));
      expect(out).toContain('at least');
      expect(out).toContain('counting stopped at a scan limit');
      expect(search).toHaveBeenCalledTimes(10);
    });

    it('pages a walked count in a total order so no document is counted twice', async () => {
      const search = vi.fn().mockResolvedValue(page([{ fileName: 'Clean.pdf' }], false));
      const ctx = makeContext(excluded, search);
      await run(ctx);
      expect(searchCalls(ctx)[0][5]).toMatchObject({ stableSort: true });
    });

    it('an unset filter is a plain count - no walk', async () => {
      const ctx = makeContext({ retrievalFilter: {} });
      await run(ctx);
      expect(searchCalls(ctx)).toHaveLength(1);
      expect(searchCalls(ctx)[0][3]).toEqual({ page: 1, limit: 1 });
    });
  });

  describe('agent-scoped knowledge base (kbScope)', () => {
    it('counts only the scoped files and never resolves owner-wide lake access', async () => {
      const ctx = makeContext({ kbScope: { fileIds: ['f1', 'f2'] } });
      const out = await run(ctx);
      expect(getDynamicDataLakeAccessMock).not.toHaveBeenCalled();
      expect(searchCalls(ctx)[0][2]).toMatchObject({ restrictToFileIds: ['f1', 'f2'] });
      expect(searchCalls(ctx)[0][5]).toMatchObject({ skipOwnership: true, includeShared: false });
      expect(out).toContain("This agent's knowledge base contains 585 document(s)");
    });

    it('a scope of nothing counts nothing and reads nothing', async () => {
      const ctx = makeContext({ kbScope: { fileIds: [] } });
      const out = await run(ctx);
      expect(out).toContain('no documents');
      expect(searchCalls(ctx)).toHaveLength(0);
      expect(getDynamicDataLakeAccessMock).not.toHaveBeenCalled();
    });
  });

  it('with no accessible lake, counts the caller own and shared files instead of reporting nothing', async () => {
    getDynamicDataLakeAccessMock.mockResolvedValue({
      dataLakeTags: [],
      dataLakeTagPrefixes: [],
      scopedTagPrefixes: [],
      lakes: [],
    });
    const ctx = makeContext();
    const out = await run(ctx);
    expect(out).toContain('no data lake / curated library');
    expect(out).toContain('585 document(s)');
    expect(searchCalls(ctx)[0][5]).not.toHaveProperty('restrictToDataLake');
  });

  it('says the count is unavailable rather than letting a failure become a guess', async () => {
    const search = vi.fn().mockRejectedValue(new Error('mongo down'));
    const out = await run(makeContext({}, search));
    expect(out).toContain('Could not count');
    expect(out).toContain('rather than guessing a number');
  });
});
