import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { CustomMcpPolicySchema } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';

/**
 * /api/organizations/[id]/custom-mcp/{policy,connections}. The policy logic is orgPolicy.test.ts;
 * this pins the routes' own contract: who may call them, body validation, and the audit record.
 */

type Handler = (req: unknown, res: unknown) => unknown;
type RouteChain = Record<'get' | 'put' | 'delete', (handler: Handler) => RouteChain>;
const mockRefs = vi.hoisted(() => ({
  handlers: {} as Record<string, Record<string, Handler>>,
  current: '' as string,
  baseApiOptions: [] as unknown[],
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    mockRefs.baseApiOptions.push(options);
    const route = (mockRefs.handlers[mockRefs.current] = {} as Record<string, Handler>);
    const register =
      (method: keyof RouteChain) =>
      (handler: Handler): RouteChain => {
        route[method] = handler;
        return chain;
      };
    const chain: RouteChain = { get: register('get'), put: register('put'), delete: register('delete') };
    return chain;
  },
}));

const verifyOrgAccess = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/orgAccess', () => ({ verifyOrgAccess }));
const recordAdminActionFromRequest = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest }));

const orgPolicy = vi.hoisted(() => ({
  getOrgCustomMcpPolicy: vi.fn(),
  readOrgCustomMcpPolicyOverride: vi.fn(),
  setOrgCustomMcpPolicy: vi.fn(),
  resetOrgCustomMcpPolicy: vi.fn(),
  listOrgMemberConnections: vi.fn(),
}));
vi.mock('@server/mcpConnections/orgPolicy', () => orgPolicy);

mockRefs.current = 'policy';
await import('@pages/api/organizations/[id]/custom-mcp/policy');
mockRefs.current = 'connections';
await import('@pages/api/organizations/[id]/custom-mcp/connections');

const ORG = { id: 'org1', name: 'Acme', userId: 'owner1', users: [] };
const VIEW = {
  policy: CustomMcpPolicySchema.parse({}),
  overridden: true,
  invalidOverride: false,
  platformEnabled: true,
};

const call = async (route: string, method: string, body?: unknown) => {
  const { req, res } = createMocks({ method: method.toUpperCase() as 'GET', query: { id: 'org1' }, body });
  Object.assign(req, { user: { id: 'manager1', isAdmin: false } });
  await mockRefs.handlers[route]![method]!(req, res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  verifyOrgAccess.mockResolvedValue(ORG);
  orgPolicy.getOrgCustomMcpPolicy.mockResolvedValue(VIEW);
  orgPolicy.readOrgCustomMcpPolicyOverride.mockResolvedValue(null);
  orgPolicy.setOrgCustomMcpPolicy.mockImplementation(async (_id: string, policy: unknown) => JSON.stringify(policy));
  orgPolicy.listOrgMemberConnections.mockResolvedValue([]);
});

describe('custom-mcp org routes', () => {
  it('accept a session only, never an API key', () => {
    expect(mockRefs.baseApiOptions).toEqual([{ auth: 'jwtOnly' }, { auth: 'jwtOnly' }]);
  });

  it.each([
    ['policy', 'get', undefined],
    ['policy', 'put', { mode: 'off' }],
    ['policy', 'delete', undefined],
    ['connections', 'get', undefined],
  ])('%s %s is limited to owners and managers, and a refusal changes nothing', async (route, method, body) => {
    verifyOrgAccess.mockRejectedValue(new NotFoundError('Organization not found'));
    await expect(call(route, method, body)).rejects.toThrow('Organization not found');

    expect(verifyOrgAccess).toHaveBeenCalledWith(expect.objectContaining({ id: 'manager1' }), 'org1');
    expect(orgPolicy.setOrgCustomMcpPolicy).not.toHaveBeenCalled();
    expect(orgPolicy.resetOrgCustomMcpPolicy).not.toHaveBeenCalled();
    expect(orgPolicy.listOrgMemberConnections).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('GET policy returns the org view', async () => {
    const res = await call('policy', 'get');
    expect(orgPolicy.getOrgCustomMcpPolicy).toHaveBeenCalledWith('org1');
    expect(res._getJSONData()).toEqual(VIEW);
  });

  it('PUT policy turns connectors off and audits before and after', async () => {
    orgPolicy.readOrgCustomMcpPolicyOverride.mockResolvedValue('{"mode":"any"}');
    const res = await call('policy', 'put', { mode: 'off', requireApprovalForAll: true });

    const stored = CustomMcpPolicySchema.parse({ mode: 'off', requireApprovalForAll: true });
    expect(orgPolicy.setOrgCustomMcpPolicy).toHaveBeenCalledWith('org1', stored);
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'org.custom_mcp_policy.updated',
        actorScope: 'organization',
        target: { kind: 'organization', id: 'org1', displayName: 'Acme' },
        changes: [{ field: 'customMcpPolicy', before: '{"mode":"any"}', after: JSON.stringify(stored) }],
      })
    );
    expect(res._getJSONData()).toEqual(VIEW);
  });

  it('PUT policy with an unchanged value writes no audit record', async () => {
    const stored = JSON.stringify(CustomMcpPolicySchema.parse({}));
    orgPolicy.readOrgCustomMcpPolicyOverride.mockResolvedValue(stored);
    await call('policy', 'put', {});
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('PUT policy treats a stored override missing defaulted fields as unchanged', async () => {
    orgPolicy.readOrgCustomMcpPolicyOverride.mockResolvedValue('{"mode":"off"}');
    await call('policy', 'put', { mode: 'off' });
    expect(orgPolicy.setOrgCustomMcpPolicy).toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it.each([[{ mode: 'wide_open' }], [{ maxConnectionsPerUser: 500 }], [{ mode: 'off', unknownField: true }]])(
    'PUT policy refuses %j with a 400 and writes nothing',
    async body => {
      await expect(call('policy', 'put', body)).rejects.toMatchObject({ statusCode: 400 });
      expect(orgPolicy.setOrgCustomMcpPolicy).not.toHaveBeenCalled();
    }
  );

  it('DELETE policy resets to the platform default and audits only when an override existed', async () => {
    orgPolicy.readOrgCustomMcpPolicyOverride.mockResolvedValue('{"mode":"off"}');
    await call('policy', 'delete');
    expect(orgPolicy.resetOrgCustomMcpPolicy).toHaveBeenCalledWith('org1');
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ changes: [{ field: 'customMcpPolicy', before: '{"mode":"off"}', after: null }] })
    );

    vi.clearAllMocks();
    verifyOrgAccess.mockResolvedValue(ORG);
    orgPolicy.readOrgCustomMcpPolicyOverride.mockResolvedValue(null);
    await call('policy', 'delete');
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('GET connections lists member connections under the resolved org policy', async () => {
    const listed = [{ id: 'c1' }];
    orgPolicy.listOrgMemberConnections.mockResolvedValue(listed);
    const res = await call('connections', 'get');
    expect(orgPolicy.listOrgMemberConnections).toHaveBeenCalledWith(ORG, VIEW);
    expect(res._getJSONData()).toEqual(listed);
  });
});
