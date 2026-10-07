import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * POST /api/user-api-keys/[id]/callback-secret: mints/replaces the key's
 * generation-callback signing secret. Modeled on rotate-revoke.test.ts's shallow
 * baseApi mock (the handler is captured and invoked directly), but unlike that
 * file the SERVICE here is left real - only the db repositories are mocked - so
 * these exercise the actual generateCallbackSigningSecret + assertNoScopeEscalation
 * logic the route depends on, not a stand-in that would make the whsec_/scope
 * assertions vacuous.
 *
 * The requiredScopes: [ApiKeyScope.AI_GENERATE] gate itself runs in baseApi's
 * apiKeyAuth middleware, upstream of the handler this shallow mock captures (same
 * as every other route test in this directory - see rate-limit.test.ts's
 * `meterAsKeyManagement` check). This file asserts baseApi received that option;
 * it does not exercise a live 403 from apiKeyAuth (that belongs to
 * server/middlewares/apiKeyAuth.test.ts, '403s a key that holds none of the required scopes').
 */

const mockRefs = vi.hoisted(() => ({
  handler: null as null | ((req: any, res: any) => unknown),
  baseApiOptions: undefined as undefined | Record<string, unknown>,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    get: () => chain,
    patch: () => chain,
    delete: () => chain,
    post: (fn: any) => {
      mockRefs.handler = fn;
      return chain;
    },
  };
  return {
    baseApi: (options?: Record<string, unknown>) => {
      mockRefs.baseApiOptions = options;
      return chain;
    },
  };
});

// The service is intentionally NOT mocked - see file docblock.
const userApiKeyRepository = vi.hoisted(() => ({
  findByUserIdAndId: vi.fn(),
  findByOrganizationIdsAndId: vi.fn().mockResolvedValue(null),
  setCallbackSigningSecret: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository }));
const organizationRepository = vi.hoisted(() => ({ findIdsAdministeredBy: vi.fn().mockResolvedValue([]) }));
vi.mock('@bike4mind/database', () => ({ organizationRepository }));
const logEventSafe = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/utils/analyticsLog', () => ({ logEventSafe }));

import { ApiKeyScope } from '@bike4mind/common';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';
import '@pages/api/user-api-keys/[id]/callback-secret';

function post(id: string | undefined) {
  const { req, res } = createMocks({ method: 'POST', query: id === undefined ? {} : { id }, body: {} });
  (req as any).user = { id: 'admin-user', isAdmin: false };
  (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { req, res };
}

describe('POST /api/user-api-keys/[id]/callback-secret', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userApiKeyRepository.findByOrganizationIdsAndId.mockResolvedValue(null);
    organizationRepository.findIdsAdministeredBy.mockResolvedValue([]);
  });

  it('mints a callbackSigningSecret starting with whsec_ and returns 200', async () => {
    userApiKeyRepository.findByUserIdAndId.mockResolvedValue({
      id: 'key-1',
      name: 'My key',
      userId: 'admin-user',
      scopes: [ApiKeyScope.AI_GENERATE],
    });
    const { req, res } = post('key-1');

    await mockRefs.handler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body.callbackSigningSecret).toMatch(/^whsec_/);
    expect(userApiKeyRepository.setCallbackSigningSecret).toHaveBeenCalledWith(
      'key-1',
      body.callbackSigningSecret,
      expect.any(Date)
    );
  });

  // Real 403 enforcement for a key lacking ai:generate happens in apiKeyAuth,
  // upstream of the handler this mock captures - see file docblock. This proves
  // the route wires the gate at all, the same way rate-limit.test.ts checks
  // meterAsKeyManagement.
  it('gates the route on the ai:generate scope via baseApi requiredScopes', () => {
    expect(mockRefs.baseApiOptions).toMatchObject({ requiredScopes: [ApiKeyScope.AI_GENERATE] });
  });

  it('rejects a missing key id with a 400 BadRequestError and never calls the service', async () => {
    const { req, res } = post(undefined);

    const error = await mockRefs.handler!(req, res).catch(e => e);

    expect(error).toBeInstanceOf(BadRequestError);
    expect(error.statusCode).toBe(400);
    expect(error.message).toMatch(/Invalid key ID/i);
    expect(userApiKeyRepository.findByUserIdAndId).not.toHaveBeenCalled();
  });

  // The no-escalation branch: an API-key caller with absent scopes maps to [] (the
  // route's `req.apiKeyInfo.scopes ?? []`), which denies against ANY scoped target -
  // never falls through to the browser-caller (undefined/unrestricted) branch.
  it('denies an API-key caller with no held scopes against a scoped target (403 Forbidden)', async () => {
    userApiKeyRepository.findByUserIdAndId.mockResolvedValue({
      id: 'key-1',
      name: 'Scoped target',
      userId: 'admin-user',
      scopes: [ApiKeyScope.AI_CHAT],
    });
    const { req, res } = post('key-1');
    (req as any).apiKeyInfo = {}; // scopes absent

    const error = await mockRefs.handler!(req, res).catch(e => e);

    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error.statusCode).toBe(403);
    expect(userApiKeyRepository.setCallbackSigningSecret).not.toHaveBeenCalled();
  });

  it('allows an API-key caller whose held scopes are a superset of the targets', async () => {
    userApiKeyRepository.findByUserIdAndId.mockResolvedValue({
      id: 'key-1',
      name: 'Scoped target',
      userId: 'admin-user',
      scopes: [ApiKeyScope.AI_GENERATE],
    });
    const { req, res } = post('key-1');
    (req as any).apiKeyInfo = { scopes: [ApiKeyScope.AI_GENERATE, ApiKeyScope.READ_FILES] };

    await mockRefs.handler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().callbackSigningSecret).toMatch(/^whsec_/);
  });

  it('skips the escalation check entirely for a browser/JWT caller (no apiKeyInfo)', async () => {
    userApiKeyRepository.findByUserIdAndId.mockResolvedValue({
      id: 'key-1',
      name: 'Any scopes',
      userId: 'admin-user',
      scopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.READ_FILES, ApiKeyScope.WRITE_FILES],
    });
    const { req, res } = post('key-1');

    await mockRefs.handler!(req, res);

    expect(res._getStatusCode()).toBe(200);
  });

  it('propagates a service NotFoundError when the caller did not mint the key', async () => {
    userApiKeyRepository.findByUserIdAndId.mockResolvedValue(null);
    const { req, res } = post('key-1');

    const error = await mockRefs.handler!(req, res).catch(e => e);

    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.statusCode).toBe(404);
  });

  it("refuses (404) an admin of the key's billing org who did not mint it, and mints nothing", async () => {
    // Minting without re-owning would leave the member's receiver trusting a secret only the admin holds.
    userApiKeyRepository.findByUserIdAndId.mockResolvedValue(null);
    userApiKeyRepository.findByOrganizationIdsAndId.mockResolvedValue({
      id: 'key-1',
      name: 'Org embed key',
      userId: 'member-user',
      scopes: [],
    });
    organizationRepository.findIdsAdministeredBy.mockResolvedValue(['org-1']);
    const { req, res } = post('key-1');

    const error = await mockRefs.handler!(req, res).catch(e => e);

    expect(error).toBeInstanceOf(NotFoundError);
    expect(userApiKeyRepository.findByOrganizationIdsAndId).not.toHaveBeenCalled();
    expect(userApiKeyRepository.setCallbackSigningSecret).not.toHaveBeenCalled();
  });

  it('logs the UPDATED event through logEventSafe with the request logger', async () => {
    userApiKeyRepository.findByUserIdAndId.mockResolvedValue({
      id: 'key-1',
      name: 'My key',
      userId: 'admin-user',
      scopes: [ApiKeyScope.AI_GENERATE],
    });
    const { req, res } = post('key-1');

    await mockRefs.handler!(req, res);

    expect(logEventSafe).toHaveBeenCalledWith(expect.anything(), expect.anything(), req.logger);
  });
});
