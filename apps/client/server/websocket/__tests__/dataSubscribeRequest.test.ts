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

vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  DataSubscribeRequestAction: { parse: (x: unknown) => x },
}));

const mockFindModelByCollectionName = vi.fn();
const mockQuerySubscriptionFindOneAndUpdate = vi.fn();
vi.mock('@bike4mind/database', () => ({
  AdminSettings: {},
  ApiKey: {},
  AppFile: {},
  Artifact: {},
  ArtifactVersion: {},
  FabFile: {},
  findModelByCollectionName: (...args: unknown[]) => mockFindModelByCollectionName(...args),
  Inbox: {},
  Invite: {},
  mongoose: {},
  Organization: {},
  Project: {},
  QuerySubscription: { findOneAndUpdate: (...args: unknown[]) => mockQuerySubscriptionFindOneAndUpdate(...args) },
  Quest: { collection: { collectionName: 'quests' } },
  QuestMasterPlan: { collection: { collectionName: 'questMasterPlans' } },
  User: { findById: vi.fn() },
}));

const mockSessionFind = vi.fn();
vi.mock('@bike4mind/database/auth', () => ({
  Session: { find: (...args: unknown[]) => mockSessionFind(...args) },
}));

vi.mock('@casl/mongoose', () => ({
  // Real callers chain `.ofType(SomeModel)` off this - the scope-resolution branches this file
  // doesn't exercise never read the return value, so a fixed no-op shape covers every call site.
  accessibleBy: vi.fn().mockReturnValue({ ofType: vi.fn().mockReturnValue({}) }),
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
import { User } from '@bike4mind/database';

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

/**
 * Regression for cgtorniado's 5th review: the quests-collection returnValue/error exclusion
 * applied unconditionally, including to the session's own OWNER - and the client cache merges a
 * WS update as a top-level spread, so the owner's cached tool output vanished the moment any live
 * update landed. These drive the handler past auth into the actual field-scoping logic (previous
 * describe block stops at verifyToken) to prove the owner/sharee split, and cover the
 * drop-inclusions-on-collision branch this same review flagged as untested.
 */
describe('dataSubscribeRequest WS handler - quest field scoping', () => {
  const questEvent = (overrides: Record<string, unknown> = {}) => ({
    requestContext: { connectionId: 'conn-1' },
    body: JSON.stringify({
      action: 'subscribe_query',
      accessToken: 'token-123',
      subscriptionId: 'sub-1',
      collectionName: 'quests',
      query: { sessionId: 'sess-1' },
      fields: {},
      fetchInitialData: false,
      ...overrides,
    }),
  });

  const fakeCollection = () => {
    const find = vi.fn().mockReturnValue({ setOptions: vi.fn().mockReturnValue({ getQuery: () => ({}) }) });
    return { find };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindByKeyName.mockResolvedValue(null);
    mockIsWithinGraceWindow.mockReturnValue(false);
    mockVerifyToken.mockReturnValue({ id: 'caller-1' });
    (User.findById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'caller-1', tokenVersion: undefined });
    mockQuerySubscriptionFindOneAndUpdate.mockResolvedValue({ id: 'sub-doc-1' });
  });

  it('does not exclude returnValue/error when the caller owns the requested session', async () => {
    mockSessionFind.mockResolvedValue([{ _id: 'sess-1', userId: 'caller-1' }]);
    const collection = fakeCollection();
    mockFindModelByCollectionName.mockReturnValue(collection);

    await func(questEvent() as any, {} as any, noopLogger as any);

    const scopedFields = collection.find.mock.calls[0][1];
    expect(scopedFields).not.toHaveProperty('promptMeta.functionCalls.returnValue');
    expect(scopedFields).not.toHaveProperty('promptMeta.functionCalls.error');
  });

  it('still excludes returnValue/error when the caller only has a share on the requested session', async () => {
    // A different owner on the SAME accessible session id - accessibleBy already scoped it in,
    // but it isn't the caller's own.
    mockSessionFind.mockResolvedValue([{ _id: 'sess-1', userId: 'someone-else' }]);
    const collection = fakeCollection();
    mockFindModelByCollectionName.mockReturnValue(collection);

    await func(questEvent() as any, {} as any, noopLogger as any);

    const scopedFields = collection.find.mock.calls[0][1];
    expect(scopedFields).toMatchObject({
      'promptMeta.functionCalls.returnValue': false,
      'promptMeta.functionCalls.error': false,
    });
  });

  it('drops inclusion fields and keeps the exclusion instead of throwing, when a caller mixes the two', async () => {
    mockSessionFind.mockResolvedValue([{ _id: 'sess-1', userId: 'someone-else' }]);
    const collection = fakeCollection();
    mockFindModelByCollectionName.mockReturnValue(collection);

    await func(questEvent({ fields: { reply: 1 } }) as any, {} as any, noopLogger as any);

    const scopedFields = collection.find.mock.calls[0][1];
    expect(scopedFields).toEqual({
      'promptMeta.functionCalls.returnValue': false,
      'promptMeta.functionCalls.error': false,
    });
    expect(noopLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Dropping inclusion fields'), {
      fields: { reply: 1 },
    });
  });
});
