import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { IUserDocument } from '@bike4mind/common';
import { createMocks } from 'node-mocks-http';

const queries = vi.hoisted(() => ({
  aggregate: vi.fn(),
  counters: vi.fn(),
  facet: vi.fn(),
  organizations: vi.fn(),
  createOrganization: vi.fn(),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const endpoints: Record<string, (req: Request, res: Response) => unknown> = {};
    const chain = async (req: Request, res: Response) => endpoints[req.method](req, res);
    chain.get = (handler: (typeof endpoints)[string]) => {
      endpoints.GET = handler;
      return chain;
    };
    chain.post = (handler: (typeof endpoints)[string]) => {
      endpoints.POST = handler;
      return chain;
    };
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  applySharedShareableRules: () => {},
  User: class User {
    static modelName = 'User';
    static aggregate = queries.aggregate;
    static populate = vi.fn();
    static hydrate = (value: unknown) => value;
  },
  UserActivityCounter: class UserActivityCounter {
    static modelName = 'UserActivityCounter';
    static find = queries.counters;
  },
  CounterLog: class CounterLog {},
  AdminSettings: class AdminSettings {},
  Session: class Session {
    static find() {
      return { select: () => [] };
    }
  },
  Invite: class Invite {},
  Prompt: class Prompt {},
  FeedbackModel: class FeedbackModel {},
  ModalModel: class ModalModel {},
  Organization: class Organization {},
  FabFile: class FabFile {},
  Project: class Project {},
  Memento: class Memento {},
  QuestMasterPlan: class QuestMasterPlan {},
  executeFacetCompatible: queries.facet,
  convertPipelineForDocumentDB: (value: unknown) => value,
  projectRepository: {},
  organizationRepository: {},
  userRepository: {},
  mongoose: { Types: { ObjectId: class ObjectId {} } },
}));
vi.mock('@bike4mind/database/infra', () => ({ SecretRotation: class SecretRotation {} }));
vi.mock('@server/models/Subscription', () => ({ Subscription: class Subscription {} }));
vi.mock('@bike4mind/services', () => ({
  organizationService: { search: queries.organizations, create: queries.createOrganization },
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn(async () => null) }));
vi.mock('@server/users/sharedWorkspaceUserIds', () => ({ findSharedWorkspaceUserIds: vi.fn() }));
vi.mock('@server/users/pendingProjectInviteeIds', () => ({ findPendingProjectInviteeIds: vi.fn() }));
import defineAbilitiesFor from './ability';
import directory from '../../pages/api/users/index';
import tags from '../../pages/api/users/tags';
import counters from '../../pages/api/users/[id]/activities/index';
import organizations from '../../pages/api/organizations/index';
import { User, UserActivityCounter, CounterLog } from '@bike4mind/database';

const reader = {
  id: 'support',
  isAdmin: false,
  adminPermissions: ['support:read'],
  groups: [],
  tags: [],
} as unknown as IUserDocument;
const invoke = async (handler: unknown, query: Record<string, string> = {}) => {
  const { req, res } = createMocks<Request, Response>({ method: 'GET', query });
  req.user = reader;
  req.ability = defineAbilitiesFor(reader);
  await (handler as (req: Request, res: Response) => Promise<unknown>)(req, res);
  return res;
};
beforeEach(() => {
  vi.clearAllMocks();
  queries.facet.mockResolvedValue([{ totalCount: [{ count: 0 }], paginatedResults: [] }]);
  queries.aggregate.mockResolvedValue([{ tag: 'Customer' }]);
  queries.counters.mockResolvedValue([{ userId: 'another-user', count: 3 }]);
  queries.organizations.mockResolvedValue({ data: [], total: 0 });
});
describe('delegated support user directory reads', () => {
  it('loads the default admin directory through the real read ability', async () => {
    const response = await invoke(directory);
    expect(response._getStatusCode()).toBe(200);
    expect(queries.facet).toHaveBeenCalledOnce();
    expect(JSON.stringify(queries.facet.mock.calls[0])).toContain('adminPermissions');
  });
  it('loads user tag filters through the real read ability', async () => {
    const response = await invoke(tags);
    expect(response._getJSONData()).toEqual({ tags: ['Customer'] });
    expect(queries.aggregate).toHaveBeenCalledOnce();
  });
  it('reads the requested other user activity counters', async () => {
    const response = await invoke(counters, { id: 'another-user' });
    expect(response._getJSONData()).toEqual([{ userId: 'another-user', count: 3 }]);
    expect(queries.counters.mock.calls[0][0]).toMatchObject({ userId: 'another-user' });
  });
  it('loads cross-organization filters while preserving the actual user identity', async () => {
    const response = await invoke(organizations);
    expect(response._getStatusCode()).toBe(200);
    expect(queries.organizations.mock.calls[0][1].filters?.userId).toBeUndefined();
    expect(queries.organizations.mock.calls[0][0].isAdmin).toBe(false);
  });
  it('grants read abilities without granting cross-user writes', () => {
    const ability = defineAbilitiesFor(reader);
    expect(ability.can('read', User)).toBe(true);
    expect(ability.can('read', CounterLog)).toBe(true);
    expect(ability.can('read', Object.assign(new UserActivityCounter(), { userId: 'other' }))).toBe(true);
    expect(ability.can('update', User)).toBe(false);
    expect(ability.can('delete', User)).toBe(false);
    expect(ability.can('update', Object.assign(new UserActivityCounter(), { userId: 'other' }))).toBe(false);
  });
  it('organization creation accepts settings permission and rejects support and unrelated API key scopes', async () => {
    const user: IUserDocument = { ...reader, adminPermissions: ['settings:manage'] };
    const makeRequest = (identity: IUserDocument, apiKeyScopes?: string[]) => {
      const { req, res } = createMocks<Request, Response>({ method: 'POST', body: { name: 'Organization' } });
      req.user = identity;
      if (apiKeyScopes) Object.assign(req, { apiKeyInfo: { scopes: apiKeyScopes } });
      req.logger = { info: vi.fn(), error: vi.fn() } as Request['logger'];
      return { req, res };
    };
    queries.createOrganization.mockResolvedValue({ id: 'org-new', userId: user.id, name: 'Organization' });
    const granted = makeRequest(user);
    await (organizations as unknown as (req: Request, res: Response) => Promise<unknown>)(granted.req, granted.res);
    expect(granted.res._getStatusCode()).toBe(201);
    expect(queries.createOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ isAdmin: false }),
      expect.anything(),
      expect.anything()
    );

    const support = makeRequest(reader);
    await expect(
      (organizations as unknown as (req: Request, res: Response) => Promise<unknown>)(support.req, support.res)
    ).rejects.toThrow('Missing permission: settings:manage');
    const narrowKey = makeRequest(user, ['files:read']);
    await expect(
      (organizations as unknown as (req: Request, res: Response) => Promise<unknown>)(narrowKey.req, narrowKey.res)
    ).rejects.toThrow('API key permissions');
  });
});
