import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  audience: vi.fn(),
  adminAudience: vi.fn(),
  orgFindById: vi.fn(),
  spaceFindLive: vi.fn(),
}));

vi.mock('@client/server/middlewares/baseApi', () => ({
  baseApi: () => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const fn = (async (req: { method: string }, res: unknown) => handlers[req.method](req, res)) as ((
      req: unknown,
      res: unknown
    ) => unknown) &
      Record<string, (h: unknown) => unknown>;
    fn.get = (handler: unknown) => ((handlers.GET = handler as never), fn);
    return fn;
  },
}));
vi.mock('@bike4mind/database', () => ({ spaceRepository: { findLiveById: h.spaceFindLive } }));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: { findById: h.orgFindById } }));
vi.mock('@bike4mind/server-utils/skillMarket/market', () => ({
  audienceIdsFor: h.audience,
  adminAudienceIdsFor: h.adminAudience,
}));

import handler from '@pages/api/skills/market/me';

const call = async (user: object) => {
  const { req, res } = createMocks({ method: 'GET' });
  (req as unknown as { user: object }).user = user;
  await (handler as unknown as (a: unknown, b: unknown) => Promise<unknown>)(req, res);
  return res._getJSONData() as {
    organizations: unknown[];
    spaces: unknown[];
    isReviewer: boolean;
    isAdmin: boolean;
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.orgFindById.mockImplementation(async (id: string) => ({ id, name: `Org ${id}` }));
  h.spaceFindLive.mockImplementation(async (id: string) => (id === 'gone' ? null : { id, name: `Space ${id}` }));
});

describe('GET /api/skills/market/me', () => {
  it('lists the caller orgs and live Spaces, dropping a Space that no longer resolves', async () => {
    h.audience.mockResolvedValue({ orgIds: ['o1'], spaceIds: ['s1', 'gone'] });
    h.adminAudience.mockResolvedValue({ orgIds: [], spaceIds: [] });
    expect(await call({ id: 'u1' })).toEqual({
      organizations: [{ id: 'o1', name: 'Org o1' }],
      spaces: [{ id: 's1', name: 'Space s1' }],
      isReviewer: false,
      isAdmin: false,
    });
  });

  it('marks a Space admin as a reviewer, and a super-admin too', async () => {
    h.audience.mockResolvedValue({ orgIds: [], spaceIds: ['s1'] });
    h.adminAudience.mockResolvedValue({ orgIds: [], spaceIds: ['s1'] });
    expect((await call({ id: 'u1' })).isReviewer).toBe(true);
    h.adminAudience.mockResolvedValue({ orgIds: [], spaceIds: [] });
    expect((await call({ id: 'root', isAdmin: true })).isReviewer).toBe(true);
  });
});
