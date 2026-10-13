import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { USER_SECRET_FIELDS } from '@bike4mind/common';

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
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

const makeRow = () => ({
  _id: 'u2',
  name: 'Member',
  organizationId: {
    id: 'o1',
    name: 'Org',
    userId: 'owner',
    stripeCustomerId: 'cus_123',
    billingContact: { email: 'billing@example.com' },
  },
});

vi.mock('@bike4mind/database', () => ({
  User: {
    find: () => ({ getQuery: () => ({}) }),
    populate: vi.fn().mockResolvedValue(undefined),
    hydrate: (u: any) => ({ toJSON: () => ({ ...u }) }),
    aggregate: vi.fn().mockImplementation(() => Promise.resolve([makeRow()])),
  },
  Project: { findById: vi.fn() },
  projectRepository: { shareable: { findAccessibleById: vi.fn() } },
  executeFacetCompatible: () => Promise.resolve([{ totalCount: [{ count: 1 }], paginatedResults: [makeRow()] }]),
  convertPipelineForDocumentDB: (p: any) => p,
  mongoose: { Types: { ObjectId: class {} } },
}));
vi.mock('@server/users/sharedWorkspaceUserIds', () => ({ findSharedWorkspaceUserIds: vi.fn() }));
vi.mock('@server/users/pendingProjectInviteeIds', () => ({ findPendingProjectInviteeIds: vi.fn() }));
vi.mock('@casl/mongoose', () => ({ accessibleBy: () => ({ ofType: () => ({}) }) }));
vi.mock('@bike4mind/utils/escapeRegex', () => ({ escapeRegex: (s: string) => s }));

import '@pages/api/users/index';

async function listAs(query: Record<string, unknown>, isAdmin: boolean) {
  const { req, res } = createMocks({ method: 'GET', query });
  (req as any).user = { id: 'viewer1', isAdmin };
  await mockRefs.getHandler!(req, res);
  return res._getJSONData();
}

describe('GET /api/users - populated organization', () => {
  it('returns the serialized organization shape in the paginated list', async () => {
    const body = await listAs({}, false);
    const org = body.users[0].organizationId;

    expect(org).toMatchObject({ id: 'o1', name: 'Org' });
    expect(org).not.toHaveProperty('stripeCustomerId');
    expect(org).not.toHaveProperty('billingContact');
    for (const f of USER_SECRET_FIELDS) expect(body.users[0]).not.toHaveProperty(f);
  });

  it('returns the serialized organization shape in the downloadAll list', async () => {
    const body = await listAs({ downloadAll: 'true' }, true);
    const org = body.users[0].organizationId;

    expect(org).toMatchObject({ id: 'o1', name: 'Org' });
    expect(org).not.toHaveProperty('stripeCustomerId');
    for (const f of USER_SECRET_FIELDS) expect(body.users[0]).not.toHaveProperty(f);
  });
});
