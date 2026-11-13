import { beforeEach, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { Request, Response } from 'express';
const mocks = vi.hoisted(() => ({
  handler: null as null | ((req: Request, res: Response) => Promise<unknown>),
  options: vi.fn(),
  lookup: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: unknown) => {
    mocks.options(options);
    const chain = {
      use: () => chain,
      get: (fn: typeof mocks.handler) => {
        mocks.handler = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: vi.fn() }));
vi.mock('@server/feedback/similar', () => ({ getSimilarFeedback: mocks.lookup }));
vi.mock('@server/utils/feedbackReadAudit', () => ({ recordFeedbackRead: mocks.audit }));
import '../similar';

beforeEach(() => {
  mocks.lookup.mockReset().mockResolvedValue({ items: [], limited: false });
  mocks.audit.mockReset().mockResolvedValue(undefined);
});
it('requires moderation permission and delegates instance authorization and awaited read audit', async () => {
  expect(mocks.options).toHaveBeenCalledWith({
    adminPermissions: { GET: 'users:moderate' },
    auth: 'jwtOnly',
  });
  const { req, res } = createMocks<Request, Response>({ method: 'GET', query: { id: '507f1f77bcf86cd799439011' } });
  const can = vi.fn().mockReturnValue(true);
  req.ability = { can } as unknown as NonNullable<Request['ability']>;
  await mocks.handler!(req, res);
  expect(res._getJSONData()).toEqual({ items: [], limited: false });
  const callbacks = mocks.lookup.mock.calls[0][1];
  const report = { id: 'report' };
  expect(callbacks.canRead(report)).toBe(true);
  expect(can).toHaveBeenCalledWith('read', report);
  mocks.audit.mockRejectedValueOnce(new Error('audit offline'));
  await expect(callbacks.audit([report])).rejects.toThrow('audit offline');
  expect(mocks.audit).toHaveBeenCalledWith(req, [report], { source: 'similar' });
});
it('rejects malformed query ids before lookup', async () => {
  const { req, res } = createMocks<Request, Response>({ query: { id: ['one', 'two'] } });
  await expect(mocks.handler!(req, res)).rejects.toThrow('Invalid ID');
  expect(mocks.lookup).not.toHaveBeenCalled();
});
