import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression test for the WS subscribe handler's rotation-grace wiring: this path
 * used to compute `isBefore(now + 1 day)` inline, which is true for any past rotation
 * and so trusted a retired JWT_SECRET indefinitely (see secretRotationGrace.ts). Now
 * it delegates to the shared helper - this pins that the helper's return value is what
 * decides whether `previousSecret` is passed to `verifyToken`.
 *
 * Scope: only the previousSecret-selection wiring. `verifyToken` is stubbed to throw
 * immediately after being called, so the (unrelated) collection-scope resolution logic
 * further down the handler never runs and doesn't need mocking.
 */

vi.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  GoneException: class GoneException extends Error {},
}));

vi.mock('@bike4mind/common', () => ({
  DataSubscribeRequestAction: { parse: (x: unknown) => x },
  InviteType: {},
  Permission: {},
}));

vi.mock('@bike4mind/database', () => ({
  AdminSettings: {},
  ApiKey: {},
  AppFile: {},
  Artifact: {},
  ArtifactVersion: {},
  FabFile: {},
  findModelByCollectionName: vi.fn(),
  Inbox: {},
  Invite: {},
  mongoose: {},
  Organization: {},
  Project: {},
  QuerySubscription: {},
  Quest: { collection: { collectionName: 'quests' } },
  QuestMasterPlan: { collection: { collectionName: 'questMasterPlans' } },
  User: { findById: vi.fn() },
}));

vi.mock('@bike4mind/database/auth', () => ({
  Session: {},
}));

vi.mock('@casl/mongoose', () => ({
  accessibleBy: vi.fn(),
}));

vi.mock('@server/models/Subscription', () => ({
  Subscription: {},
}));

vi.mock('@server/websocket/subscriptionScopes', () => ({
  questMasterPlanSubscriptionScope: vi.fn(),
}));

vi.mock('@server/utils/errors', () => ({
  NotFoundError: class NotFoundError extends Error {},
}));

vi.mock('@server/websocket/utils', () => ({
  sendToConnection: vi.fn(),
  withWebSocketContext: vi.fn(
    (handler: (event: unknown, context: unknown, logger: unknown) => Promise<unknown>) => handler
  ),
}));

vi.mock('../../auth/ability', () => ({
  default: vi.fn(),
}));

const mockFindByKeyName = vi.fn();
vi.mock('@bike4mind/database/infra', () => ({
  secretRotationRepository: { findByKeyName: (...args: unknown[]) => mockFindByKeyName(...args) },
}));

const mockIsWithinGraceWindow = vi.fn();
vi.mock('@server/auth/secretRotationGrace', () => ({
  isRotatedSecretWithinGraceWindow: (...args: unknown[]) => mockIsWithinGraceWindow(...args),
}));

const mockVerifyToken = vi.fn();
vi.mock('@server/auth/tokenGenerator', () => ({
  authTokenGenerator: { verifyToken: (...args: unknown[]) => mockVerifyToken(...args) },
}));

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, {
    get(_, key) {
      return new Proxy({}, { get: () => `mock-${String(key)}` });
    },
  }),
}));

import { func } from '../dataSubscribeRequest';

const baseEvent = (accessToken = 'token-123') => ({
  requestContext: { connectionId: 'conn-1' },
  body: JSON.stringify({
    action: 'subscribe_query',
    accessToken,
    subscriptionId: 'sub-1',
    collectionName: 'quests',
    query: {},
    fields: {},
    fetchInitialData: false,
  }),
});
const noopLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

describe('dataSubscribeRequest WS handler - rotation grace window', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyToken.mockImplementation(() => {
      throw new Error('stop-after-verify: out of scope for this test');
    });
  });

  it('passes the rotated previousKey when the helper reports the rotation is within window', async () => {
    mockFindByKeyName.mockResolvedValue({ rotatedAt: new Date(), previousKey: 'prev-secret' });
    mockIsWithinGraceWindow.mockReturnValue(true);

    await expect(func(baseEvent() as any, {} as any, noopLogger as any)).rejects.toThrow('stop-after-verify');

    expect(mockVerifyToken).toHaveBeenCalledWith('token-123', 'prev-secret');
  });

  it('omits the previous secret when the helper reports the rotation is outside the window', async () => {
    mockFindByKeyName.mockResolvedValue({ rotatedAt: new Date(0), previousKey: 'prev-secret' });
    mockIsWithinGraceWindow.mockReturnValue(false);

    await expect(func(baseEvent() as any, {} as any, noopLogger as any)).rejects.toThrow('stop-after-verify');

    expect(mockVerifyToken).toHaveBeenCalledWith('token-123', undefined);
  });

  it('omits the previous secret when there is no recorded rotation', async () => {
    mockFindByKeyName.mockResolvedValue(null);
    mockIsWithinGraceWindow.mockReturnValue(false);

    await expect(func(baseEvent() as any, {} as any, noopLogger as any)).rejects.toThrow('stop-after-verify');

    expect(mockIsWithinGraceWindow).toHaveBeenCalledWith(undefined);
    expect(mockVerifyToken).toHaveBeenCalledWith('token-123', undefined);
  });
});
