import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => unknown;
const mocks = vi.hoisted(() => ({
  getHandler: null as Handler | null,
  baseApiOptions: undefined as unknown,
  find: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => ({
    get: (handler: Handler) => {
      mocks.baseApiOptions = options;
      mocks.getHandler = handler;
      return handler;
    },
  }),
}));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: { find: mocks.find } }));

import '@pages/api/organizations/managed';

describe('GET /api/organizations/managed', () => {
  beforeEach(() => {
    mocks.find.mockReset();
    mocks.find.mockResolvedValue([
      {
        id: 'org1',
        userId: 'owner1',
        managerId: 'manager1',
        name: 'Managed Team',
        stripeCustomerId: 'cus_SECRET',
        billingContact: 'owner@example.test',
      },
    ]);
  });

  it('accepts only JWT auth', () => {
    expect(mocks.baseApiOptions).toEqual({ auth: 'jwtOnly' });
  });

  it('takes the manager identity from auth and strips owner-only data', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { managerId: 'other-user' } });
    (req as unknown as { user: unknown }).user = { id: 'manager1', isAdmin: false };

    await mocks.getHandler!(req, res);

    expect(mocks.find).toHaveBeenCalledWith({ managerId: 'manager1' });
    const [organization] = res._getJSONData() as Array<Record<string, unknown>>;
    expect(organization.name).toBe('Managed Team');
    expect(organization).not.toHaveProperty('stripeCustomerId');
    expect(organization).not.toHaveProperty('billingContact');
  });
});
