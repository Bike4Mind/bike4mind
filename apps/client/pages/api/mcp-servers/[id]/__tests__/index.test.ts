// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFindById, mockFindOneAndUpdate, mockUpdateBodyParse } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockFindOneAndUpdate: vi.fn(),
  mockUpdateBodyParse: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (fn: (req: unknown, res: unknown) => unknown) => ((h.GET = fn), chain),
        post: (fn: (req: unknown, res: unknown) => unknown) => ((h.POST = fn), chain),
        put: (fn: (req: unknown, res: unknown) => unknown) => ((h.PUT = fn), chain),
        delete: (fn: (req: unknown, res: unknown) => unknown) => ((h.DELETE = fn), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@bike4mind/database/ai', () => ({
  McpServer: {
    findById: (...a: unknown[]) => mockFindById(...a),
    findOneAndUpdate: (...a: unknown[]) => mockFindOneAndUpdate(...a),
  },
}));
vi.mock('@bike4mind/mcp', () => ({}));
// The EnableMCPServer gate itself is pinned by mcpServerFlagGate.test.ts.
vi.mock('@server/utils/mcpServerFlag', () => ({ assertMcpServerEnabled: vi.fn() }));
vi.mock('@bike4mind/utils', () => ({ NotFoundError: class extends Error {} }));
vi.mock('@server/utils/invokeMcpHandler', () => ({ invokeMcpHandler: vi.fn() }));
vi.mock('@server/utils/errors', () => ({
  BadRequestError: class extends Error {},
  ForbiddenError: class extends Error {},
}));
vi.mock('@server/security/tokenEncryption', () => ({
  encryptEnvVariables: (v: unknown) => v,
  decryptEnvVariables: (v: unknown) => v,
}));
vi.mock('@server/validators/mcpServerValidators', () => ({
  mcpServerUpdateBodySchema: { safeParse: (...a: unknown[]) => mockUpdateBodyParse(...a) },
}));
vi.mock('@server/utils/mcpEnvValidation', () => ({ assertNoForbiddenMcpEnvKeys: vi.fn() }));
vi.mock('@server/utils/objectId', () => ({ isValidObjectId: () => true }));

import handler from '../index';

const SERVER_ID = '507f1f77bcf86cd799439011';
const STORED_TOKEN = 'enc:stored-token';

const bodyWith = (envVariables: { key: string; value?: string }[]) =>
  mockUpdateBodyParse.mockReturnValue({ success: true, data: { name: 'notion', envVariables, enabled: true } });

const runPut = async () => {
  const { req, res } = createMocks({ method: 'PUT', query: { id: SERVER_ID } });
  (req as unknown as { user: { id: string } }).user = { id: 'u1' };
  await (handler as unknown as (r: unknown, s: unknown) => Promise<unknown>)(req, res);
  return res;
};

const setEnv = () => (mockFindOneAndUpdate.mock.calls[0][1] as { $set: { envVariables: unknown } }).$set.envVariables;

beforeEach(() => {
  vi.clearAllMocks();
  bodyWith([]);
  mockFindById.mockResolvedValue({
    id: SERVER_ID,
    userId: 'u1',
    envVariables: [{ key: 'NOTION_ACCESS_TOKEN', value: STORED_TOKEN }],
  });
  // The route serializes the hydrated document with toJSON() before the response schema.
  mockFindOneAndUpdate.mockImplementation(async (_filter: unknown, update: { $set: Record<string, unknown> }) => ({
    toJSON: () => ({
      id: SERVER_ID,
      userId: 'u1',
      name: 'notion',
      enabled: true,
      tools: [],
      envVariables: update.$set.envVariables,
      metadata: {
        webhooks: {
          github: { routingToken: 'route-token', secret: 'enc:webhook-secret', subscribedEvents: [], repos: [] },
        },
      },
    }),
  }));
});

describe('PUT /api/mcp-servers/[id]', () => {
  it('unsets the cached schemas and the confirmed-empty marker when config changes', async () => {
    await runPut();

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: SERVER_ID, userId: 'u1' },
      expect.objectContaining({ $unset: expect.objectContaining({ toolSchemasFetchedAt: '' }) }),
      { new: true, runValidators: true }
    );
  });

  it('withholds env variable values and the webhook secret from the response', async () => {
    bodyWith([{ key: 'NOTION_ACCESS_TOKEN', value: 'new-token' }]);

    const res = await runPut();

    const body = res._getJSONData();
    expect(body.envVariables).toEqual([{ key: 'NOTION_ACCESS_TOKEN' }]);
    expect(body.metadata.webhooks.github).not.toHaveProperty('secret');
    expect(body.metadata.webhooks.github.routingToken).toBe('route-token');
    expect(JSON.stringify(body)).not.toMatch(/new-token|enc:/);
  });

  it('keeps the stored value for a stored key sent back blank', async () => {
    bodyWith([{ key: 'NOTION_ACCESS_TOKEN', value: '' }]);

    await runPut();

    expect(setEnv()).toEqual([{ key: 'NOTION_ACCESS_TOKEN', value: STORED_TOKEN }]);
  });

  it('replaces the stored value when a new one is sent', async () => {
    bodyWith([{ key: 'NOTION_ACCESS_TOKEN', value: 'new-token' }]);

    await runPut();

    expect(setEnv()).toEqual([{ key: 'NOTION_ACCESS_TOKEN', value: 'new-token' }]);
  });

  it('refuses a blank value for a key that is not stored yet', async () => {
    bodyWith([{ key: 'NOTION_WORKSPACE_ID' }]);

    await expect(runPut()).rejects.toThrow('A value is required for a new environment variable');
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('keeps a stored value while adding a new key in the same body', async () => {
    bodyWith([
      { key: 'NOTION_ACCESS_TOKEN', value: '' },
      { key: 'NOTION_WORKSPACE_ID', value: 'workspace-1' },
    ]);

    await runPut();

    expect(setEnv()).toEqual([
      { key: 'NOTION_ACCESS_TOKEN', value: STORED_TOKEN },
      { key: 'NOTION_WORKSPACE_ID', value: 'workspace-1' },
    ]);
  });

  it('drops a stored key that the body omits', async () => {
    bodyWith([{ key: 'OTHER_KEY', value: 'other-value' }]);

    await runPut();

    expect(setEnv()).toEqual([{ key: 'OTHER_KEY', value: 'other-value' }]);
  });

  it('treats a legacy null envVariables array as empty', async () => {
    mockFindById.mockResolvedValue({ id: SERVER_ID, userId: 'u1', envVariables: null });
    bodyWith([{ key: 'NOTION_ACCESS_TOKEN', value: 'new-token' }]);

    await runPut();

    expect(setEnv()).toEqual([{ key: 'NOTION_ACCESS_TOKEN', value: 'new-token' }]);
  });

  it('returns 404 when the update finds no server', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);

    await expect(runPut()).rejects.toThrow('MCP Server not found');
  });
});
