// @vitest-environment node
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '@server/utils/errors';

type RouteHandler = (req: unknown, res: unknown) => Promise<unknown>;
type RouteMethod = 'get' | 'post' | 'put' | 'delete';

const spies = vi.hoisted(() => {
  const captured: Array<{ method: string; fn: (req: unknown, res: unknown) => Promise<unknown> }> = [];
  return {
    captured,
    assertMcpServerEnabled: vi.fn(),
    invokeMcpHandler: vi.fn(),
    repoFind: vi.fn(),
    repoFindOne: vi.fn(),
    repoCreate: vi.fn(),
    repoUpdate: vi.fn(),
    mcpServerFindOne: vi.fn(),
    mcpServerFindById: vi.fn(),
    mcpServerFindOneAndUpdate: vi.fn(),
    mcpServerFindOneAndDelete: vi.fn(),
    sessionFindById: vi.fn(),
  };
});

vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, unknown> = {};
  for (const method of ['get', 'post', 'put', 'delete']) {
    chain[method] = (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      spies.captured.push({ method, fn });
      return chain;
    };
  }
  chain.use = () => chain;
  return { baseApi: () => chain };
});
vi.mock('@server/utils/mcpServerFlag', () => ({ assertMcpServerEnabled: spies.assertMcpServerEnabled }));
vi.mock('@server/utils/invokeMcpHandler', () => ({ invokeMcpHandler: spies.invokeMcpHandler }));
vi.mock('@server/integrations/slack/slackPackageInit', () => ({ initializeSlackPackage: vi.fn() }));
vi.mock('@server/security/tokenEncryption', () => ({
  encryptEnvVariables: (value: unknown) => value,
  decryptEnvVariables: (value: unknown) => value,
}));
vi.mock('@bike4mind/mcp', () => ({ MCPClient: class {} }));
vi.mock('@bike4mind/slack', () => ({
  JiraResource: class {},
  ConfluenceResource: class {},
}));
vi.mock('@bike4mind/database', () => ({
  mcpServerRepository: {
    find: spies.repoFind,
    findOne: spies.repoFindOne,
    create: spies.repoCreate,
    update: spies.repoUpdate,
  },
  adminSettingsRepository: {},
  Session: { findById: spies.sessionFindById },
}));
vi.mock('@bike4mind/database/ai', () => ({
  McpServer: {
    findOne: spies.mcpServerFindOne,
    findById: spies.mcpServerFindById,
    findOneAndUpdate: spies.mcpServerFindOneAndUpdate,
    findOneAndDelete: spies.mcpServerFindOneAndDelete,
  },
  mcpServerRepository: { update: spies.repoUpdate },
}));

const OBJECT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const request = {
  user: { id: 'user-1' },
  query: { id: OBJECT_ID },
  body: {
    name: 'server',
    envVariables: [{ key: 'KEY', value: 'value' }],
    enabled: true,
    sessionId: OBJECT_ID,
    source: 'jira',
    attachmentId: 'att-1',
    filename: 'file.txt',
  },
};
const response = {};

const routes: Record<string, Partial<Record<RouteMethod, RouteHandler>>> = {};

async function loadRoute(name: string, importRoute: () => Promise<unknown>) {
  spies.captured.length = 0;
  await importRoute();
  routes[name] = Object.fromEntries(spies.captured.map(({ method, fn }) => [method, fn]));
}

function handlerFor(name: string, method: RouteMethod): RouteHandler {
  const handler = routes[name]?.[method];
  if (!handler) throw new Error(`No ${method} handler captured for ${name}`);
  return handler;
}

function expectNothingDownstreamRan() {
  for (const spy of [
    spies.invokeMcpHandler,
    spies.repoFind,
    spies.repoFindOne,
    spies.repoCreate,
    spies.repoUpdate,
    spies.mcpServerFindOne,
    spies.mcpServerFindById,
    spies.mcpServerFindOneAndUpdate,
    spies.mcpServerFindOneAndDelete,
    spies.sessionFindById,
  ]) {
    expect(spy).not.toHaveBeenCalled();
  }
}

describe('MCP admin flag gate on MCP routes', () => {
  beforeAll(async () => {
    await loadRoute('servers', () => import('../index'));
    await loadRoute('server', () => import('../[id]/index'));
    await loadRoute('connect', () => import('../[id]/connect'));
    await loadRoute('deleteAttachment', () => import('../../mcp/delete-attachment'));
    await loadRoute('downloadAttachment', () => import('../../mcp/download-attachment'));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    spies.assertMcpServerEnabled.mockRejectedValue(new ForbiddenError('MCP servers are disabled'));
  });

  it.each([
    ['servers', 'post', 'POST /api/mcp-servers'],
    ['server', 'put', 'PUT /api/mcp-servers/[id]'],
    ['server', 'get', 'GET /api/mcp-servers/[id]'],
    ['connect', 'post', 'POST /api/mcp-servers/[id]/connect'],
    ['deleteAttachment', 'post', 'POST /api/mcp/delete-attachment'],
    ['downloadAttachment', 'post', 'POST /api/mcp/download-attachment'],
  ] as const)('%s %s rejects with ForbiddenError before doing any work (%s)', async (name, method) => {
    await expect(handlerFor(name, method)(request, response)).rejects.toBeInstanceOf(ForbiddenError);

    expect(spies.assertMcpServerEnabled).toHaveBeenCalledTimes(1);
    expectNothingDownstreamRan();
  });

  it('still lets DELETE /api/mcp-servers/[id] run while the flag is off', async () => {
    spies.mcpServerFindOneAndDelete.mockResolvedValue({ id: OBJECT_ID });
    const res = { status: vi.fn().mockReturnThis(), end: vi.fn() };

    await handlerFor('server', 'delete')(request, res);

    expect(spies.assertMcpServerEnabled).not.toHaveBeenCalled();
    expect(spies.mcpServerFindOneAndDelete).toHaveBeenCalledWith({ _id: OBJECT_ID, userId: 'user-1' });
    expect(res.status).toHaveBeenCalledWith(204);
  });
});
