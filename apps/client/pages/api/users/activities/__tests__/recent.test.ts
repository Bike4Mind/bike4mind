import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mockList = vi.hoisted(() => vi.fn());
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ get: (handler: unknown) => handler }),
}));
vi.mock('@bike4mind/database', () => ({ CounterLog: {} }));
vi.mock('@bike4mind/services', () => ({ userService: { listRecentActivities: mockList } }));

import handler from '../recent';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const call = (user: { id: string; isAdmin?: boolean; adminPermissions?: string[] }) => {
  const { req, res } = createMocks({ method: 'GET', query: { userId: 'target' } });
  Object.assign(req, { user });
  return (handler as unknown as Handler)(req, res);
};

describe("GET /api/users/activities/recent for another user's feed", () => {
  beforeEach(() => {
    mockList.mockReset().mockResolvedValue([]);
  });

  it('allows a support:read delegate without the legacy admin flag', async () => {
    await call({ id: 'support', adminPermissions: ['support:read'] });
    expect(mockList).toHaveBeenCalled();
  });

  it('refuses a delegate without support:read', async () => {
    await expect(call({ id: 'manager', adminPermissions: ['settings:manage'] })).rejects.toThrow('Unauthorized');
    expect(mockList).not.toHaveBeenCalled();
  });
});
