import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({ find: vi.fn(), select: vi.fn(), sort: vi.fn(), limit: vi.fn(), maxTimeMS: vi.fn() }));
vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ get: (fn: unknown) => fn }) }));
vi.mock('@bike4mind/database', () => ({ SupportAccess: { find: h.find } }));
import handler from '../support-access';

describe('customer support access endpoint', () => {
  it('scopes and bounds the query and explicitly projects away internal reasons', async () => {
    h.find.mockReturnValue({ select: h.select });
    h.select.mockReturnValue({ sort: h.sort });
    h.sort.mockReturnValue({ limit: h.limit });
    h.limit.mockReturnValue({ maxTimeMS: h.maxTimeMS });
    h.maxTimeMS.mockResolvedValue([
      {
        sid: 'sid',
        userId: 'customer',
        adminId: 'private-admin',
        reason: 'private-reason',
        escalationReason: 'private-escalation',
        startedAt: new Date(1000),
        expiresAt: new Date(61000),
        endedAt: new Date(31000),
      },
    ]);
    const { req, res } = createMocks({ method: 'GET' });
    Object.assign(req, { user: { id: 'customer' } });
    await (handler as unknown as (req: Request, res: Response) => Promise<unknown>)(
      req as unknown as Request,
      res as unknown as Response
    );
    expect(h.find).toHaveBeenCalledWith({ userId: 'customer' });
    expect(h.limit).toHaveBeenCalledWith(50);
    expect(res._getJSONData()).toEqual({
      items: [
        {
          id: 'sid',
          message: 'Support accessed your account',
          startedAt: new Date(1000).toISOString(),
          endedAt: new Date(31000).toISOString(),
          durationMs: 30000,
        },
      ],
    });
    expect(res._getData()).not.toContain('private');
  });
});
