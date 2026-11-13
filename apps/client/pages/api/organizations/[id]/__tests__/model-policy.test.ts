import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ADMIN_AUDIT_CATALOGUE } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { organizationLifecycleAuditActions } from '@bike4mind/server-utils/utils/organizationAudit';

type Handler = (req: unknown, res: unknown) => unknown;
type RouteChain = Record<'get' | 'put' | 'delete', (handler: Handler) => RouteChain>;
const mockRefs = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  baseApiOptions: [] as unknown[],
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    mockRefs.baseApiOptions.push(options);
    const register =
      (method: keyof RouteChain) =>
      (handler: Handler): RouteChain => {
        mockRefs.handlers[method] = handler;
        return chain;
      };
    const chain: RouteChain = { get: register('get'), put: register('put'), delete: register('delete') };
    return chain;
  },
}));

const verifyOrgAccess = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/server-utils/utils/orgAccess', () => ({ verifyOrgAccess }));
const recordAdminActionFromRequest = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest }));
const organizationRepository = vi.hoisted(() => ({ findById: vi.fn(), update: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ organizationRepository }));

await import('@pages/api/organizations/[id]/model-policy');

const UNRESTRICTED = { allowedProviders: null, allowedModels: null, allowedTools: null };
let stored: Record<string, unknown> | undefined;
const org = () => ({ id: 'org1', name: 'Acme', userId: 'owner1', users: [], modelPolicy: stored });

const call = async (method: 'get' | 'put' | 'delete', body?: unknown) => {
  const { req, res } = createMocks({ method: method.toUpperCase() as 'GET', query: { id: 'org1' }, body });
  Object.assign(req, { user: { id: 'manager1', isAdmin: false } });
  await mockRefs.handlers[method]!(req, res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  stored = undefined;
  verifyOrgAccess.mockImplementation(async () => org());
  organizationRepository.findById.mockImplementation(async () => org());
  organizationRepository.update.mockImplementation(async (data: { modelPolicy?: Record<string, unknown> }, opts) => {
    if (opts?.unset?.includes('modelPolicy')) stored = undefined;
    else stored = data.modelPolicy;
    return org();
  });
});

describe('/api/organizations/[id]/model-policy', () => {
  it('accepts a session only, never an API key', () => {
    expect(mockRefs.baseApiOptions).toEqual([{ auth: 'jwtOnly' }]);
  });

  it.each([
    ['get', undefined],
    ['put', { allowedTools: [] }],
    ['delete', undefined],
  ] as const)('%s is limited to owners and managers, and a refusal changes nothing', async (method, body) => {
    verifyOrgAccess.mockRejectedValue(new NotFoundError('Organization not found'));
    await expect(call(method, body)).rejects.toThrow('Organization not found');
    expect(verifyOrgAccess).toHaveBeenCalledWith(expect.objectContaining({ id: 'manager1' }), 'org1');
    expect(organizationRepository.update).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('GET returns an unrestricted policy for an org without one', async () => {
    const res = await call('get');
    expect(res._getJSONData()).toEqual({ policy: UNRESTRICTED, invalidStored: false });
  });

  it('GET flags a stored row that no longer parses', async () => {
    stored = { allowedProviders: [] };
    const res = await call('get');
    expect(res._getJSONData()).toEqual({ policy: UNRESTRICTED, invalidStored: true });
  });

  it.each([
    [{ allowedProviders: ['not-a-provider'] }],
    [{ allowedTools: ['not_a_tool'] }],
    [{ allowedProviders: [] }],
    [{ allowedModels: [] }],
    [{ allowedTools: [], extra: true }],
  ])('PUT refuses %j with a 400 and writes nothing', async body => {
    await expect(call('put', body)).rejects.toMatchObject({ statusCode: 400 });
    expect(organizationRepository.update).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('PUT stores only the restricted lists and audits just the changed fields', async () => {
    stored = { allowedModels: ['gpt-4o'] };
    const res = await call('put', { allowedProviders: ['openai'], allowedModels: ['gpt-4o'], allowedTools: [] });

    expect(organizationRepository.update).toHaveBeenCalledWith({
      id: 'org1',
      modelPolicy: { allowedProviders: ['openai'], allowedModels: ['gpt-4o'], allowedTools: [] },
    });
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'org.model_policy.updated',
        actorScope: 'organization',
        target: { kind: 'organization', id: 'org1', displayName: 'Acme' },
        changes: [
          { field: 'allowedProviders', before: null, after: ['openai'] },
          { field: 'allowedTools', before: null, after: [] },
        ],
      })
    );
    expect(res._getJSONData()).toEqual({
      policy: { allowedProviders: ['openai'], allowedModels: ['gpt-4o'], allowedTools: [] },
      invalidStored: false,
    });
  });

  it('PUT with the same lists in another order writes nothing and records no audit', async () => {
    stored = { allowedProviders: ['openai', 'anthropic'] };
    await call('put', { allowedProviders: ['anthropic', 'openai'] });
    expect(organizationRepository.update).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('PUT over an unreadable stored row audits only the fields the new policy sets', async () => {
    stored = { allowedProviders: [] };
    await call('put', { allowedModels: ['gpt-4o'] });
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ changes: [{ field: 'allowedModels', before: null, after: ['gpt-4o'] }] })
    );
  });

  it('PUT replacing an unreadable stored row with no restriction still writes and audits', async () => {
    stored = { allowedProviders: [] };
    await call('put', {});
    expect(organizationRepository.update).toHaveBeenCalledWith({ id: 'org1' }, { unset: ['modelPolicy'] });
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ changes: [] })
    );
  });

  it('PUT of an all-unrestricted policy removes the stored field', async () => {
    stored = { allowedTools: ['web_search'] };
    await call('put', {});
    expect(organizationRepository.update).toHaveBeenCalledWith({ id: 'org1' }, { unset: ['modelPolicy'] });
    expect(stored).toBeUndefined();
  });

  it('DELETE resets to unrestricted and audits only when a policy existed', async () => {
    stored = { allowedTools: ['web_search'] };
    const res = await call('delete');
    expect(organizationRepository.update).toHaveBeenCalledWith({ id: 'org1' }, { unset: ['modelPolicy'] });
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ changes: [{ field: 'allowedTools', before: ['web_search'], after: null }] })
    );
    expect(res._getJSONData()).toEqual({ policy: UNRESTRICTED, invalidStored: false });

    vi.clearAllMocks();
    await call('delete');
    expect(organizationRepository.update).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('is catalogued for the admin audit and surfaces as policy.updated in the org audit', () => {
    expect(ADMIN_AUDIT_CATALOGUE['org.model_policy.updated']).toMatchObject({ category: 'org', severity: 'notice' });
    expect(organizationLifecycleAuditActions['org.model_policy.updated']).toBe('policy.updated');
  });
});
