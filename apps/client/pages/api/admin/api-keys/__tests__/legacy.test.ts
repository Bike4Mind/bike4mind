import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope, CONFINED_API_KEY_SCOPES } from '@bike4mind/common';

/**
 * Legacy-key list contract. apiKeyScopeGate is not stubbed: the route must apply the same
 * `getApiKeyLegacyStatus` the owner list uses. Only the window is swapped, because the shipped
 * one has no dates yet.
 */

type Handler = (req: unknown, res: unknown) => unknown;

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | Handler,
  config: undefined as undefined | Record<string, unknown>,
  window: { cutoff: null as Date | null, endsAt: null as Date | null },
}));

vi.mock('@server/middlewares/baseApi', () => {
  const middlewares: Array<(req: unknown, res: unknown, next: () => void) => unknown> = [];
  type Chain = { use: (middleware: (typeof middlewares)[number]) => Chain; get: (fn: Handler) => Chain };
  const chain: Chain = {
    use: middleware => {
      middlewares.push(middleware);
      return chain;
    },
    get: fn => {
      mockRefs.getHandler = async (req, res) => {
        for (const middleware of middlewares) await middleware(req, res, () => undefined);
        return fn(req, res);
      };
      return chain;
    },
  };
  return {
    baseApi: (config?: Record<string, unknown>) => {
      mockRefs.config = config;
      return chain;
    },
  };
});
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: Handler) => fn }));
vi.mock('@bike4mind/server-utils/middlewares/apiKeyScopeGate', async importOriginal => ({
  ...(await importOriginal<object>()),
  LEGACY_API_KEY_WINDOW: mockRefs.window,
}));

const findLegacyCandidatesPage = vi.hoisted(() => vi.fn());
const findUsers = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: { findLegacyCandidatesPage } }));
vi.mock('@bike4mind/database', () => ({ userRepository: { find: findUsers } }));

import '../legacy';

const OWNER = '507f1f77bcf86cd799439011';
const CUTOFF = new Date('2027-01-01T00:00:00Z');
const ENDS_AT = new Date('2099-01-01T00:00:00Z');

const legacyKey = {
  id: 'key-legacy',
  name: 'Build bot',
  keyPrefix: 'b4m_live_abc',
  userId: OWNER,
  status: 'active',
  scopes: [ApiKeyScope.AI_GENERATE],
  metadata: { createdFrom: 'dashboard' },
  createdAt: new Date('2026-06-01T00:00:00Z'),
  lastUsedAt: new Date('2026-11-10T00:00:00Z'),
};

const invoke = async (query: Record<string, unknown> = {}, user: unknown = { isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'GET' });
  Object.assign(req, { query, user, logger: { warn } });
  await mockRefs.getHandler!(req, res);
  return res;
};

describe('GET /api/admin/api-keys/legacy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRefs.window.cutoff = CUTOFF;
    mockRefs.window.endsAt = ENDS_AT;
    findLegacyCandidatesPage.mockResolvedValue({ keys: [legacyKey], total: 41, ownerCount: 17 });
    findUsers.mockResolvedValue([{ id: OWNER, email: 'owner@example.com', name: 'Owner' }]);
  });

  it('accepts session auth only, never an API key', () => {
    expect(mockRefs.config?.auth).toBe('jwtOnly');
    expect(mockRefs.config).not.toHaveProperty('requiredScopes');
  });

  it('refuses a non-admin before querying keys', async () => {
    await expect(invoke({}, { isAdmin: false })).rejects.toThrow(/missing permission/i);
    expect(findLegacyCandidatesPage).not.toHaveBeenCalled();
  });

  it('pages the candidate query by the cutoff, excluding confined keys', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-13T00:00:00Z'));
    try {
      await invoke({ page: '3', limit: '50', days: '7' });
    } finally {
      vi.useRealTimers();
    }

    expect(findLegacyCandidatesPage).toHaveBeenCalledWith({
      createdBefore: CUTOFF,
      usedSince: new Date('2026-11-06T00:00:00Z'),
      excludeScopes: CONFINED_API_KEY_SCOPES,
      skip: 100,
      limit: 50,
    });
  });

  it('returns each legacy key with its owner, the totals and the window dates', async () => {
    const res = await invoke();

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({
      rows: [
        {
          keyId: 'key-legacy',
          name: 'Build bot',
          keyPrefix: 'b4m_live_abc',
          userId: OWNER,
          ownerEmail: 'owner@example.com',
          ownerName: 'Owner',
          createdAt: '2026-06-01T00:00:00.000Z',
          lastUsedAt: '2026-11-10T00:00:00.000Z',
        },
      ],
      page: 1,
      limit: 25,
      total: 41,
      ownerCount: 17,
      usedWithinDays: 30,
      cutoff: CUTOFF.toISOString(),
      endsAt: ENDS_AT.toISOString(),
    });
  });

  it('drops a candidate the shared legacy rule rejects', async () => {
    findLegacyCandidatesPage.mockResolvedValue({
      keys: [{ ...legacyKey, id: 'key-new', createdAt: new Date('2027-02-01T00:00:00Z') }],
      total: 1,
      ownerCount: 1,
    });

    const res = await invoke();

    expect(res._getJSONData().rows).toEqual([]);
    expect(findUsers).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/legacy rule rejects/), { dropped: 1 });
  });

  it('lists nothing once legacy access has ended, without querying', async () => {
    mockRefs.window.endsAt = new Date('2020-01-01T00:00:00Z');

    const res = await invoke();

    expect(findLegacyCandidatesPage).not.toHaveBeenCalled();
    expect(res._getJSONData()).toMatchObject({ rows: [], total: 0, ownerCount: 0 });
  });

  it('caps the page size and the page so one request stays bounded', async () => {
    await expect(invoke({ limit: '1000' })).rejects.toThrow();
    await expect(invoke({ page: '1001' })).rejects.toThrow();
    expect(findLegacyCandidatesPage).not.toHaveBeenCalled();
  });
});
