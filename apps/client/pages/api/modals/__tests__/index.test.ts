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

function mocks(isAdmin: boolean, query: Record<string, string> = {}, adminPermissions?: string[]) {
  const { req, res } = createMocks({ method: 'GET', query });
  (req as any).ability = { can: () => true };
  (req as any).user = { id: 'user-1', isAdmin, adminPermissions };
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

    // The admin form (hooks/data/whatsNewModals.ts) writes `new Date().toISOString()`.
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

describe('GET /api/modals - delegated settings:manage', () => {
  beforeEach(() => {
    mockRefs.findFilter = undefined;
    mockRefs.modals = [];
  });

  it('lists drafts and expired modals for a settings:manage delegate', async () => {
    const { req, res } = mocks(false, {}, ['settings:manage']);
    await mockRefs.getHandler!(req, res);
    expect(mockRefs.findFilter.enabled).toBeUndefined();
    expect(mockRefs.findFilter.$and).toBeUndefined();
  });

  it("excludes What's New from the default list for a delegate, as for a full admin", async () => {
    const { req, res } = mocks(false, {}, ['settings:manage']);
    await mockRefs.getHandler!(req, res);
    expect(mockRefs.findFilter.tags).toEqual({ $ne: 'whats-new' });
  });

  it('keeps the publication filter for a delegate holding only another permission', async () => {
    const { req, res } = mocks(false, {}, ['support:read']);
    await mockRefs.getHandler!(req, res);
    expect(mockRefs.findFilter.enabled).toBe(true);
  });
});

describe('GET /api/modals - response audience', () => {
  it.each([
    ['a full admin', true, undefined, true],
    ['a settings:manage delegate', false, ['settings:manage'], true],
    ['a delegate holding only another permission', false, ['support:read'], false],
  ])('classifies %s', async (_case, isAdmin, adminPermissions, expectedAdmin) => {
    const { viewerClassifier } = await import('@bike4mind/services');
    vi.mocked(viewerClassifier.classify).mockClear();
    const { req, res } = mocks(isAdmin, {}, adminPermissions);

    await mockRefs.getHandler!(req, res);

    expect(viewerClassifier.classify).toHaveBeenCalledWith({ isAdmin: expectedAdmin });
  });
});
