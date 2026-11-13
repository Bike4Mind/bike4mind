import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFindById, mockFindMembershipOrgIds, mockProjectExists, mockSessionExists, mockIsLegacy } = vi.hoisted(
  () => ({
    mockIsLegacy: vi.fn(),
    mockFindById: vi.fn(),
    mockFindMembershipOrgIds: vi.fn(),
    mockProjectExists: vi.fn(),
    mockSessionExists: vi.fn(),
  })
);

vi.mock('@bike4mind/database', () => ({
  User: {
    findById: () => ({ populate: () => ({ select: mockFindById }) }),
  },
  Project: { exists: mockProjectExists },
  Session: { exists: mockSessionExists },
  organizationRepository: { findMembershipOrgIds: mockFindMembershipOrgIds },
  readAccessArms: (user: { id: string }) => [{ userId: user.id }],
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      get: (fn: (req: unknown, res: unknown) => unknown) => fn,
    };
    return chain;
  },
}));

type ScopedReq = { apiKeyInfo?: { scopes: string[]; createdAt?: Date } };

// holdsApiKeyScope mirrors the real contract (no key -> pass; else a held scope, or a legacy key
// when the caller grandfathers) so the legacy flag stays under the test's control.
vi.mock('@bike4mind/server-utils/middlewares/apiKeyScopeGate', () => ({
  isLegacyApiKey: (...a: unknown[]) => mockIsLegacy(...a),
  holdsApiKeyScope: (req: ScopedReq, required: string[], opts?: { grandfatherLegacyKeys?: boolean }) =>
    !req.apiKeyInfo ||
    required.some(scope => req.apiKeyInfo?.scopes.includes(scope)) ||
    (!!opts?.grandfatherLegacyKeys && mockIsLegacy(req.apiKeyInfo.createdAt) === true),
}));

import handler from '../index';

const SUBJECT_ID = 'subject-1';
const throttle = { tier: 'shadow', reason: 'x', source: 'admin' };
const riskSignals = [{ type: 'signup_honeypot', at: new Date('2025-01-01T00:00:00Z') }];

const fire = async (viewer: { id: string; isAdmin: boolean }, viaApiKey = false, scopes: string[] = ['me:read']) => {
  const { req, res } = createMocks({ method: 'GET', query: { id: SUBJECT_ID } });
  Object.assign(req, { user: viewer, ...(viaApiKey && { apiKeyInfo: { keyId: 'k1', scopes } }) });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
};

const run = async (viewer: { id: string; isAdmin: boolean }) =>
  (await fire(viewer))._getJSONData() as Record<string, unknown>;

describe('GET /api/users/[id] restricted-tier fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMembershipOrgIds.mockResolvedValue([]);
    mockProjectExists.mockResolvedValue(null);
    mockSessionExists.mockResolvedValue(null);
    mockFindById.mockResolvedValue({
      id: SUBJECT_ID,
      username: 'subject',
      name: 'Subject',
      email: 'subject@example.com',
      photoUrl: 'https://example.com/subject.png',
      throttle,
      riskSignals,
      toObject() {
        const { toObject: _t, ...rest } = this as Record<string, unknown>;
        return rest;
      },
    });
  });

  it('exposes throttle and riskSignals to an admin viewer', async () => {
    const body = await run({ id: 'admin-1', isAdmin: true });

    expect(body.throttle).toMatchObject({ tier: 'shadow' });
    expect(body.riskSignals).toHaveLength(1);
  });

  it('withholds them from the subject viewing their own profile', async () => {
    const body = await run({ id: SUBJECT_ID, isAdmin: false });

    expect(body.username).toBe('subject');
    expect(body).not.toHaveProperty('throttle');
    expect(body).not.toHaveProperty('riskSignals');
  });

  describe('API-key caller', () => {
    beforeEach(() => {
      mockIsLegacy.mockReturnValue(false);
    });

    it("404s another user's profile without looking it up", async () => {
      const res = await fire({ id: 'someone-else', isAdmin: false }, true);

      expect(res._getStatusCode()).toBe(404);
      expect(mockFindById).not.toHaveBeenCalled();
    });

    it("serves a legacy key another user's public profile, as before scopes", async () => {
      mockIsLegacy.mockReturnValue(true);
      const res = await fire({ id: 'someone-else', isAdmin: false }, true);

      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().username).toBe('subject');
      expect(res._getJSONData()).not.toHaveProperty('throttle');
    });

    it('403s a key minted for a connected app, even for its own profile', async () => {
      const { req, res } = createMocks({ method: 'GET', query: { id: SUBJECT_ID } });
      Object.assign(req, {
        user: { id: SUBJECT_ID, isAdmin: false },
        apiKeyInfo: { keyId: 'k1', scopes: ['me:read'], oauthExchangeClientId: 'c1' },
      });
      await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);

      expect(res._getStatusCode()).toBe(403);
      expect(mockFindById).not.toHaveBeenCalled();
    });

    it('serves the key owner their own profile', async () => {
      const res = await fire({ id: SUBJECT_ID, isAdmin: false }, true);

      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().username).toBe('subject');
    });

    it('serves another user, admin-only fields included, to an admin key with admin:*', async () => {
      const res = await fire({ id: 'admin-1', isAdmin: true }, true, ['admin:*']);

      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().throttle).toMatchObject({ tier: 'shadow' });
    });

    it("404s another user's profile to an admin's me:read-only key", async () => {
      const res = await fire({ id: 'admin-1', isAdmin: true }, true);

      expect(res._getStatusCode()).toBe(404);
      expect(mockFindById).not.toHaveBeenCalled();
    });

    it("withholds admin-only fields from an admin's me:read-only key on their own profile", async () => {
      const res = await fire({ id: SUBJECT_ID, isAdmin: true }, true);

      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().username).toBe('subject');
      expect(res._getJSONData()).not.toHaveProperty('throttle');
      expect(res._getJSONData()).not.toHaveProperty('riskSignals');
    });

    it("404s another user's profile to a non-admin's key, even one holding admin:*", async () => {
      const res = await fire({ id: 'someone-else', isAdmin: false }, true, ['admin:*']);

      expect(res._getStatusCode()).toBe(404);
      expect(mockFindById).not.toHaveBeenCalled();
    });

    it("keeps an admin's legacy key reading admin-only fields until the legacy window ends", async () => {
      mockIsLegacy.mockReturnValue(true);
      const res = await fire({ id: 'admin-1', isAdmin: true }, true);

      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().throttle).toMatchObject({ tier: 'shadow' });
    });
  });
});
