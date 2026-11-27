import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { BadRequestError, CREDITS_PAGE_READ, ForbiddenError, NotFoundError } from '@bike4mind/common';
import type { Request, Response } from 'express';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  config: null as unknown,
  findUser: vi.fn(),
  loadUsageReceipt: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config: unknown) => {
    h.config = config;
    return {
      use: (guard: (req: Request, res: Response, next: () => void) => void) => ({
        get: (fn: (req: Request, res: Response) => Promise<unknown>) => {
          h.handler = async (req, res) => {
            guard(req as Request, res as Response, () => {});
            return fn(req as Request, res as Response);
          };
          return {};
        },
      }),
    };
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));
vi.mock('@bike4mind/database', () => ({ userRepository: { findById: h.findUser } }));
vi.mock('@server/utils/adminUsageReceipt', () => ({ loadUsageReceipt: h.loadUsageReceipt }));

import '../usage-receipt';

const ADMIN = { id: 'admin1', isAdmin: true };
const AT = '2026-11-05T10:00:00.000Z';

const run = (query: Record<string, string> = {}, user: unknown = ADMIN) => {
  const { req, res } = createMocks({ method: 'GET', query: { userId: 'u1', requestId: 'quest-1', at: AT, ...query } });
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: h.handler!(req, res) };
};

const call = {
  id: 'e1',
  at: AT,
  feature: 'chat',
  model: 'claude-opus-5-5',
  source: 'web',
  status: 'ok',
  tokens: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5, visibleOutput: 5 },
  credits: { cost: 20, charged: 18, writtenOff: 2 },
  costUsd: 0.01,
  limits: { capBound: true, stoppedForCredits: false },
  toolCalls: [{ name: 'web_search', count: 1 }],
  attachments: { count: 1, totalBytes: 100 },
  detailRecorded: true,
};

beforeEach(() => {
  h.findUser.mockReset();
  h.loadUsageReceipt.mockReset();
  h.findUser.mockImplementation(async (id: string) => (id === 'u1' ? { id: 'u1' } : null));
  h.loadUsageReceipt.mockResolvedValue({
    requestId: 'quest-1',
    calls: [call],
    ledger: [],
    totals: { cost: 20, charged: 18, writtenOff: 2 },
  });
});

describe('GET /api/admin/users/[userId]/usage-receipt', () => {
  it('is jwt-only', () => {
    expect(h.config).toEqual({ auth: 'jwtOnly', allowedMethods: ['GET'] });
  });

  it.each(CREDITS_PAGE_READ)('admits a %s delegate', async permission => {
    const { res, promise } = run({}, { id: 'delegate', adminPermissions: [permission] });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(h.loadUsageReceipt).toHaveBeenCalledWith('u1', 'quest-1', new Date(AT));
  });

  it.each([null, { id: 'u', isAdmin: false }, { id: 'u', adminPermissions: ['users:moderate'] }])(
    'rejects an unauthorized caller %j before any read',
    async user => {
      const { promise } = run({}, user);
      await expect(promise).rejects.toBeInstanceOf(ForbiddenError);
      await expect(promise).rejects.toMatchObject({ statusCode: 403 });
      expect(h.findUser).not.toHaveBeenCalled();
      expect(h.loadUsageReceipt).not.toHaveBeenCalled();
    }
  );

  it('rejects a missing request id or a bad timestamp', async () => {
    await expect(run({ requestId: '' }).promise).rejects.toBeInstanceOf(BadRequestError);
    await expect(run({ at: 'yesterday' }).promise).rejects.toBeInstanceOf(BadRequestError);
    expect(h.loadUsageReceipt).not.toHaveBeenCalled();
  });

  it('404s an unknown user', async () => {
    await expect(run({ userId: 'nobody' }).promise).rejects.toBeInstanceOf(NotFoundError);
  });

  it('loads the receipt for the user, request and time', async () => {
    const { res, promise } = run();
    await promise;
    expect(h.loadUsageReceipt).toHaveBeenCalledWith('u1', 'quest-1', new Date(AT));
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().totals).toEqual({ cost: 20, charged: 18, writtenOff: 2 });
  });

  it('never sends content, even when the loader returns some', async () => {
    h.loadUsageReceipt.mockResolvedValue({
      requestId: 'quest-1',
      prompt: 'SECRET PROMPT',
      calls: [
        {
          ...call,
          reply: 'SECRET REPLY',
          title: 'SECRET TITLE',
          toolCalls: [{ name: 'web_search', count: 1, arguments: 'SECRET' }],
          attachments: { count: 1, totalBytes: 100, fileNames: ['SECRET.pdf'] },
        },
      ],
      ledger: [{ id: 't1', at: AT, type: 'text_generation_usage', credits: -18, description: 'SECRET' }],
      totals: { cost: 20, charged: 18, writtenOff: 2 },
    });
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getData()).not.toContain('SECRET');
  });
});
