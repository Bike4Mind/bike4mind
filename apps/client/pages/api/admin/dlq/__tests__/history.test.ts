// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  routeOptions: vi.fn(),
  findRecent: vi.fn(),
  get: undefined as ((req: unknown, res: unknown) => Promise<void>) | undefined,
}));

vi.mock('@bike4mind/common', () => ({ ApiKeyScope: { ADMIN: 'admin' } }));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  BadRequestError: class BadRequestError extends Error {},
}));
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: unknown) => {
    h.routeOptions(options);
    const chain = {
      use: () => chain,
      get: (fn: (req: unknown, res: unknown) => Promise<void>) => {
        h.get = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  dlqReplayLogRepository: { findRecent: h.findRecent },
}));

beforeEach(async () => {
  vi.clearAllMocks();
  await import('../history');
});

describe('GET /api/admin/dlq/history', () => {
  it('passes includeBody: false so messageBody is excluded from the response', async () => {
    h.findRecent.mockResolvedValue([
      {
        id: 'log-1',
        queueLabel: 'quest',
        messageId: 'msg-1',
        sourceQueue: 'Quest queue',
        status: 'success',
        replayedBy: 'admin-1',
        createdAt: new Date('2026-11-01'),
      },
    ]);

    const { req, res } = createMocks({
      method: 'GET',
      query: {},
    });
    (req as unknown as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };

    await h.get!(req, res);

    expect(h.findRecent).toHaveBeenCalledTimes(1);
    expect(h.findRecent.mock.calls[0][0]).toMatchObject({ includeBody: false });

    const body = JSON.parse(res._getData());
    expect(body.history).toHaveLength(1);
    expect(body.history[0]).not.toHaveProperty('messageBody');
    expect(body.history[0]).toHaveProperty('replayedBy', 'admin-1');
    expect(body.history[0]).toHaveProperty('sourceQueue', 'Quest queue');
  });

  it('forwards search, status, and date filters to findRecent', async () => {
    h.findRecent.mockResolvedValue([]);

    const { req, res } = createMocks({
      method: 'GET',
      query: {
        queue: 'quest',
        status: 'failed',
        search: 'timeout',
        startDate: '2026-11-01T00:00:00.000Z',
        endDate: '2026-11-10T00:00:00.000Z',
      },
    });
    (req as unknown as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };

    await h.get!(req, res);

    expect(h.findRecent).toHaveBeenCalledWith(
      expect.objectContaining({
        queueLabel: 'quest',
        status: 'failed',
        search: 'timeout',
        startDate: new Date('2026-11-01T00:00:00.000Z'),
        endDate: new Date('2026-11-10T00:00:00.000Z'),
        includeBody: false,
      })
    );
  });
});
