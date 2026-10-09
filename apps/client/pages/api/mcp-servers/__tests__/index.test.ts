// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFind, mockUpdate, mockInvoke } = vi.hoisted(() => ({
  mockFind: vi.fn(),
  mockUpdate: vi.fn(),
  mockInvoke: vi.fn(),
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
      }
    );
    return chain;
  },
}));

vi.mock('@bike4mind/database', () => ({
  mcpServerRepository: { find: (...a: unknown[]) => mockFind(...a), update: (...a: unknown[]) => mockUpdate(...a) },
  adminSettingsRepository: {},
}));

vi.mock('@bike4mind/mcp', () => ({}));
vi.mock('@server/utils/invokeMcpHandler', () => ({ invokeMcpHandler: (...a: unknown[]) => mockInvoke(...a) }));
vi.mock('@server/utils/errors', () => ({ BadRequestError: class extends Error {} }));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: vi.fn(async () => ({ EnableMCPServer: true })),
  getSettingsValue: (key: string, map: Record<string, unknown>) => map[key],
}));
vi.mock('@server/security/tokenEncryption', () => ({
  encryptEnvVariables: (v: unknown) => v,
  decryptEnvVariables: (v: unknown) => v,
}));
vi.mock('@server/validators/mcpServerValidators', () => ({
  mcpServerCreateBodySchema: { safeParse: () => ({ success: true }) },
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
});
