import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFind, mockFindAllActive, mockFindByPhone, mockCreate, mockUpdate } = vi.hoisted(() => ({
  mockFind: vi.fn(),
  mockFindAllActive: vi.fn(),
  mockFindByPhone: vi.fn(),
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain: Record<string, unknown> = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        get: (fn: (req: unknown, res: unknown) => unknown) => ((h.GET = fn), chain),
        post: (fn: (req: unknown, res: unknown) => unknown) => ((h.POST = fn), chain),
        put: (fn: (req: unknown, res: unknown) => unknown) => ((h.PUT = fn), chain),
        delete: (fn: (req: unknown, res: unknown) => unknown) => ((h.DELETE = fn), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@bike4mind/database', () => ({
  internalTeamMemberRepository: {
    find: (...a: unknown[]) => mockFind(...a),
    findAllActive: (...a: unknown[]) => mockFindAllActive(...a),
    findByPhone: (...a: unknown[]) => mockFindByPhone(...a),
    create: (...a: unknown[]) => mockCreate(...a),
    update: (...a: unknown[]) => mockUpdate(...a),
  },
}));

vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn() }));

import handler from '../team-members';

const ADMIN = { id: 'a1', isAdmin: true };

const call = async (method: string, { body, query }: { body?: unknown; query?: Record<string, string> } = {}) => {
  const { req, res } = createMocks({ method: method as 'GET', body: body as object, query });
  (req as unknown as Record<string, unknown>).user = ADMIN;
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};

// A stored document carries fields the admin UI never declared (ORM internals, legacy columns).
const stored = {
  id: 'tm1',
  name: 'Ada',
  phone: '+15550100',
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
  __v: 0,
  legacyInternalNote: 'x',
};
const declared = {
  id: 'tm1',
  name: 'Ada',
  phone: '+15550100',
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('/api/admin/team-members response schema', () => {
  it('GET strips undeclared fields from every member', async () => {
    mockFindAllActive.mockResolvedValue([stored]);
    const res = await call('GET');
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual([declared]);
  });

  it('GET with includeInactive strips undeclared fields too', async () => {
    mockFind.mockResolvedValue([stored]);
    const res = await call('GET', { query: { includeInactive: 'true' } });
    expect(res._getJSONData()).toEqual([declared]);
  });

  it('POST responds 201 with the declared fields only', async () => {
    mockFindByPhone.mockResolvedValue(null);
    mockCreate.mockResolvedValue(stored);
    const res = await call('POST', { body: { name: 'Ada', phone: '+15550100' } });
    expect(res._getStatusCode()).toBe(201);
    expect(res._getJSONData()).toEqual(declared);
  });

  it('PUT strips undeclared fields from the updated member', async () => {
    mockUpdate.mockResolvedValue(stored);
    const res = await call('PUT', { body: { id: 'tm1', name: 'Ada' } });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual(declared);
  });
});
