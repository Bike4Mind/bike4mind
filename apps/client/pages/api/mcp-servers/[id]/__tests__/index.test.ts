// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFindById, mockFindOneAndUpdate } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockFindOneAndUpdate: vi.fn(),
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
  McpServer: { findById: (...a: unknown[]) => mockFindById(...a), findOneAndUpdate: (...a: unknown[]) => mockFindOneAndUpdate(...a) },
}));
vi.mock('@bike4mind/mcp', () => ({}));
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
  mcpServerUpdateBodySchema: {
    safeParse: () => ({ success: true, data: { name: 'notion', envVariables: [], enabled: true } }),
  },
}));
vi.mock('@server/utils/mcpEnvValidation', () => ({ assertNoForbiddenMcpEnvKeys: vi.fn() }));
vi.mock('@server/utils/objectId', () => ({ isValidObjectId: () => true }));

import handler from '../index';

const SERVER_ID = '507f1f77bcf86cd799439011';

const runPut = async () => {
  const { req, res } = createMocks({ method: 'PUT', query: { id: SERVER_ID } });
  (req as unknown as { user: { id: string } }).user = { id: 'u1' };
  await (handler as unknown as (r: unknown, s: unknown) => Promise<unknown>)(req, res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFindById.mockResolvedValue({ id: SERVER_ID, userId: 'u1' });
  mockFindOneAndUpdate.mockResolvedValue({ id: SERVER_ID });
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
});
