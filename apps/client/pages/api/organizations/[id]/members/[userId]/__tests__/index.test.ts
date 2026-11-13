import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * DELETE /api/organizations/[id]/members/[userId] (admin removal).
 *
 * Removing a member expires their data-lake grants on the org's lakes and can mint an owner grant
 * for the billing owner, so this route now changes who can reach a data lake. Two things follow and
 * both are pinned here: the route must carry `datalake:share` (a scope-less `baseApi()` is
 * fail-OPEN - any valid key satisfied it), and a key-driven removal must be attributed to the KEY
 * rather than recorded as the admin acting directly.
 */

const mockRefs = vi.hoisted(() => ({
  deleteHandler: null as null | ((req: any, res: any) => unknown),
  baseApiOptions: undefined as unknown,
}));

// Set by the withTransaction mock only after the wrapped callback resolves, so a test can assert the
// notifier saw a committed transaction rather than merely that both were called in some order.
// `staged` collects the writes a callback makes; they reach `persisted` only if the callback resolves,
// which is how the real transaction behaves when any step throws.
const txState = vi.hoisted(() => ({ committed: false, staged: [] as string[], persisted: [] as string[] }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: () => chain,
    post: () => chain,
    delete: (fn: any) => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return {
    baseApi: (options?: unknown) => {
      mockRefs.baseApiOptions = options;
      return chain;
    },
  };
});

const revokeAccess = vi.hoisted(() =>
  vi.fn(async () => {
    txState.staged.push('revoke');
    return {
      organization: { id: 'org1', userId: 'owner1', name: 'Acme', stripeCustomerId: 'cus_SECRET', users: [] },
      revokedOrgBilledApiKeyIds: ['key-1', 'key-2'],
    };
  })
);
const reassignedCounts = { files: 2, artifacts: 1, projects: 1, notebooks: 3, agents: 0 };
const reassignMemberContent = vi.hoisted(() =>
  vi.fn(async (): Promise<Record<string, number>> => {
    txState.staged.push('reassign');
    return reassignedCounts;
  })
);
const recordAdminActionFromRequest = vi.hoisted(() =>
  vi.fn(async () => {
    if (txState.committed) throw new Error('audit written outside the transaction');
    return {};
  })
);
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  recordAdminActionFromRequest,
  userAuditTarget: async (id: string) => ({ kind: 'user', id, displayName: 'Member Two' }),
}));
const reportAndNotifyKeptPersonalLakeShares = vi.hoisted(() => vi.fn().mockResolvedValue(2));
vi.mock('@server/utils/keptPersonalLakeSharesNotifier', () => ({ reportAndNotifyKeptPersonalLakeShares }));
vi.mock('@bike4mind/services', () => ({ organizationService: { revokeAccess, reassignMemberContent } }));

const lakeConfigAuditPrincipal = vi.hoisted(() => vi.fn(() => undefined as unknown));
vi.mock('@server/dataLakes/lakeConfigAuditPrincipal', () => ({ lakeConfigAuditPrincipal }));
vi.mock('@bike4mind/server-utils/dataLakes/dataLakeScopes', () => ({
  DATA_LAKE_SHARE_SCOPES: ['datalake:share'],
  assertDataLakeShareScope: vi.fn(),
}));

// A factory must name every export the module graph reaches, or the missing binding throws. The
// audit pair behind `lakeConfigAuditDb` throws at IMPORT time, taking the suite to zero tests.
vi.mock('@bike4mind/database', () => ({
  withTransaction: async (fn: any) => {
    txState.staged = [];
    const result = await fn();
    txState.persisted.push(...txState.staged);
    txState.committed = true;
    return result;
  },
  dataLakeRepository: {},
  agentRepository: {},
  artifactRepository: {},
  fabFileRepository: {},
  projectRepository: {},
  sessionRepository: {},
  dataLakeAccessGrantRepository: {},
  lakeConfigChangeEventRepository: {},
  adminSettingsRepository: {},
}));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: {} }));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: {}, userApiKeyRepository: {} }));
vi.mock('@bike4mind/database/social', () => ({ groupRepository: {} }));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

import '@pages/api/organizations/[id]/members/[userId]/index';

const request = (over: Record<string, unknown> = {}) => {
  const { req, res } = createMocks({ method: 'DELETE', query: { id: 'org1', userId: 'member2' } });
  (req as any).user = { id: 'owner1', isAdmin: false };
  (req as any).ability = {};
  Object.assign(req as any, over);
  return { req, res };
};

beforeEach(() => {
  txState.committed = false;
  txState.staged = [];
  txState.persisted = [];
});

describe('DELETE /api/organizations/[id]/members/[userId]', () => {
  beforeEach(() => {
    revokeAccess.mockClear();
    lakeConfigAuditPrincipal.mockClear();
    lakeConfigAuditPrincipal.mockReturnValue(undefined);
  });

  it('declares datalake:share at the door', () => {
    expect(mockRefs.baseApiOptions).toEqual({ requiredScopes: ['datalake:share'] });
  });

  it('attributes a key-driven removal to the KEY, keeping the human findable', async () => {
    lakeConfigAuditPrincipal.mockReturnValue({
      principalKind: 'apiKey',
      principalId: 'key-7',
      onBehalfOfUserId: 'owner1',
    });
    const logger = { warn: vi.fn() };
    const apiKeyInfo = { keyId: 'key-7', scopes: ['datalake:share'] };
    const { req, res } = request({ apiKeyInfo, logger });

    await mockRefs.deleteHandler!(req, res);

    expect(lakeConfigAuditPrincipal).toHaveBeenCalledWith((req as any).user, apiKeyInfo);
    expect(revokeAccess).toHaveBeenCalledWith(
      (req as any).user,
      expect.objectContaining({ userId: 'member2' }),
      expect.objectContaining({
        auditPrincipal: { principalKind: 'apiKey', principalId: 'key-7', onBehalfOfUserId: 'owner1' },
        logger,
      })
    );
  });

  it('passes no audit principal for a session caller, leaving the default derivation in place', async () => {
    const { req, res } = request();

    await mockRefs.deleteHandler!(req, res);

    expect(revokeAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ auditPrincipal: undefined })
    );
  });

  it('records the removal as an org-scoped audit row inside the transaction', async () => {
    recordAdminActionFromRequest.mockClear();
    const { req, res } = request();

    await mockRefs.deleteHandler!(req, res);

    expect(recordAdminActionFromRequest).toHaveBeenCalledTimes(1);
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'org.member.removed',
        actorScope: 'organization',
        target: expect.objectContaining({ kind: 'user', id: 'member2' }),
        organizationId: 'org1',
        details: { organizationName: 'Acme', revokedOrgBilledKeys: 2 },
      })
    );
    expect(res._getJSONData().revokedOrgBilledKeys).toBe(2);
  });

  it('passes the API-key repository so the purge can revoke org-billed keys', async () => {
    const { req, res } = request();

    await mockRefs.deleteHandler!(req, res);

    expect(revokeAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ db: expect.objectContaining({ userApiKeys: expect.anything() }) })
    );
  });

  it('strips billing identifiers from the org it returns', async () => {
    const { req, res } = request();

    await mockRefs.deleteHandler!(req, res);

    const body = res._getJSONData();
    expect(body.name).toBe('Acme');
    expect('stripeCustomerId' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('cus_SECRET');
  });
});

describe('DELETE /api/organizations/[id]/members/[userId] - personal-lake shares kept', () => {
  it('reports and notifies once after the commit, and tells the admin only how many shares were kept', async () => {
    reportAndNotifyKeptPersonalLakeShares.mockClear();
    let committedWhenNotified: boolean | undefined;
    reportAndNotifyKeptPersonalLakeShares.mockImplementationOnce(async () => {
      committedWhenNotified = txState.committed;
      return 2;
    });
    const { req, res } = request();

    await mockRefs.deleteHandler!(req, res);

    expect(reportAndNotifyKeptPersonalLakeShares).toHaveBeenCalledTimes(1);
    expect(reportAndNotifyKeptPersonalLakeShares).toHaveBeenCalledWith(
      'member2',
      expect.objectContaining({ id: 'org1', name: 'Acme', userId: 'owner1' }),
      undefined
    );
    expect(committedWhenNotified).toBe(true);
    const body = res._getJSONData();
    expect(body.personalLakeSharesKept).toBe(2);
  });

  it('never notifies when the service call rejects', async () => {
    reportAndNotifyKeptPersonalLakeShares.mockClear();
    revokeAccess.mockRejectedValueOnce(new Error('boom'));
    const { req, res } = request();

    await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow('boom');

    expect(reportAndNotifyKeptPersonalLakeShares).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/organizations/[id]/members/[userId] - content transfer', () => {
  beforeEach(() => {
    revokeAccess.mockClear();
    reassignMemberContent.mockClear();
    recordAdminActionFromRequest.mockClear();
  });

  it('keeps content with the member when no target is given', async () => {
    const { req, res } = request();

    await mockRefs.deleteHandler!(req, res);

    expect(reassignMemberContent).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).toHaveBeenCalledTimes(1);
    expect(res._getJSONData().reassigned).toBeNull();
  });

  it('treats an empty body as a plain removal', async () => {
    const { req, res } = request({ body: '' });

    await mockRefs.deleteHandler!(req, res);

    expect(reassignMemberContent).not.toHaveBeenCalled();
    expect(revokeAccess).toHaveBeenCalledTimes(1);
  });

  it('transfers before revoking, in one transaction, and audits both', async () => {
    const { req, res } = request({ body: { reassignTo: 'member3' } });

    await mockRefs.deleteHandler!(req, res);

    expect(reassignMemberContent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'owner1' }),
      { id: 'org1', userId: 'member2', reassignTo: 'member3' },
      expect.objectContaining({ db: expect.objectContaining({ fabFiles: expect.anything() }) })
    );
    expect(txState.persisted).toEqual(['reassign', 'revoke']);
    expect(recordAdminActionFromRequest).toHaveBeenCalledTimes(2);
    expect(recordAdminActionFromRequest).toHaveBeenLastCalledWith(
      req,
      expect.objectContaining({
        action: 'org.member.content_reassigned',
        actorScope: 'organization',
        target: expect.objectContaining({ kind: 'user', id: 'member2' }),
        organizationId: 'org1',
        details: { organizationName: 'Acme', toUserId: 'member3', counts: reassignedCounts },
      })
    );
    expect(res._getJSONData().reassigned).toEqual(reassignedCounts);
  });

  it('records no content_reassigned audit when nothing moved', async () => {
    reassignMemberContent.mockImplementationOnce(async () => {
      txState.staged.push('reassign');
      return { files: 0, artifacts: 0, projects: 0, notebooks: 0, agents: 0 };
    });
    const { req, res } = request({ body: { reassignTo: 'member3' } });

    await mockRefs.deleteHandler!(req, res);

    expect(recordAdminActionFromRequest).toHaveBeenCalledTimes(1);
    expect(recordAdminActionFromRequest).not.toHaveBeenCalledWith(
      req,
      expect.objectContaining({ action: 'org.member.content_reassigned' })
    );
    expect(res._getJSONData().reassigned).toMatchObject({ files: 0 });
  });

  it('rolls back the removal when the transfer fails', async () => {
    reassignMemberContent.mockImplementationOnce(async () => {
      txState.staged.push('reassign');
      throw new Error('transfer failed');
    });
    const { req, res } = request({ body: { reassignTo: 'member3' } });

    await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow('transfer failed');

    expect(revokeAccess).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
    expect(txState.persisted).toEqual([]);
  });

  it('rolls back the transfer when the removal or its audit fails', async () => {
    recordAdminActionFromRequest.mockRejectedValueOnce(new Error('audit down'));
    const { req, res } = request({ body: { reassignTo: 'member3' } });

    await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow('audit down');

    expect(reassignMemberContent).toHaveBeenCalledTimes(1);
    expect(txState.persisted).toEqual([]);
  });

  it.each([
    ['an empty target', { reassignTo: '' }],
    ['an unknown field', { reassignTo: 'member3', moveKeys: true }],
    ['a non-object body', 'member3'],
  ])('rejects %s before touching anything', async (_label, body) => {
    const { req, res } = request({ body });

    await expect(mockRefs.deleteHandler!(req, res)).rejects.toMatchObject({ statusCode: 400 });

    expect(reassignMemberContent).not.toHaveBeenCalled();
    expect(revokeAccess).not.toHaveBeenCalled();
  });

  it('refuses a transfer requested with an API key', async () => {
    const { req, res } = request({
      body: { reassignTo: 'member3' },
      apiKeyInfo: { keyId: 'key-7', scopes: ['datalake:share'] },
    });

    await expect(mockRefs.deleteHandler!(req, res)).rejects.toMatchObject({ statusCode: 403 });

    expect(reassignMemberContent).not.toHaveBeenCalled();
    expect(revokeAccess).not.toHaveBeenCalled();
  });
});
