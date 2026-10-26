import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createMocks } from 'node-mocks-http';

const effects = vi.hoisted(() => ({
  createUser: vi.fn(),
  createOrg: vi.fn(),
  addCredits: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock('./baseApi', () => ({
  baseApi: () => {
    const guards: ((req: Request, res: Response, next: () => void) => unknown)[] = [];
    let endpoint: (req: Request, res: Response) => unknown;
    const chain = async (req: Request, res: Response) => {
      for (const guard of guards) await guard(req, res, () => {});
      return endpoint(req, res);
    };
    chain.use = (guard: (typeof guards)[number]) => {
      guards.push(guard);
      return chain;
    };
    chain.post = (handler: typeof endpoint) => {
      endpoint = handler;
      return chain;
    };
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  withTransaction: effects.transaction,
  isTransientTransactionError: vi.fn(),
  userRepository: {},
  organizationRepository: {},
  creditLotRepository: {},
  creditTransactionRepository: {},
  pendingOtcTokenRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  userService: { createUser: effects.createUser },
  organizationService: { create: effects.createOrg },
  creditService: { addCreditsWithLedgerRow: effects.addCredits },
}));
vi.mock('@server/models/Subscription', () => ({ subscriptionRepository: {} }));
vi.mock('@server/services/organizationService', () => ({ resolveSubscriptionSource: vi.fn() }));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: {} }));
vi.mock('@server/utils/adminAudit', () => ({ parseAdminActionReason: vi.fn(), recordAdminActionFromRequest: vi.fn() }));
vi.mock('@server/websocket/utils', () => ({ sendToClient: vi.fn() }));
vi.mock('@server/analytics/funnel', () => ({ emitSignupFunnelEvents: vi.fn(), recordSyntheticIdentity: vi.fn() }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@bike4mind/server-utils/services/teamPlanSettings', () => ({ getTeamPlanSettings: vi.fn() }));
vi.mock('@server/auth/stepUp', () => ({ requireStepUp: vi.fn() }));
import grantOrg from '../../pages/api/admin/organizations/grant';
import revokeOrg from '../../pages/api/admin/organizations/[id]/revoke';
import createUser from '../../pages/api/admin/create-user';
import bulkCreateUsers from '../../pages/api/admin/bulk-create-users';

const invoke = async (handler: unknown, body: object) => {
  const { req, res } = createMocks<Request, Response>({ method: 'POST', body });
  req.user = { id: 'settings', isAdmin: false, adminPermissions: ['settings:manage'] } as Request['user'];
  await (handler as (req: Request, res: Response) => Promise<unknown>)(req, res);
};
beforeEach(() => vi.clearAllMocks());
describe('credit grant authorization', () => {
  it.each([
    ['organization grant', grantOrg, {}],
    ['organization grant revocation', revokeOrg, {}],
    [
      'new user funded account',
      createUser,
      { username: 'newuser', email: 'newuser@example.com', name: 'New User', initialCredits: 100 },
    ],
    ['bulk funded accounts', bulkCreateUsers, { users: [{ email: 'newuser@example.com', startingCredits: 100 }] }],
  ])('settings alone cannot perform %s', async (_name, handler, body) => {
    await expect(invoke(handler, body as object)).rejects.toThrow('Missing permission: credits:adjust');
    for (const collaborator of Object.values(effects)) expect(collaborator).not.toHaveBeenCalled();
  });
});
