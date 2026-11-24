import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ApiKeyScope,
  type SpendFeatureAggregate,
  type SpendFeaturesResponse,
  type SpendFeatureUsersPage,
  type SpendFeatureUsersResponse,
} from '@bike4mind/common';

const m = vi.hoisted(() => ({
  spendFeatures: vi.fn(),
  spendFeatureUsers: vi.fn(),
  spendActorIds: vi.fn(),
  getSettingsValue: vi.fn(),
  userFind: vi.fn(),
  loadUserFlags: vi.fn(),
  getCachedData: vi.fn((_key: string, factory: () => unknown) => factory()),
}));

vi.mock('@server/middlewares/baseApi', async () => ({
  baseApi: (await import('@server/admin/spendExplorer/__tests__/routeTestHarness')).baseApiStub,
}));
vi.mock('@bike4mind/database', () => ({
  usageEventRepository: {
    spendFeatures: (...a: unknown[]) => m.spendFeatures(...a),
    spendFeatureUsers: (...a: unknown[]) => m.spendFeatureUsers(...a),
    spendActorIds: (...a: unknown[]) => m.spendActorIds(...a),
  },
  adminSettingsRepository: { getSettingsValue: (...a: unknown[]) => m.getSettingsValue(...a) },
  cacheRepository: {},
  User: { find: (...a: unknown[]) => m.userFind(...a) },
  Organization: { find: vi.fn() },
  AdminAuditLogModel: { find: vi.fn() },
}));
vi.mock('@bike4mind/services', () => ({
  cacheService: { getCachedData: (...a: unknown[]) => m.getCachedData(...(a as [string, () => unknown])) },
}));
// Real isCountedUser, a fixed counting context, and flags served from the test.
vi.mock('@bike4mind/server-utils/analytics/signupCohort', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/analytics/signupCohort')>()),
  loadCountingContext: async () => ({ staffRegex: /@staff\.example$/i, testDomains: [] }),
  loadUserFlags: (...a: unknown[]) => m.loadUserFlags(...a),
}));

import featuresHandler from '../features';
import featureUsersHandler from '../feature-users';
import { findReturning, runGet } from '@server/admin/spendExplorer/__tests__/routeTestHarness';

const ADMIN_ID = 'a'.repeat(24);
const STAFF_ID = 'b'.repeat(24);
const CUSTOMER_ID = 'c'.repeat(24);

const RANGE = { from: '2026-03-08T00:00:00Z', to: '2026-03-11T00:00:00Z' };

const totals = (overrides: Partial<SpendFeatureAggregate> = {}): SpendFeatureAggregate => ({
  feature: 'chat',
  requests: 10,
  failedRequests: 0,
  costUsd: 0,
  creditsCharged: 0,
  units: 0,
  distinctUsers: 1,
  lastDayUsd: 0,
  trailingUsd: 0,
  daily: [],
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.getSettingsValue.mockResolvedValue(3);
  m.spendActorIds.mockResolvedValue([ADMIN_ID, STAFF_ID, CUSTOMER_ID]);
  m.loadUserFlags.mockResolvedValue(
    new Map([
      [ADMIN_ID, { _id: ADMIN_ID, isAdmin: true, email: 'a@customer.example' }],
      [STAFF_ID, { _id: STAFF_ID, email: 'b@staff.example' }],
      [CUSTOMER_ID, { _id: CUSTOMER_ID, email: 'c@customer.example' }],
    ])
  );
  m.userFind.mockImplementation(
    findReturning([
      { _id: CUSTOMER_ID, name: 'Customer C' },
      { _id: ADMIN_ID, name: 'Admin A' },
    ])
  );
});

describe('GET /api/admin/spend-explorer/features', () => {
  it('is admin-gated, first-party JWT only, with the admin API-key scope', async () => {
    const config = (featuresHandler as unknown as { _config: { requiredScopes: string[]; auth: string } })._config;
    expect(config.requiredScopes).toEqual([ApiKeyScope.ADMIN]);
    expect(config.auth).toBe('jwtOnly');
    m.spendFeatures.mockResolvedValue([]);
    const denied = await runGet(featuresHandler, RANGE, { isAdmin: false, id: 'd', adminPermissions: [] });
    expect(denied.thrown).toMatchObject({ statusCode: 403 });
    const allowed = await runGet(featuresHandler, RANGE, {
      isAdmin: false,
      id: 'd',
      adminPermissions: ['support:read'],
    });
    expect(allowed.thrown).toBeUndefined();
  });

  it('rejects a reversed range', async () => {
    const { thrown } = await runGet(featuresHandler, { from: RANGE.to, to: RANGE.from });
    expect(thrown).toMatchObject({ statusCode: 400 });
  });

  it('snaps to whole UTC days, ranks features by cost and flags last-day spikes', async () => {
    m.spendFeatures.mockResolvedValue([
      totals({
        feature: 'chat',
        costUsd: 20,
        lastDayUsd: 2,
        trailingUsd: 14,
        daily: [{ day: '2026-03-09', costUsd: 20 }],
      }),
      totals({ feature: 'music_generation', costUsd: 60, units: 300, lastDayUsd: 50, trailingUsd: 7 }),
      // Only trailing-window events: nothing in range, so no row.
      totals({ feature: 'image_generation', requests: 0, trailingUsd: 5 }),
    ]);

    const { body } = await runGet<SpendFeaturesResponse>(featuresHandler, {
      from: '2026-03-08T05:00:00Z',
      to: '2026-03-10T05:00:00Z',
    });

    expect(m.spendFeatures).toHaveBeenCalledWith({
      from: new Date('2026-03-08T00:00:00Z'),
      to: new Date('2026-03-11T00:00:00Z'),
      spikeEnd: new Date('2026-03-11T00:00:00Z'),
      actorUserId: undefined,
      userFilter: undefined,
    });
    expect(body!.days).toEqual(['2026-03-08', '2026-03-09', '2026-03-10']);
    expect(body!.lastDayStart).toBe('2026-03-10T00:00:00.000Z');
    expect(body!.totalCostUsd).toBe(80);
    expect(body!.features.map(f => f.feature)).toEqual(['music_generation', 'chat']);
    const [music, chat] = body!.features;
    expect(music).toMatchObject({ share: 0.75, unitLabel: 'seconds', trailingAvgUsd: 1, isSpike: true });
    expect(chat).toMatchObject({ share: 0.25, unitLabel: null, trailingAvgUsd: 2, isSpike: false });
    expect(chat.dailyUsd).toEqual([0, 20, 0]);
  });

  describe('while the range ends today', () => {
    afterEach(() => vi.useRealTimers());

    it('compares the last complete day, not the partial day in progress', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-03-10T06:00:00Z'));
      m.spendFeatures.mockResolvedValue([]);

      const { body } = await runGet<SpendFeaturesResponse>(featuresHandler, RANGE);

      expect(m.spendFeatures.mock.calls[0][0]).toMatchObject({
        to: new Date('2026-03-11T00:00:00Z'),
        spikeEnd: new Date('2026-03-10T00:00:00Z'),
      });
      expect(body!.lastDayStart).toBe('2026-03-09T00:00:00.000Z');
      expect(body!.days).toHaveLength(3);
    });
  });

  it('falls back to the default spike multiple while the setting is unsaved', async () => {
    m.getSettingsValue.mockResolvedValue(undefined);
    m.spendFeatures.mockResolvedValue([]);
    const { body } = await runGet<SpendFeaturesResponse>(featuresHandler, RANGE);
    expect(body!.spikeMultiple).toBe(3);
  });

  it('flags spikes against the saved spike multiple, not the default', async () => {
    m.getSettingsValue.mockResolvedValue(2);
    // A $5 last day over a $2 trailing average is a spike at 2x but not at the default 3x.
    m.spendFeatures.mockResolvedValue([totals({ feature: 'chat', costUsd: 20, lastDayUsd: 5, trailingUsd: 14 })]);
    const { body } = await runGet<SpendFeaturesResponse>(featuresHandler, RANGE);
    expect(body!.spikeMultiple).toBe(2);
    expect(body!.features[0]).toMatchObject({ trailingAvgUsd: 2, isSpike: true });
  });

  it('classifies internal users with the Analytics rule for each audience', async () => {
    m.spendFeatures.mockResolvedValue([]);
    await runGet(featuresHandler, { ...RANGE, audience: 'internal' });
    await runGet(featuresHandler, { ...RANGE, audience: 'external' });
    const [internalCall, externalCall] = m.spendFeatures.mock.calls.map(call => call[0]);
    // The admin flag and the staff email domain are internal; the customer is not.
    expect(internalCall.userFilter).toEqual({ mode: 'include', userIds: [ADMIN_ID, STAFF_ID] });
    expect(externalCall.userFilter).toEqual({ mode: 'exclude', userIds: [ADMIN_ID, STAFF_ID] });
  });

  it('narrows to one user and keys the cache by every input', async () => {
    m.spendFeatures.mockResolvedValue([]);
    await runGet(featuresHandler, RANGE);
    await runGet(featuresHandler, { ...RANGE, userId: CUSTOMER_ID });
    await runGet(featuresHandler, { ...RANGE, audience: 'external' });
    expect(m.spendFeatures.mock.calls[1][0]).toMatchObject({ actorUserId: CUSTOMER_ID });
    expect(new Set(m.getCachedData.mock.calls.map(call => call[0])).size).toBe(3);
  });
});

describe('GET /api/admin/spend-explorer/feature-users', () => {
  const page = (users: SpendFeatureUsersPage['users'], featureCostUsd = 100): SpendFeatureUsersPage => ({
    users,
    totalUsers: 41,
    featureCostUsd,
  });
  const user = (userId: string, overrides: Partial<SpendFeatureUsersPage['users'][number]> = {}) => ({
    userId,
    requests: 4,
    failedRequests: 1,
    costUsd: 0,
    creditsCharged: 0,
    units: 0,
    lastDayUsd: 0,
    trailingUsd: 0,
    ...overrides,
  });

  it('is admin-gated, first-party JWT only, with the admin API-key scope', async () => {
    const config = (featureUsersHandler as unknown as { _config: { requiredScopes: string[]; auth: string } })._config;
    expect(config.requiredScopes).toEqual([ApiKeyScope.ADMIN]);
    expect(config.auth).toBe('jwtOnly');
    m.spendFeatureUsers.mockResolvedValue(page([]));
    const query = { ...RANGE, feature: 'music_generation' };
    const denied = await runGet(featureUsersHandler, query, { isAdmin: false, id: 'd', adminPermissions: [] });
    expect(denied.thrown).toMatchObject({ statusCode: 403 });
    const allowed = await runGet(featureUsersHandler, query, {
      isAdmin: false,
      id: 'd',
      adminPermissions: ['support:read'],
    });
    expect(allowed.thrown).toBeUndefined();
  });

  it('flags user spikes against the saved spike multiple', async () => {
    m.getSettingsValue.mockResolvedValue(2);
    m.spendFeatureUsers.mockResolvedValue(page([user(CUSTOMER_ID, { costUsd: 20, lastDayUsd: 5, trailingUsd: 14 })]));
    const { body } = await runGet<SpendFeatureUsersResponse>(featureUsersHandler, {
      ...RANGE,
      feature: 'music_generation',
    });
    expect(body!.spikeMultiple).toBe(2);
    expect(body!.users[0]).toMatchObject({ trailingAvgUsd: 2, isSpike: true });
  });

  it('requires a feature and caps the page size', async () => {
    expect((await runGet(featureUsersHandler, RANGE)).thrown).toMatchObject({ statusCode: 400 });
    expect(
      (await runGet(featureUsersHandler, { ...RANGE, feature: 'music_generation', limit: '500' })).thrown
    ).toMatchObject({ statusCode: 400 });
    expect((await runGet(featureUsersHandler, { ...RANGE, feature: '$where' })).thrown).toMatchObject({
      statusCode: 400,
    });
  });

  it('pages users with names, share of the feature and spike flags', async () => {
    m.spendFeatureUsers.mockResolvedValue(
      page([
        user(ADMIN_ID, { costUsd: 75, lastDayUsd: 40, trailingUsd: 0 }),
        user(CUSTOMER_ID, { costUsd: 25, lastDayUsd: 3, trailingUsd: 21 }),
        user('agent-pool', { costUsd: 0 }),
      ])
    );

    const { body } = await runGet<SpendFeatureUsersResponse>(featureUsersHandler, {
      ...RANGE,
      feature: 'music_generation',
      limit: '3',
      offset: '6',
    });

    expect(m.spendFeatureUsers).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'music_generation', limit: 3, offset: 6, userFilter: undefined })
    );
    expect(body).toMatchObject({
      feature: 'music_generation',
      unitLabel: 'seconds',
      totalUsers: 41,
      featureCostUsd: 100,
      spikeMultiple: 3,
    });
    expect(body!.users).toEqual([
      expect.objectContaining({ userId: ADMIN_ID, name: 'Admin A', share: 0.75, isSpike: true }),
      expect.objectContaining({ userId: CUSTOMER_ID, name: 'Customer C', share: 0.25, trailingAvgUsd: 3 }),
      expect.objectContaining({ userId: 'agent-pool', name: 'agent-pool', isSpike: false }),
    ]);
    expect(body!.users[1].isSpike).toBe(false);
  });

  it('scopes audience classification to the feature', async () => {
    m.spendFeatureUsers.mockResolvedValue(page([]));
    await runGet(featureUsersHandler, { ...RANGE, feature: 'music_generation', audience: 'internal' });
    expect(m.spendActorIds).toHaveBeenCalledWith(expect.objectContaining({ feature: 'music_generation' }));
    expect(m.spendFeatureUsers.mock.calls[0][0].userFilter).toEqual({
      mode: 'include',
      userIds: [ADMIN_ID, STAFF_ID],
    });
  });
});
