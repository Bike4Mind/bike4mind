// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFindById, mockUserUpdate, mockServerFindOne, mockServerUpdate, mockServerCreate, mockInvoke } = vi.hoisted(
  () => ({
    mockFindById: vi.fn(),
    mockUserUpdate: vi.fn(),
    mockServerFindOne: vi.fn(),
    mockServerUpdate: vi.fn(),
    mockServerCreate: vi.fn(),
    mockInvoke: vi.fn(),
  })
);

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (fn: (req: unknown, res: unknown) => unknown) => ((h.GET = fn), chain),
        post: (fn: (req: unknown, res: unknown) => unknown) => ((h.POST = fn), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: (...a: unknown[]) => mockFindById(...a), update: (...a: unknown[]) => mockUserUpdate(...a) },
  mcpServerRepository: {
    findOne: (...a: unknown[]) => mockServerFindOne(...a),
    update: (...a: unknown[]) => mockServerUpdate(...a),
    create: (...a: unknown[]) => mockServerCreate(...a),
  },
}));
vi.mock('@server/utils/errors', () => ({ BadRequestError: class extends Error {} }));
vi.mock('@server/security/tokenEncryption', () => ({
  decryptToken: (t: unknown) => t,
  encryptEnvVariables: (v: unknown) => v,
}));
vi.mock('@server/utils/invokeMcpHandler', () => ({ invokeMcpHandler: (...a: unknown[]) => mockInvoke(...a) }));

import handler from '../finalize';

const USER_ID = 'user-1';
const RESOURCE_ID = 'cloud-1';
const SERVER_ID = 'server-1';

const connectedUser = () => ({
  id: USER_ID,
  atlassianConnect: {
    status: 'pending_site_selection',
    accessToken: 'encrypted-token',
    resources: [{ id: RESOURCE_ID, name: 'My Site', url: 'https://site.atlassian.net' }],
  },
});

const run = async () => {
  const { req, res } = createMocks({ method: 'POST', body: { resourceId: RESOURCE_ID } });
  (req as unknown as { user: { id: string } }).user = { id: USER_ID };
  await (handler as unknown as (r: unknown, s: unknown) => Promise<unknown>)(req, res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFindById.mockResolvedValue(connectedUser());
  mockUserUpdate.mockResolvedValue({});
  mockServerFindOne.mockResolvedValue({ id: SERVER_ID, name: 'atlassian', userId: USER_ID, envVariables: [] });
  mockServerUpdate.mockImplementation(async (data: Record<string, unknown>) => data);
  mockInvoke.mockResolvedValue([]);
});

describe('POST /api/mcp-servers/atlassian/finalize - reconnect', () => {
  it('clears the confirmed-empty marker before fetching on an existing server', async () => {
    await run();

    expect(mockServerUpdate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: SERVER_ID, enabled: true }),
      { unset: ['toolSchemasFetchedAt'] }
    );
  });

  it('stamps a fresh marker after the reconnect tool fetch', async () => {
    await run();

    expect(mockServerUpdate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: SERVER_ID, tools: [], toolSchemas: [], toolSchemasFetchedAt: expect.any(Date) })
    );
  });
});
