import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Pending org invitees were invited by user id and have not joined, so GET pendingUsers names them
 * without their address to everyone but a platform admin - org admins included, since they mint
 * those invites.
 */

type Handler = (req: unknown, res: unknown) => unknown;
const mockRefs = vi.hoisted(() => ({ getHandler: null as null | Handler }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    get: (fn: Handler) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const listPendingUsers = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', () => ({ organizationService: { listPendingUsers } }));
vi.mock('@bike4mind/database', () => ({ organizationRepository: {}, userRepository: {}, inviteRepository: {} }));

import '@pages/api/organizations/[id]/pendingUsers';

const pending = { id: 'pending-1', name: 'Pending Person', username: 'pending', email: 'pending@example.test' };

async function get(user: { id: string; isAdmin: boolean }) {
  const { req, res } = createMocks({ method: 'GET', query: { id: 'org-1' } });
  (req as unknown as { user: unknown }).user = user;
  await mockRefs.getHandler!(req, res);
  return res._getJSONData() as Array<Record<string, unknown>>;
}

describe('GET /api/organizations/:id/pendingUsers', () => {
  beforeEach(() => listPendingUsers.mockResolvedValue([pending]));

  it('omits the address for a non-admin caller, org admins included', async () => {
    const [row] = await get({ id: 'org-admin', isAdmin: false });
    expect(row).toMatchObject({ id: 'pending-1', name: 'Pending Person', username: 'pending' });
    expect(row).not.toHaveProperty('email');
  });

  it('keeps the address for a platform admin', async () => {
    const [row] = await get({ id: 'admin', isAdmin: true });
    expect(row.email).toBe('pending@example.test');
  });
});
