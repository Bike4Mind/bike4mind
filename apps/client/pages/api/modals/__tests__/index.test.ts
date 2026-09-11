import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/modals never enforced publication state server-side - a direct call served Draft,
 * not-yet-live and expired modals to any authenticated user. The non-admin filter added to
 * close that must not itself hide a modal that HAS started: the daily What's New generator
 * and its edit form write a full ISO timestamp into the same `startDate` field the admin form
 * stores as a bare `YYYY-MM-DD` string, and a naive `$lte` bound treats that longer string as
 * "later" than today, hiding the modal on its own start day.
 */

// `any` below is deliberate test-mock plumbing for the next-connect / node-mocks-http chain,
// matching the repo's handler-test convention.
const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  findFilter: undefined as any,
  modals: [] as any[],
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/database/social', () => ({
  ModalModel: {
    find: (filter: any) => {
      mockRefs.findFilter = filter;
      return Promise.resolve(mockRefs.modals);
    },
  },
}));

vi.mock('@bike4mind/services', () => ({
  extractVariantForViewer: (doc: any) => doc,
  viewerClassifier: {
    classify: vi.fn(async () => 'customer'),
    safeDefaultKey: 'customer',
  },
}));

import '@pages/api/modals';

function mocks(isAdmin: boolean, query: Record<string, string> = {}) {
  const { req, res } = createMocks({ method: 'GET', query });
  (req as any).ability = { can: () => true };
  (req as any).user = { id: 'user-1', isAdmin };
  return { req, res };
}

describe('GET /api/modals - non-admin publication-state filter', () => {
  beforeEach(() => {
    mockRefs.findFilter = undefined;
    mockRefs.modals = [];
  });

  it('admins bypass the publication-state filter entirely', async () => {
    // excludeWhatsNew=false also opts out of the (unrelated, pre-existing) admin default
    // that excludes What's New tagged modals, isolating the enabled/startDate/endDate filter
    // this test actually cares about.
    const { req, res } = mocks(true, { excludeWhatsNew: 'false' });
    await mockRefs.getHandler!(req, res);
    expect(mockRefs.findFilter).toEqual({});
  });

  it('does not exclude a modal whose startDate is a full ISO timestamp for today', async () => {
    const { req, res } = mocks(false);
    await mockRefs.getHandler!(req, res);

    // An auto-generated What's New modal's startDate (queueHandlers/whatsNewGeneration.ts,
    // hooks/data/whatsNewModals.ts both write `new Date().toISOString()`).
    const todaysTimestamp = new Date().toISOString();
    const startDateUpperBound = mockRefs.findFilter.$and[0].$or[2].startDate.$lte;
    expect(todaysTimestamp <= startDateUpperBound).toBe(true);
  });

  it('still excludes a modal that has not started yet', async () => {
    const { req, res } = mocks(false);
    await mockRefs.getHandler!(req, res);

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const startDateUpperBound = mockRefs.findFilter.$and[0].$or[2].startDate.$lte;
    expect(tomorrow <= startDateUpperBound).toBe(false);
  });
});
