import { beforeEach, describe, expect, it, vi } from 'vitest';

const findByDatalakeTag = vi.fn();
const findMembershipOrgIds = vi.fn(async () => ['org-1']);
const recallLakeMemoryMock = vi.fn(async () => []);

vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: { findByDatalakeTag: (...args: unknown[]) => findByDatalakeTag(...args) },
  fabFileRepository: {},
  organizationRepository: { findMembershipOrgIds: (...args: unknown[]) => findMembershipOrgIds(...(args as [])) },
}));
vi.mock('../embeddings/effectiveEmbeddingModel', () => ({
  resolveEffectiveEmbeddingModel: async () => 'text-embedding-3-small',
}));
vi.mock('./recallLakeMemory', () => ({
  recallLakeMemory: (...args: unknown[]) => recallLakeMemoryMock(...(args as [])),
}));

import { recallLakeMemoryForSession } from './lakeMemoryRecall';

describe('recallLakeMemoryForSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recallLakeMemoryMock.mockResolvedValue([]);
    findByDatalakeTag.mockResolvedValue({
      createdByUserId: 'owner-1',
      status: 'active',
      lakeMemoryEnabled: true,
    });
  });

  /**
   * The one assertion that pins the FIX rather than the seam. `recallLakeMemory` still accepts a
   * `resolveSourceDates` injection and its own tests still exercise the fold, so every test on that
   * side would keep passing if this wiring handed it a resolver again - and the only resolver
   * available answers with the FabFile's upload time. Assert the absence here, at the one call site
   * that decides what production does.
   */
  it('wires no source-dates resolver, so recalled beliefs carry no date', async () => {
    await recallLakeMemoryForSession({
      userId: 'u1',
      query: 'pto policy',
      dataLakeTags: ['datalake:hr'],
      trustedLakesOnly: false,
      k: 5,
    });

    expect(recallLakeMemoryMock).toHaveBeenCalledTimes(1);
    const opts = (recallLakeMemoryMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(opts).not.toHaveProperty('resolveSourceDates');
    // The reachability resolver IS still wired - without this, the assertion above would also pass
    // on a call that had quietly stopped injecting anything at all.
    expect(typeof opts.resolveReachableSources).toBe('function');
  });

  describe('trustedLakesOnly', () => {
    const lakes: Record<string, Record<string, unknown>> = {
      'datalake:own': { createdByUserId: 'u1', status: 'active', lakeMemoryEnabled: true },
      'datalake:org': { createdByUserId: 'other', organizationId: 'org-1', status: 'active', lakeMemoryEnabled: true },
      'datalake:public': {
        createdByUserId: 'stranger',
        organizationId: 'org-9',
        status: 'active',
        lakeMemoryEnabled: true,
      },
    };
    const recalledTags = () =>
      ((recallLakeMemoryMock.mock.calls[0] as unknown[])[0] as { lakes: { datalakeTag: string }[] }).lakes.map(
        lake => lake.datalakeTag
      );

    beforeEach(() => {
      findByDatalakeTag.mockImplementation(async (tag: string) => lakes[tag] ?? null);
    });

    it("keeps the user's own and org lakes and drops a lake reached only by read access", async () => {
      await recallLakeMemoryForSession({
        userId: 'u1',
        query: 'q',
        dataLakeTags: Object.keys(lakes),
        trustedLakesOnly: true,
        k: 5,
      });
      expect(findMembershipOrgIds).toHaveBeenCalledWith('u1');
      expect(recalledTags()).toEqual(['datalake:own', 'datalake:org']);
    });

    it('keeps every readable lake the session named', async () => {
      await recallLakeMemoryForSession({
        userId: 'u1',
        query: 'q',
        dataLakeTags: Object.keys(lakes),
        trustedLakesOnly: false,
        k: 5,
      });
      expect(findMembershipOrgIds).not.toHaveBeenCalled();
      expect(recalledTags()).toEqual(Object.keys(lakes));
    });
  });
});
