import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@server/auth/assertOutboundActionAllowed', () => ({
  outboundActionGate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  assertOutboundActionAllowed: async () => undefined,
}));
import { createMocks } from 'node-mocks-http';

/**
 * DELETE /api/organizations/[id]/members (leave) returns the updated org, which
 * is written into the client query cache. It must be routed through
 * toSafeOrganization so a leaving member does not receive billing identifiers.
 */

type RosterHandler = (req: unknown, res: unknown) => unknown;

const mockRefs = vi.hoisted(() => ({
  deleteHandler: null as null | ((req: any, res: any) => unknown),
  getHandler: null as null | RosterHandler,
}));

// Set by the withTransaction mock only after the wrapped callback resolves, so a test can assert the
// notifier saw a committed transaction rather than merely that both were called in some order.
const txState = vi.hoisted(() => ({ committed: false }));

const assertDataLakeShareScope = vi.hoisted(() => vi.fn());
const lakeConfigAuditPrincipal = vi.hoisted(() => vi.fn(() => undefined as unknown));
vi.mock('@bike4mind/server-utils/dataLakes/dataLakeScopes', () => ({
  assertDataLakeShareScope,
  DATA_LAKE_SHARE_SCOPES: ['datalake:share'],
}));
vi.mock('@server/dataLakes/lakeConfigAuditPrincipal', () => ({ lakeConfigAuditPrincipal }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: RosterHandler) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    post: () => chain,
    delete: (fn: any) => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const leave = vi.hoisted(() =>
  vi.fn(async () => ({
    id: 'org1',
    userId: 'owner1',
    name: 'Acme',
    billingContact: 'billing@acme.com',
    stripeCustomerId: 'cus_SECRET',
    users: [],
  }))
);
const reportAndNotifyKeptPersonalLakeShares = vi.hoisted(() => vi.fn().mockResolvedValue(1));
vi.mock('@server/utils/keptPersonalLakeSharesNotifier', () => ({ reportAndNotifyKeptPersonalLakeShares }));
const refreshSeatEntitlements = vi.hoisted(() => vi.fn(async (_userId: string) => ({ committed: txState.committed })));
vi.mock('@server/organizations/refreshSeatEntitlements', () => ({ refreshSeatEntitlements }));
const getRoster = vi.hoisted(() =>
  vi.fn(async () => ({
    organization: {
      id: 'org1',
      userId: 'owner1',
      adminUserIds: ['manager1'],
      users: [
        { userId: 'manager1', permissions: ['read'] },
        { userId: 'member2', permissions: ['read'] },
      ],
    },
    users: [
      { id: 'owner1', name: 'Olive Owner', username: 'olive', email: 'olive@acme.test', isBanned: false },
      { id: 'manager1', name: 'Max Manager', username: 'max', email: 'max@acme.test', isBanned: false },
      { id: 'member2', name: 'Mia Member', username: 'mia', email: 'mia@acme.test', isBanned: true },
    ],
  }))
);
vi.mock('@bike4mind/services', () => ({ organizationService: { leave, getRoster } }));
// A factory must name every export the module graph reaches, or the missing binding throws. The
// lake repos the route passes to the service throw when the handler runs; the audit pair behind
// `lakeConfigAuditDb` throws at IMPORT time, taking the suite to zero tests.
vi.mock('@bike4mind/database', () => ({
  withTransaction: async (fn: any) => {
    const result = await fn();
    txState.committed = true;
    return result;
  },
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  lakeConfigChangeEventRepository: {},
  adminSettingsRepository: {},
}));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: {} }));
const recordOrganizationRead = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@server/utils/orgReadAudit', () => ({ recordOrganizationRead }));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: {}, userApiKeyRepository: {} }));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

import '@pages/api/organizations/[id]/members/index';

describe('DELETE /api/organizations/[id]/members (leave) - safe serialization', () => {
  beforeEach(() => {
    leave.mockClear();
    assertDataLakeShareScope.mockClear();
    assertDataLakeShareScope.mockImplementation(() => {});
    lakeConfigAuditPrincipal.mockClear();
    lakeConfigAuditPrincipal.mockReturnValue(undefined);
  });

  it('strips billing identifiers from the org returned to a leaving member', async () => {
    const { req, res } = createMocks({ method: 'DELETE', query: { id: 'org1' } });
    // A member (not the owner) leaving.
    (req as any).user = { id: 'member2', isAdmin: false };
    (req as any).ability = {};
    await mockRefs.deleteHandler!(req, res);

    const body = res._getJSONData();
    expect(body.name).toBe('Acme');
    expect('stripeCustomerId' in body).toBe(false);
    expect('billingContact' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('cus_SECRET');
  });

  // Leaving expires the member's grants on the org's lakes and can pass ownership of lakes they
  // created to the billing owner. A scope-less route is fail-OPEN, so before this any valid key
  // could do that. In-handler rather than on baseApi() so GET/POST keep their current behaviour.
  it('refuses a key without datalake:share BEFORE any membership write', async () => {
    assertDataLakeShareScope.mockImplementation(() => {
      throw new Error('This API key cannot change who can reach a data lake; datalake:share is required');
    });

    const { req, res } = createMocks({ method: 'DELETE', query: { id: 'org1' } });
    (req as any).user = { id: 'member2', isAdmin: false };
    (req as any).ability = {};
    (req as any).apiKeyInfo = { keyId: 'key-7', scopes: [] };

    await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow('datalake:share');
    expect(leave).not.toHaveBeenCalled();
  });

  it('threads the API-key audit principal and the logger into the departure', async () => {
    // Without the principal the lake audit rows record `principalKind: 'user'` and the key id is
    // lost, so a scripted departure reads as the member clicking Leave themselves.
    lakeConfigAuditPrincipal.mockReturnValue({
      principalKind: 'apiKey',
      principalId: 'key-7',
      onBehalfOfUserId: 'member2',
    });

    const { req, res } = createMocks({ method: 'DELETE', query: { id: 'org1' } });
    const user = { id: 'member2', isAdmin: false };
    const logger = { warn: vi.fn() };
    (req as any).user = user;
    (req as any).ability = {};
    (req as any).apiKeyInfo = { keyId: 'key-7', scopes: ['datalake:share'] };
    (req as any).logger = logger;

    await mockRefs.deleteHandler!(req, res);

    expect(lakeConfigAuditPrincipal).toHaveBeenCalledWith(user, { keyId: 'key-7', scopes: ['datalake:share'] });
    expect(leave).toHaveBeenCalledWith(
      user,
      expect.anything(),
      expect.objectContaining({
        auditPrincipal: { principalKind: 'apiKey', principalId: 'key-7', onBehalfOfUserId: 'member2' },
        logger,
      })
    );
  });
});

describe('DELETE /api/organizations/[id]/members (leave) - personal-lake shares kept', () => {
  beforeEach(() => {
    txState.committed = false;
  });

  it('reports and notifies once after the commit, and returns no count to the leaver', async () => {
    reportAndNotifyKeptPersonalLakeShares.mockClear();
    let committedWhenNotified: boolean | undefined;
    reportAndNotifyKeptPersonalLakeShares.mockImplementationOnce(async () => {
      committedWhenNotified = txState.committed;
      return 1;
    });
    const { req, res } = createMocks({ method: 'DELETE', query: { id: 'org1' } });
    (req as any).user = { id: 'member2', isAdmin: false };
    (req as any).ability = {};

    await mockRefs.deleteHandler!(req, res);

    expect(reportAndNotifyKeptPersonalLakeShares).toHaveBeenCalledTimes(1);
    expect(reportAndNotifyKeptPersonalLakeShares).toHaveBeenCalledWith(
      'member2',
      expect.objectContaining({ id: 'org1', name: 'Acme', userId: 'owner1' }),
      undefined
    );
    expect(committedWhenNotified).toBe(true);
    const body = res._getJSONData();
    expect('personalLakeSharesKept' in body).toBe(false);
  });

  it('never notifies when the service call rejects', async () => {
    reportAndNotifyKeptPersonalLakeShares.mockClear();
    refreshSeatEntitlements.mockClear();
    leave.mockRejectedValueOnce(new Error('boom'));
    const { req, res } = createMocks({ method: 'DELETE', query: { id: 'org1' } });
    (req as any).user = { id: 'member2', isAdmin: false };
    (req as any).ability = {};

    await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow('boom');

    expect(reportAndNotifyKeptPersonalLakeShares).not.toHaveBeenCalled();
    expect(refreshSeatEntitlements).not.toHaveBeenCalled();
  });

  it("refreshes the leaver's seat entitlements after the commit", async () => {
    refreshSeatEntitlements.mockClear();
    const { req, res } = createMocks({ method: 'DELETE', query: { id: 'org1' } });
    Object.assign(req, { user: { id: 'member2', isAdmin: false }, ability: {} });

    await mockRefs.deleteHandler!(req, res);

    expect(refreshSeatEntitlements).toHaveBeenCalledTimes(1);
    expect(refreshSeatEntitlements).toHaveBeenCalledWith('member2');
    await expect(refreshSeatEntitlements.mock.results[0].value).resolves.toEqual({ committed: true });
  });
});

describe('GET /api/organizations/[id]/members - roster visibility by role', () => {
  const fetchRoster = async (user: { id: string; isAdmin?: boolean }) => {
    const { req, res } = createMocks({ method: 'GET', query: { id: 'org1' } });
    Object.assign(req, { user });
    await mockRefs.getHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    return res._getJSONData() as Array<Record<string, unknown>>;
  };

  it.each([
    ['owner', { id: 'owner1' }],
    ['manager', { id: 'manager1' }],
    ['staff (site admin)', { id: 'staff1', isAdmin: true }],
  ])('gives the %s every member with their email', async (_role, user) => {
    const roster = await fetchRoster(user);
    expect(roster.map(member => member.email)).toEqual(['olive@acme.test', 'max@acme.test', 'mia@acme.test']);
  });

  it('gives a plain member names only, with no email anywhere in the response', async () => {
    const roster = await fetchRoster({ id: 'member2' });
    expect(roster.map(member => member.name)).toEqual(['Olive Owner', 'Max Manager', 'Mia Member']);
    for (const member of roster) expect('email' in member).toBe(false);
    expect(JSON.stringify(roster)).not.toContain('@acme.test');
    // The "Deactivated" chip still renders for members.
    expect(roster[2].isBanned).toBe(true);
  });
});

describe('GET /api/organizations/[id]/members - staff read recording', () => {
  beforeEach(() => recordOrganizationRead.mockClear());

  const requestRoster = (user: { id: string; isAdmin?: boolean }) => {
    const { req, res } = createMocks({ method: 'GET', query: { id: 'org1' } });
    Object.assign(req, { user });
    return { req, res };
  };

  it('records the roster read against the organization before responding', async () => {
    const { req, res } = requestRoster({ id: 'staff1', isAdmin: true });
    await mockRefs.getHandler!(req, res);
    expect(recordOrganizationRead).toHaveBeenCalledWith(req, [expect.objectContaining({ id: 'org1' })], {
      view: 'roster',
    });
    expect(res._getStatusCode()).toBe(200);
  });

  it('serves nothing when the read cannot be recorded', async () => {
    recordOrganizationRead.mockRejectedValueOnce(new Error('audit down'));
    const { req, res } = requestRoster({ id: 'staff1', isAdmin: true });
    await expect(mockRefs.getHandler!(req, res)).rejects.toThrow('audit down');
    expect(res._isEndCalled()).toBe(false);
  });

  it('records nothing when the roster read is refused for another organization', async () => {
    getRoster.mockRejectedValueOnce(new Error('Organization with ID org1 not found'));
    const { req, res } = requestRoster({ id: 'outsider' });
    await expect(mockRefs.getHandler!(req, res)).rejects.toThrow('not found');
    expect(recordOrganizationRead).not.toHaveBeenCalled();
    expect(res._isEndCalled()).toBe(false);
  });
});
