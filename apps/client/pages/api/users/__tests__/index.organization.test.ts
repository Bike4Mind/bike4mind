import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { USER_SECRET_FIELDS } from '@bike4mind/common';

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  facet: vi.fn(),
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
    billingContact: 'billing@example.com',
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
  executeFacetCompatible: mockRefs.facet,
  convertPipelineForDocumentDB: (p: any) => p,
  mongoose: { Types: { ObjectId: class {} } },
}));
vi.mock('@server/users/sharedWorkspaceUserIds', () => ({ findSharedWorkspaceUserIds: vi.fn() }));
vi.mock('@server/users/pendingProjectInviteeIds', () => ({ findPendingProjectInviteeIds: vi.fn() }));
vi.mock('@casl/mongoose', () => ({ accessibleBy: () => ({ ofType: () => ({}) }) }));
vi.mock('@bike4mind/utils/escapeRegex', () => ({ escapeRegex: (s: string) => s }));

import '@pages/api/users/index';

mockRefs.facet.mockImplementation(() =>
  Promise.resolve([{ totalCount: [{ count: 1 }], paginatedResults: [makeRow()] }])
);

async function listAs(query: Record<string, unknown>, isAdmin: boolean) {
  const { req, res } = createMocks({ method: 'GET', query });
  (req as any).user = { id: 'viewer1', isAdmin };
  await mockRefs.getHandler!(req, res);
  return res._getJSONData();
}

describe('GET /api/users - populated organization', () => {
  it('returns the serialized organization shape in the paginated list', async () => {
    const body = await listAs({}, true);
    const org = body.users[0].organizationId;

    expect(org).toMatchObject({ id: 'o1', name: 'Org' });
    expect(org).not.toHaveProperty('stripeCustomerId');
    expect(org).toHaveProperty('billingContact');
    expect(JSON.stringify(body)).not.toContain('stripeCustomerId');
    expect(JSON.stringify(body)).not.toContain('cus_123');
    for (const f of USER_SECRET_FIELDS) expect(body.users[0]).not.toHaveProperty(f);
  });

  it('omits billingContact and stripeCustomerId for a non-admin viewer', async () => {
    const body = await listAs({}, false);
    const org = body.users[0].organizationId;

    expect(org).toMatchObject({ id: 'o1', name: 'Org' });
    expect(org).not.toHaveProperty('billingContact');
    expect(org).not.toHaveProperty('stripeCustomerId');
  });

  it('returns the serialized organization shape in the downloadAll list', async () => {
    const body = await listAs({ downloadAll: 'true' }, true);
    const org = body.users[0].organizationId;

    expect(org).toMatchObject({ id: 'o1', name: 'Org' });
    expect(org).not.toHaveProperty('stripeCustomerId');
    expect(JSON.stringify(body)).not.toContain('stripeCustomerId');
    for (const f of USER_SECRET_FIELDS) expect(body.users[0]).not.toHaveProperty(f);
  });

  it('does not project the joined organization object in either branch', async () => {
    const { User } = await import('@bike4mind/database');
    const projectStages = (pipeline: any[]) => pipeline.filter(stage => stage.$project).map(stage => stage.$project);

    await listAs({}, true);
    const paginatedPipeline = mockRefs.facet.mock.calls.at(-1)![1] as any[];
    await listAs({ downloadAll: 'true' }, true);
    const downloadPipeline = (User.aggregate as any).mock.calls.at(-1)![0] as any[];

    for (const pipeline of [paginatedPipeline, downloadPipeline]) {
      const projections = projectStages(pipeline);
      expect(projections.length).toBeGreaterThan(0);
      for (const p of projections) expect(p).not.toHaveProperty('organization');
    }
  });
});
