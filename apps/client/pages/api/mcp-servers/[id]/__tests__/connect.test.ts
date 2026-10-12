// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFindOne, mockUpdate, mockInvoke } = vi.hoisted(() => ({
  mockFindOne: vi.fn(),
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

vi.mock('@bike4mind/database/ai', () => ({
  McpServer: { findOne: (...a: unknown[]) => mockFindOne(...a) },
  mcpServerRepository: { update: (...a: unknown[]) => mockUpdate(...a) },
}));

vi.mock('@bike4mind/mcp', () => ({}));
vi.mock('@bike4mind/utils', () => ({ NotFoundError: class extends Error {} }));
vi.mock('@server/utils/invokeMcpHandler', () => ({ invokeMcpHandler: (...a: unknown[]) => mockInvoke(...a) }));
vi.mock('@server/utils/errors', () => ({ BadRequestError: class extends Error {} }));
vi.mock('@server/security/tokenEncryption', () => ({ decryptEnvVariables: (v: unknown) => v }));
vi.mock('@server/utils/objectId', () => ({ isValidObjectId: () => true }));

import handler from '../connect';

const SERVER_ID = '507f1f77bcf86cd799439011';

const run = async () => {
  const { req, res } = createMocks({ method: 'POST', query: { id: SERVER_ID } });
  (req as unknown as { user: { id: string } }).user = { id: 'u1' };
  await (handler as unknown as (r: unknown, s: unknown) => Promise<unknown>)(req, res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFindOne.mockResolvedValue({ id: SERVER_ID, name: 'notion', userId: 'u1', envVariables: [] });
  mockUpdate.mockResolvedValue({});
  mockInvoke.mockResolvedValue([]);
});

describe('POST /api/mcp-servers/[id]/connect', () => {
  it('clears the confirmed-empty marker before fetching, then stamps the fresh result', async () => {
    await run();

    expect(mockUpdate).toHaveBeenNthCalledWith(1, { id: SERVER_ID }, { unset: ['toolSchemasFetchedAt'] });
    expect(mockUpdate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: SERVER_ID, toolSchemasFetchedAt: expect.any(Date) })
    );
  });

  it('still clears the marker when the reconnect fetch fails, so the next turn retries', async () => {
    mockInvoke.mockRejectedValue(new Error('lambda cold start'));

    await expect(run()).rejects.toThrow('Unable to connect to MCP server');

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({ id: SERVER_ID }, { unset: ['toolSchemasFetchedAt'] });
  });

  it('leaves the marker cleared when the handler returns no payload, so the next turn retries', async () => {
    mockInvoke.mockResolvedValue(undefined);

    const res = await run();

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({ id: SERVER_ID }, { unset: ['toolSchemasFetchedAt'] });
    expect(res._getJSONData()).toEqual([]);
  });
});
