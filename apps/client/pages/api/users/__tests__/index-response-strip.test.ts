// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  getHandler: null as null | ((req: unknown, res: unknown) => unknown),
  rows: [] as Record<string, unknown>[],
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, unknown> = {
    use: () => chain,
    get: (fn: (req: unknown, res: unknown) => unknown) => {
      h.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@bike4mind/database', () => ({
  User: {
    find: vi.fn(),
    populate: vi.fn().mockResolvedValue(undefined),
    hydrate: (u: Record<string, unknown>) => ({ toJSON: () => ({ ...u }) }),
    aggregate: vi.fn(() => Promise.resolve(h.rows)),
  },
  Project: { findById: vi.fn() },
  projectRepository: { shareable: { findAccessibleById: vi.fn() } },
  executeFacetCompatible: () => Promise.resolve([{ totalCount: [{ count: h.rows.length }], paginatedResults: h.rows }]),
  convertPipelineForDocumentDB: (p: unknown) => p,
  mongoose: { Types: { ObjectId: class {} } },
}));
vi.mock('@server/users/sharedWorkspaceUserIds', () => ({ findSharedWorkspaceUserIds: vi.fn() }));
vi.mock('@server/users/pendingProjectInviteeIds', () => ({ findPendingProjectInviteeIds: vi.fn() }));
vi.mock('@server/users/signupAnomaly', () => ({ getDomainGroups: vi.fn(), SIGNUP_SCAN_LIMIT: 5000 }));
vi.mock('@casl/mongoose', () => ({ accessibleBy: () => ({ ofType: () => ({}) }) }));
vi.mock('@bike4mind/utils/escapeRegex', () => ({ escapeRegex: (s: string) => s }));

import '../index';

function row() {
  return {
    id: 'u1',
    _id: 'oid1',
    __v: 3,
    name: 'Ada',
    email: 'ada@example.com',
    passwordHash: 'hash',
    isSystem: true,
    secretNotInSchema: 'x',
    organizationId: null,
  };
}

async function call(query: Record<string, string>) {
  const { req, res } = createMocks({ method: 'GET', query });
  (req as unknown as { user: unknown }).user = { id: 'admin1', isAdmin: true };
  await h.getHandler!(req, res);
  return res;
}

function expectStripped(user: Record<string, unknown>) {
  expect(user).toMatchObject({ id: 'u1', name: 'Ada', email: 'ada@example.com' });
  for (const key of ['_id', '__v', 'passwordHash', 'isSystem', 'secretNotInSchema']) {
    expect(user).not.toHaveProperty(key);
  }
}

describe('GET /api/users - admin response boundary', () => {
  it('strips undeclared keys from paginated rows and keeps the pagination envelope', async () => {
    h.rows = [row()];
    const res = await call({});

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body).toMatchObject({ currentPage: 1, totalPages: 1, totalUsers: 1 });
    expectStripped(body.users[0]);
  });

  it('strips undeclared keys from downloadAll rows', async () => {
    h.rows = [row()];
    const res = await call({ downloadAll: 'true' });

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body.totalUsers).toBe(1);
    expectStripped(body.users[0]);
  });
});
