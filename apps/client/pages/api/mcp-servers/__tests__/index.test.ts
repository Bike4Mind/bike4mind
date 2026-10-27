// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFind, mockFindOne, mockUpdate, mockCreate, mockInvoke, mockCreateBodyParse, mockEncrypt } = vi.hoisted(
  () => ({
    mockFind: vi.fn(),
    mockFindOne: vi.fn(),
    mockUpdate: vi.fn(),
    mockCreate: vi.fn(),
    mockInvoke: vi.fn(),
    mockCreateBodyParse: vi.fn(() => ({ success: true })),
    mockEncrypt: vi.fn((vars: unknown) => vars),
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
  mcpServerRepository: {
    find: (...a: unknown[]) => mockFind(...a),
    findOne: (...a: unknown[]) => mockFindOne(...a),
    update: (...a: unknown[]) => mockUpdate(...a),
    create: (...a: unknown[]) => mockCreate(...a),
  },
  adminSettingsRepository: {},
}));

vi.mock('@bike4mind/mcp', () => ({}));
// The EnableMCPServer gate itself is pinned by mcpServerFlagGate.test.ts.
vi.mock('@server/utils/mcpServerFlag', () => ({ assertMcpServerEnabled: vi.fn() }));
vi.mock('@server/utils/invokeMcpHandler', () => ({ invokeMcpHandler: (...a: unknown[]) => mockInvoke(...a) }));
vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  BadRequestError: class extends Error {},
  NotFoundError: class extends Error {},
}));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: vi.fn(async () => ({ EnableMCPServer: true })),
  getSettingsValue: (key: string, map: Record<string, unknown>) => map[key],
}));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({
  encryptEnvVariables: mockEncrypt,
  decryptEnvVariables: (v: unknown) => v,
}));
vi.mock('@server/validators/mcpServerValidators', () => ({
  mcpServerCreateBodySchema: { safeParse: (...a: unknown[]) => mockCreateBodyParse(...a) },
}));
vi.mock('@server/utils/mcpEnvValidation', () => ({ assertNoForbiddenMcpEnvKeys: vi.fn() }));

import handler from '../index';

const server = (extra: Record<string, unknown> = {}) => ({
  id: 's1',
  userId: 'u1',
  name: 'notion',
  enabled: true,
  envVariables: [],
  tools: [],
  toolSchemas: [],
  updatedAt: new Date(),
  ...extra,
});

// A stored server carrying both withheld secrets: an env value and the GitHub webhook HMAC secret.
const serverWithSecrets = () =>
  server({
    envVariables: [{ key: 'NOTION_ACCESS_TOKEN', value: 'enc:stored-token' }],
    toolSchemasFetchedAt: new Date(),
    metadata: {
      githubLogin: 'octocat',
      webhooks: {
        github: {
          routingToken: 'route-token',
          secret: 'enc:webhook-secret',
          subscribedEvents: ['push'],
          repos: [],
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  });

const expectSecretsWithheld = (body: Record<string, unknown>) => {
  expect(body.envVariables).toEqual([{ key: 'NOTION_ACCESS_TOKEN' }]);
  const webhook = (body.metadata as { webhooks: { github: Record<string, unknown> } }).webhooks.github;
  expect(webhook).not.toHaveProperty('secret');
  expect(webhook.routingToken).toBe('route-token');
  expect(JSON.stringify(body)).not.toContain('enc:');
};

const run = async () => {
  const { req, res } = createMocks({ method: 'GET' });
  (req as unknown as { user: { id: string } }).user = { id: 'u1' };
  await (handler as unknown as (r: unknown, s: unknown) => Promise<unknown>)(req, res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockResolvedValue([]);
});

describe('GET /api/mcp-servers', () => {
  it('withholds env variable values and the webhook secret', async () => {
    mockFind.mockResolvedValue([serverWithSecrets()]);

    const res = await run();

    const [body] = res._getJSONData();
    expectSecretsWithheld(body);
    expect(body).toMatchObject({ id: 's1', name: 'notion', enabled: true });
  });

  it('does not live-fetch a confirmed-empty server whose marker is fresh', async () => {
    mockFind.mockResolvedValue([server({ toolSchemasFetchedAt: new Date() })]);

    const res = await run();

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(res._getJSONData()).toHaveLength(1);
  });

  it('live-fetches a server that was never fetched and stamps the marker', async () => {
    mockFind.mockResolvedValue([server()]);

    await run();

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1', toolSchemas: [], toolSchemasFetchedAt: expect.any(Date) })
    );
  });

  it('refetches once the marker ages past the TTL', async () => {
    mockFind.mockResolvedValue([server({ toolSchemasFetchedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })]);

    await run();

    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('refreshes a populated server only once its schema cache passes the refresh TTL', async () => {
    mockFind.mockResolvedValue([
      server({ toolSchemas: [{ name: 'notion_search' }], updatedAt: new Date(Date.now() - 10 * 60 * 1000) }),
    ]);

    await run();

    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('serves a populated server with a fresh schema cache without a live fetch', async () => {
    mockFind.mockResolvedValue([server({ toolSchemas: [{ name: 'notion_search' }], updatedAt: new Date() })]);

    await run();

    expect(mockInvoke).not.toHaveBeenCalled();
  });

  // A legacy row must not turn the whole list into a 500: one bad row used to fail respond().
  it('serves a legacy row with a null envVariables array and null metadata', async () => {
    mockFind.mockResolvedValue([server({ envVariables: null, metadata: null, toolSchemasFetchedAt: new Date() })]);

    const res = await run();

    const [body] = res._getJSONData();
    expect(body.envVariables).toEqual([]);
    expect(body.metadata).toBeNull();
  });

  it('drops legacy env items without a string key instead of failing the list', async () => {
    mockFind.mockResolvedValue([
      server({
        envVariables: [{ key: 'NOTION_ACCESS_TOKEN' }, null, { value: 'orphan-value' }],
        toolSchemasFetchedAt: new Date(),
      }),
    ]);

    const res = await run();

    const [body] = res._getJSONData();
    expect(body.envVariables).toEqual([{ key: 'NOTION_ACCESS_TOKEN' }]);
  });
});

describe('POST /api/mcp-servers', () => {
  const runPost = async () => {
    const { req, res } = createMocks({ method: 'POST' });
    (req as unknown as { user: { id: string } }).user = { id: 'u1' };
    await (handler as unknown as (r: unknown, s: unknown) => Promise<unknown>)(req, res);
    return res;
  };

  it('clears the confirmed-empty marker when reconnecting an existing server', async () => {
    mockFindOne.mockResolvedValue(server());
    mockUpdate.mockResolvedValue(server());
    mockCreateBodyParse.mockReturnValue({ success: true, data: { name: 'notion', envVariables: [], enabled: true } });

    await runPost();

    expect(mockUpdate).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 's1', enabled: true }), {
      unset: ['toolSchemasFetchedAt'],
    });
  });

  it('withholds env variable values and the webhook secret', async () => {
    mockFindOne.mockResolvedValue(server());
    mockUpdate.mockResolvedValue(serverWithSecrets());
    mockCreateBodyParse.mockReturnValue({ success: true, data: { name: 'notion', envVariables: [], enabled: true } });

    const res = await runPost();

    expectSecretsWithheld(res._getJSONData());
  });

  // The server was deleted between the findOne and the update; respond() cannot parse null.
  it('returns 404 when the update finds no server', async () => {
    mockFindOne.mockResolvedValue(server());
    mockUpdate.mockResolvedValue(null);
    mockCreateBodyParse.mockReturnValue({ success: true, data: { name: 'notion', envVariables: [], enabled: true } });

    await expect(runPost()).rejects.toThrow('MCP Server not found');
  });

  it('returns the saved server with the connect failure instead of a 400', async () => {
    mockFindOne.mockResolvedValue(null);
    mockCreate.mockResolvedValue(server({ name: 'linkedin' }));
    mockInvoke.mockRejectedValue(new Error('MCP error -32000: Connection closed'));
    mockCreateBodyParse.mockReturnValue({
      success: true,
      data: { name: 'linkedin', envVariables: [{ key: 'LINKEDIN_ACCESS_TOKEN', value: 'test-token-1' }] },
    });

    const res = await runPost();

    expect(res._getStatusCode()).toBe(200);
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(res._getJSONData()).toMatchObject({
      id: 's1',
      name: 'linkedin',
      tools: [],
      connectionError: 'MCP error -32000: Connection closed',
    });
  });

  it('omits connectionError when the connect succeeds', async () => {
    mockFindOne.mockResolvedValue(server());
    mockUpdate.mockResolvedValue(server({ tools: ['search'] }));
    mockInvoke.mockResolvedValue([{ name: 'search' }]);
    mockCreateBodyParse.mockReturnValue({ success: true, data: { name: 'notion', envVariables: [], enabled: true } });

    const res = await runPost();

    expect(res._getJSONData()).not.toHaveProperty('connectionError');
  });

  // The ciphertext is bound to (user, row, field). If the id used to encrypt differs from the `_id`
  // the row is stored under, every stored variable is undecryptable for the life of the record.
  it('binds the stored ciphertext to the row id it persists', async () => {
    mockFindOne.mockResolvedValue(null);
    mockCreate.mockImplementation(async (doc: Record<string, unknown>) => server(doc));
    mockUpdate.mockResolvedValue(server());
    mockInvoke.mockResolvedValue([]);
    mockCreateBodyParse.mockReturnValue({
      success: true,
      data: { name: 'linkedin', envVariables: [{ key: 'LINKEDIN_ACCESS_TOKEN', value: 'token-1' }] },
    });

    await runPost();

    const [, owner] = mockEncrypt.mock.calls[0] as [unknown, { userId: string; id: string }];
    const created = mockCreate.mock.calls[0][0] as { _id: string };
    expect(owner).toMatchObject({ userId: 'u1', name: 'linkedin' });
    // Pin the type: without it, a route that stops minting an id still passes, both sides undefined.
    expect(owner.id).toEqual(expect.any(String));
    expect(created._id).toBe(owner.id);
  });

  it('binds a reconnect to the existing row id', async () => {
    mockFindOne.mockResolvedValue(server());
    mockUpdate.mockResolvedValue(server());
    mockInvoke.mockResolvedValue([]);
    mockCreateBodyParse.mockReturnValue({
      success: true,
      data: { name: 'notion', envVariables: [{ key: 'NOTION_ACCESS_TOKEN', value: 'token-1' }] },
    });

    await runPost();

    const [, owner] = mockEncrypt.mock.calls[0] as [unknown, { id: string }];
    expect(owner.id).toBe('s1');
    expect(mockUpdate.mock.calls[0][0]).toMatchObject({ id: 's1' });
  });
});
