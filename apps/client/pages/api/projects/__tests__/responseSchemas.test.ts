import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => unknown;
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
interface BaseApiChain {
  use: () => BaseApiChain;
  get: (...fns: Handler[]) => BaseApiChain;
  post: (...fns: Handler[]) => BaseApiChain;
  put: (...fns: Handler[]) => BaseApiChain;
  delete: (...fns: Handler[]) => BaseApiChain;
}

const registry = vi.hoisted(() => ({
  handlers: {} as Partial<Record<string, (req: unknown, res: unknown) => unknown>>,
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: BaseApiChain = {
      use: () => chain,
      get: (...fns) => ((registry.handlers.GET = fns[fns.length - 1]), chain),
      post: (...fns) => ((registry.handlers.POST = fns[fns.length - 1]), chain),
      put: (...fns) => ((registry.handlers.PUT = fns[fns.length - 1]), chain),
      delete: (...fns) => ((registry.handlers.DELETE = fns[fns.length - 1]), chain),
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: Handler) => fn,
}));
vi.mock('@server/projects/projectScopes', () => ({
  assertProjectsReadScope: vi.fn(),
  assertProjectsWriteScope: vi.fn(),
  PROJECTS_READ_OR_WRITE_SCOPES: [],
  PROJECTS_WRITE_SCOPES: [],
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock('@server/utils/eventBus', () => ({ SessionEvents: { Summarize: { publish: vi.fn() } } }));
vi.mock('@server/utils/sessionOperationalCreditPreflight', () => ({
  filterSessionIdsByOperationalCredits: vi.fn(async () => new Set<string>()),
}));
vi.mock('@bike4mind/services/userService/accountState', () => ({ isAiAccessRevoked: () => false }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({ getFilesStorage: () => undefined }));

// A project and a file as the repositories return them: every persisted field, plus one the
// response schemas do not declare and a populated `user` on a share row.
const UNDECLARED = 'internal-only-value';
const project = {
  id: 'p1',
  name: 'Project',
  description: 'desc',
  userId: 'u1',
  sessionIds: [],
  fileIds: [],
  systemPrompts: [],
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
  isGlobalRead: false,
  isGlobalWrite: false,
  // projectId: null stands in for a legacy value the boundary must pass through, not 500 on.
  users: [{ userId: 'u1', permissions: ['read'], projectId: null, user: { passwordHash: UNDECLARED } }],
  groups: [{ groupId: 'g1', permissions: ['read'], internalGroupNote: UNDECLARED }],
  internalNote: UNDECLARED,
};
const file = {
  id: 'f1',
  userId: 'u1',
  fileName: 'a.txt',
  fileSize: 3,
  mimeType: 'text/plain',
  type: 'text',
  isGlobalRead: false,
  isGlobalWrite: false,
  users: [{ userId: 'u1', permissions: ['read'], user: { passwordHash: UNDECLARED } }],
  groups: [],
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
  internalNote: UNDECLARED,
};

const projectService = vi.hoisted(() => ({
  createProject: vi.fn(),
  get: vi.fn(),
  leaveProject: vi.fn(),
  removeSessions: vi.fn(),
  listFiles: vi.fn(),
  addFiles: vi.fn(),
  removeFiles: vi.fn(),
  addSystemPrompts: vi.fn(),
  removeSystemPrompts: vi.fn(),
  toggleSystemPrompt: vi.fn(),
  removeNonExistentFiles: vi.fn(),
}));
vi.mock('@bike4mind/services', () => ({ projectService }));
vi.mock('@server/sharing/revokedFileReferences', () => ({
  projectRevokeCleanupTargets: vi.fn(async () => []),
  cleanUpRevokedFileReferences: vi.fn(async () => {}),
}));
vi.mock('@bike4mind/database', () => ({
  Project: class Project {},
  projectRepository: { find: vi.fn(async () => [{ id: 'p1', name: 'Project' }]) },
  fabFileRepository: {},
  sessionRepository: {},
  userRepository: {},
  inviteRepository: {},
  activityRepository: { createActivity: vi.fn(async () => {}) },
  withTransaction: (fn: () => unknown) => fn(),
}));

interface Case {
  route: string;
  method: Method;
  load: () => Promise<unknown>;
  service: keyof typeof projectService;
  returns: unknown;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  pick?: (json: Record<string, unknown> | Record<string, unknown>[]) => Record<string, unknown>;
}

const firstOf = (json: Record<string, unknown> | Record<string, unknown>[]) => (Array.isArray(json) ? json[0] : json);
const firstUpdatedProject = (json: Record<string, unknown> | Record<string, unknown>[]) =>
  (json as { updatedProjects: Record<string, unknown>[] }).updatedProjects[0];

const cases: Case[] = [
  {
    route: 'POST /api/projects',
    method: 'POST',
    load: () => import('@pages/api/projects/index'),
    service: 'createProject',
    returns: project,
    body: { name: 'Project' },
  },
  {
    route: 'GET /api/projects/[id]',
    method: 'GET',
    load: () => import('@pages/api/projects/[id]/index'),
    service: 'get',
    returns: project,
    query: { id: 'p1' },
  },
  {
    route: 'DELETE /api/projects/[id]/members',
    method: 'DELETE',
    load: () => import('@pages/api/projects/[id]/members'),
    service: 'leaveProject',
    returns: project,
    query: { id: 'p1' },
    body: {},
  },
  {
    route: 'DELETE /api/projects/[id]/sessions',
    method: 'DELETE',
    load: () => import('@pages/api/projects/[id]/sessions'),
    service: 'removeSessions',
    returns: project,
    query: { id: 'p1' },
    body: { sessionIds: ['s1'] },
  },
  {
    route: 'GET /api/projects/[id]/files',
    method: 'GET',
    load: () => import('@pages/api/projects/[id]/files'),
    service: 'listFiles',
    returns: [file],
    query: { id: 'p1' },
    pick: firstOf,
  },
  {
    route: 'POST /api/projects/[id]/files',
    method: 'POST',
    load: () => import('@pages/api/projects/[id]/files'),
    service: 'addFiles',
    returns: project,
    query: { id: 'p1' },
    body: { fileIds: ['f1'] },
  },
  {
    route: 'DELETE /api/projects/[id]/files',
    method: 'DELETE',
    load: () => import('@pages/api/projects/[id]/files'),
    service: 'removeFiles',
    returns: project,
    query: { id: 'p1' },
    body: { fileIds: ['f1'] },
  },
  {
    route: 'POST /api/projects/[id]/systemPrompts',
    method: 'POST',
    load: () => import('@pages/api/projects/[id]/systemPrompts/index'),
    service: 'addSystemPrompts',
    returns: project,
    query: { id: 'p1' },
    body: { fileIds: ['f1'] },
  },
  {
    route: 'DELETE /api/projects/[id]/systemPrompts',
    method: 'DELETE',
    load: () => import('@pages/api/projects/[id]/systemPrompts/index'),
    service: 'removeSystemPrompts',
    returns: project,
    query: { id: 'p1' },
    body: { fileIds: ['f1'] },
  },
  {
    route: 'POST /api/projects/[id]/systemPrompts/toggle',
    method: 'POST',
    load: () => import('@pages/api/projects/[id]/systemPrompts/toggle'),
    service: 'toggleSystemPrompt',
    returns: project,
    query: { id: 'p1' },
    body: { fileId: 'f1' },
  },
  {
    route: 'DELETE /api/projects/removeNonExistintFiles',
    method: 'DELETE',
    load: () => import('@pages/api/projects/removeNonExistintFiles'),
    service: 'removeNonExistentFiles',
    returns: project,
    body: { fileIds: [] },
    pick: firstUpdatedProject,
  },
];

describe('project routes - response schemas strip undeclared fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Routes register their handlers at import time, so each test needs a fresh import.
    vi.resetModules();
    registry.handlers = {};
  });

  it.each(cases)('$route', async ({ method, load, service, returns, query, body, pick }) => {
    projectService[service].mockResolvedValue(returns);
    await load();

    const { req, res } = createMocks({ method, query, body });
    (req as unknown as { user: { id: string } }).user = { id: 'u1' };
    (req as unknown as { ability: Record<string, unknown> }).ability = {};
    await registry.handlers[method]!(req, res);

    const json = res._getJSONData() as Record<string, unknown> | Record<string, unknown>[];
    const entity = (pick ?? firstOf)(json);
    expect(entity.id).toBeDefined();
    expect(entity).not.toHaveProperty('internalNote');
    expect(JSON.stringify(json)).not.toContain(UNDECLARED);
  });
});
