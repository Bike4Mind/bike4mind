import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { Request, Response, NextFunction } from 'express';

const mocks = vi.hoisted(() => ({
  bulk: vi.fn(),
  middleware: null as ((req: Request, res: Response, next: NextFunction) => void) | null,
  handler: null as ((req: Request, res: Response) => Promise<unknown>) | null,
  options: null as unknown,
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    mocks.options = options;
    const chain = {
      use: (middleware: typeof mocks.middleware) => {
        mocks.middleware = middleware;
        return chain;
      },
      post: (handler: typeof mocks.handler) => {
        mocks.handler = handler;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@server/feedback/bulk', () => ({ feedbackBulk: mocks.bulk }));
import { config } from '../bulk';

beforeEach(() => mocks.bulk.mockReset());
describe('feedback bulk route authorization', () => {
  it('requires a first-party admin session and bounds the parsed request body', () => {
    expect(mocks.options).toEqual({ auth: 'jwtOnly', allowedMethods: ['POST'] });
    expect(config.api.bodyParser.sizeLimit).toBe('32kb');
  });
  it('rejects ordinary reporters before executing the bulk handler', () => {
    const { req, res } = createMocks({ method: 'POST' });
    Object.assign(req, { user: { id: 'reporter', isAdmin: false } });
    expect(() => mocks.middleware!(req as unknown as Request, res as unknown as Response, vi.fn())).toThrow(
      expect.objectContaining({ statusCode: 403 })
    );
    expect(mocks.bulk).not.toHaveBeenCalled();
  });
  it('allows a platform admin and returns the bulk result', async () => {
    const { req, res } = createMocks({ method: 'POST' });
    Object.assign(req, { user: { id: 'admin', isAdmin: true } });
    const next = vi.fn();
    mocks.middleware!(req as unknown as Request, res as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
    mocks.bulk.mockResolvedValue({ count: 2, fingerprint: 'a'.repeat(64), applied: false });
    await mocks.handler!(req as unknown as Request, res as unknown as Response);
    expect(res._getJSONData()).toMatchObject({ count: 2, applied: false });
  });
});
