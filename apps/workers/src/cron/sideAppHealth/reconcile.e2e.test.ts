import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentExecutionModel, ApiKeyUsageLog, Quest, SideAppAlertState, SideAppRefusal } from '@bike4mind/database';
import {
  PLATFORM_RULE,
  PLATFORM_SCOPE,
  REMINDER_INTERVAL_MS,
  emptyWindowCounts,
  type ClientVerdict,
  type DesiredAlert,
} from '@bike4mind/server-utils/sideApps/health/rules';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { classifyHealthRow } from '@bike4mind/server-utils/sideApps/health/rows';
import { collectHealthRows } from './collect';
import { reconcileAlerts, type ReconcileContext } from './reconcile';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const t0 = new Date('2026-11-18T10:00:00.000Z');
const verdict = (clientId: string): ClientVerdict => ({
  clientId,
  armed: true,
  rule: 'failing',
  lastHour: { ...emptyWindowCounts(), failures: 9, ourFaultFailures: 9 },
  hoursSinceSuccess: 1,
  silenceThresholdHours: 6,
  topReasons: [],
});
const silentVerdict = (clientId: string): ClientVerdict => ({
  ...verdict(clientId),
  rule: 'silent',
  hoursSinceSuccess: 40,
});
const silent = (scope: string): DesiredAlert => ({
  scope,
  rule: 'silent',
  muted: false,
  verdict: silentVerdict(scope),
});
const failing = (scope: string, muted = false): DesiredAlert => ({
  scope,
  rule: 'failing',
  muted,
  verdict: verdict(scope),
});

describe('side app health state and delivery', () => {
  let server: Awaited<ReturnType<typeof createMongoServer>>;
  const post = vi.fn<(message: { text: string; blocks: unknown[] }) => Promise<boolean>>();
  const ctxAt = (now: Date): ReconcileContext => ({
    now,
    armedClientIds: ['a', 'b'],
    lookupNames: async ids => new Map(ids.map(id => [id, `App ${id}`])),
    appUrl: 'https://app.example.test',
    stageLabel: 'Test',
    post,
  });
  const texts = () => post.mock.calls.map(([m]) => m.text);

  beforeAll(async () => {
    server = await createMongoServer();
    await mongoose.connect(server.getUri());
    await SideAppAlertState.init();
  });
  beforeEach(async () => {
    post.mockReset();
    post.mockResolvedValue(true);
    await SideAppAlertState.deleteMany({});
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });

  it('opens once, stays quiet inside 24 hours, reminds after, and resolves once', async () => {
    expect(await reconcileAlerts([failing('a')], ctxAt(t0))).toMatchObject({ opened: 1 });
    expect(await reconcileAlerts([failing('a')], ctxAt(new Date(t0.getTime() + 60 * 60 * 1000)))).toMatchObject({
      opened: 0,
      reminded: 0,
    });
    expect(await reconcileAlerts([failing('a')], ctxAt(new Date(t0.getTime() + REMINDER_INTERVAL_MS)))).toMatchObject({
      reminded: 1,
    });
    const resolvedAt = new Date(t0.getTime() + REMINDER_INTERVAL_MS + 3 * 60 * 60 * 1000);
    expect(await reconcileAlerts([], ctxAt(resolvedAt))).toMatchObject({ resolved: 1 });
    expect(await reconcileAlerts([], ctxAt(new Date(resolvedAt.getTime() + 1000)))).toMatchObject({ resolved: 0 });

    expect(texts()).toHaveLength(3);
    expect(texts()[0]).toContain('Connected app alert');
    expect(texts()[1]).toContain('still open');
    expect(texts()[2]).toContain('recovered');
    expect(texts().join(' ')).toContain('App a');
  });

  it('sends once when two runs open the same alert at the same time', async () => {
    const results = await Promise.all([
      reconcileAlerts([failing('a')], ctxAt(t0)),
      reconcileAlerts([failing('a')], ctxAt(t0)),
      reconcileAlerts([failing('a')], ctxAt(t0)),
    ]);
    expect(results.reduce((sum, r) => sum + r.opened, 0)).toBe(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(await SideAppAlertState.countDocuments({ open: true })).toBe(1);
  });

  it('opens a fresh alert after the previous one resolved', async () => {
    await reconcileAlerts([failing('a')], ctxAt(t0));
    await reconcileAlerts([], ctxAt(new Date(t0.getTime() + 1000)));
    expect(await reconcileAlerts([failing('a')], ctxAt(new Date(t0.getTime() + 2000)))).toMatchObject({ opened: 1 });
    expect(await SideAppAlertState.countDocuments({})).toBe(2);
    expect(texts().filter(t => t.includes('Connected app alert'))).toHaveLength(2);
  });

  it('does not mark a failed post as sent: the next run sends it, and later alerts still go out', async () => {
    post.mockResolvedValueOnce(false);
    const first = await reconcileAlerts([failing('a'), failing('b')], ctxAt(t0));
    expect(first).toMatchObject({ opened: 1, postFailures: 1 });
    expect(post).toHaveBeenCalledTimes(2);

    post.mockClear();
    const next = await reconcileAlerts([failing('a'), failing('b')], ctxAt(new Date(t0.getTime() + 1000)));
    expect(next).toMatchObject({ opened: 1, postFailures: 0 });
    expect(post).toHaveBeenCalledTimes(1);
    expect(texts()[0]).toContain('App a');
  });

  it('treats a throwing post like a failed one', async () => {
    post.mockRejectedValueOnce(new Error('network down'));
    expect(await reconcileAlerts([failing('a')], ctxAt(t0))).toMatchObject({ opened: 0, postFailures: 1 });
    expect(await reconcileAlerts([failing('a')], ctxAt(new Date(t0.getTime() + 1000)))).toMatchObject({ opened: 1 });
  });

  it('retracts nothing for an alert that never got out', async () => {
    post.mockResolvedValueOnce(false);
    await reconcileAlerts([failing('a')], ctxAt(t0));
    post.mockClear();
    expect(await reconcileAlerts([], ctxAt(new Date(t0.getTime() + 1000)))).toMatchObject({ resolved: 0 });
    expect(post).not.toHaveBeenCalled();
    expect(await SideAppAlertState.countDocuments({ open: true })).toBe(0);
  });

  it('sends one platform alert while per-client alerts are muted, and keeps muted ones open without a recovery message', async () => {
    await reconcileAlerts([failing('a'), failing('b')], ctxAt(t0));
    post.mockClear();

    const muted: DesiredAlert[] = [
      failing('a', true),
      failing('b', true),
      { scope: PLATFORM_SCOPE, rule: PLATFORM_RULE, muted: false },
    ];
    const later = new Date(t0.getTime() + 60 * 60 * 1000);
    expect(await reconcileAlerts(muted, ctxAt(later))).toMatchObject({ opened: 1, resolved: 0 });
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('all connected apps are down');
    expect(await SideAppAlertState.countDocuments({ open: true })).toBe(3);

    expect(await reconcileAlerts(muted, ctxAt(new Date(later.getTime() + 1000)))).toMatchObject({ opened: 0 });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('keeps an alert open and says nothing when its client is still desired as the same rule', async () => {
    await reconcileAlerts([failing('a')], ctxAt(t0));
    post.mockClear();
    expect(await reconcileAlerts([failing('a')], ctxAt(new Date(t0.getTime() + 1000)))).toMatchObject({ resolved: 0 });
    expect(post).not.toHaveBeenCalled();
    expect(await SideAppAlertState.countDocuments({ open: true })).toBe(1);
  });

  it('opens silent and closes failing without a recovery message when the rule changes', async () => {
    await reconcileAlerts([failing('a')], ctxAt(t0));
    post.mockClear();
    const next = await reconcileAlerts([silent('a')], ctxAt(new Date(t0.getTime() + 60 * 60 * 1000)));
    expect(next).toMatchObject({ opened: 1, resolved: 0 });
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('traffic has gone silent');
    expect(texts().join(' ')).not.toContain('recovered');
    expect(await SideAppAlertState.countDocuments({ open: true, rule: 'silent' })).toBe(1);
    expect(await SideAppAlertState.countDocuments({ open: true, rule: 'failing' })).toBe(0);
  });

  it('closes an alert for an app with no traffic with one untracked message', async () => {
    await reconcileAlerts([silent('a')], ctxAt(t0));
    post.mockClear();
    const untracked = [{ scope: 'a', rule: 'silent' }];
    const next = await reconcileAlerts([], ctxAt(new Date(t0.getTime() + 1000)), untracked);
    expect(next).toMatchObject({ resolved: 1 });
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('no traffic for 14 days');
    expect(texts()[0]).not.toContain('recovered');
    expect(await SideAppAlertState.countDocuments({ open: true })).toBe(0);
  });

  it('keeps an untracked alert open and retries when its post fails', async () => {
    await reconcileAlerts([silent('a')], ctxAt(t0));
    post.mockClear();
    post.mockResolvedValueOnce(false);
    const untracked = [{ scope: 'a', rule: 'silent' }];
    expect(await reconcileAlerts([], ctxAt(new Date(t0.getTime() + 1000)), untracked)).toMatchObject({
      resolved: 0,
      postFailures: 1,
    });
    expect(await SideAppAlertState.countDocuments({ open: true })).toBe(1);
    expect(await reconcileAlerts([], ctxAt(new Date(t0.getTime() + 2000)), untracked)).toMatchObject({ resolved: 1 });
    expect(await SideAppAlertState.countDocuments({ open: true })).toBe(0);
  });

  it('closes a never-notified untracked alert without a post', async () => {
    post.mockResolvedValueOnce(false);
    await reconcileAlerts([silent('a')], ctxAt(t0));
    post.mockClear();
    const untracked = [{ scope: 'a', rule: 'silent' }];
    expect(await reconcileAlerts([], ctxAt(new Date(t0.getTime() + 1000)), untracked)).toMatchObject({ resolved: 0 });
    expect(post).not.toHaveBeenCalled();
    expect(await SideAppAlertState.countDocuments({ open: true })).toBe(0);
  });

  it('retries a failed recovery post on the next run and sends it once', async () => {
    await reconcileAlerts([failing('a')], ctxAt(t0));
    post.mockClear();
    post.mockResolvedValueOnce(false);
    const first = await reconcileAlerts([], ctxAt(new Date(t0.getTime() + 1000)));
    expect(first).toMatchObject({ resolved: 0, postFailures: 1 });
    expect(await SideAppAlertState.countDocuments({ open: true })).toBe(1);

    const results = await Promise.all([
      reconcileAlerts([], ctxAt(new Date(t0.getTime() + 2000))),
      reconcileAlerts([], ctxAt(new Date(t0.getTime() + 2000))),
    ]);
    expect(results.reduce((sum, r) => sum + r.resolved, 0)).toBe(1);
    expect(texts().filter(t => t.includes('recovered'))).toHaveLength(2);
    expect(await SideAppAlertState.countDocuments({ open: true })).toBe(0);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('stores a muted alert unannounced and announces it once, with its original opening time, when the platform alert ends', async () => {
    const platform: DesiredAlert = { scope: PLATFORM_SCOPE, rule: PLATFORM_RULE, muted: false };
    expect(await reconcileAlerts([failing('a', true), platform], ctxAt(t0))).toMatchObject({ opened: 1 });
    expect(texts()).toHaveLength(1);
    const stored = await SideAppAlertState.findOne({ scope: 'a', open: true }).lean();
    expect(stored?.lastNotifiedAt).toBeUndefined();
    expect(stored?.openedAt.getTime()).toBe(t0.getTime());

    const later = new Date(t0.getTime() + 3 * 60 * 60 * 1000);
    expect(await reconcileAlerts([failing('a', true), platform], ctxAt(later))).toMatchObject({ reminded: 0 });
    expect(texts()).toHaveLength(1);

    post.mockClear();
    const cleared = new Date(later.getTime() + 60 * 60 * 1000);
    await reconcileAlerts([failing('a')], ctxAt(cleared));
    await reconcileAlerts([failing('a')], ctxAt(new Date(cleared.getTime() + 1000)));
    expect(texts().filter(t => t.includes('Connected app alert:') || t.includes('Connected app alert ['))).toHaveLength(
      1
    );
    expect(texts()[0]).not.toContain('still open');
    const after = await SideAppAlertState.findOne({ scope: 'a', open: true }).lean();
    expect(after?.openedAt.getTime()).toBe(t0.getTime());
    expect(after?.lastNotifiedAt?.getTime()).toBe(cleared.getTime());
  });

  it('never carries user identifiers in a message', async () => {
    await reconcileAlerts([failing('a')], ctxAt(t0));
    expect(JSON.stringify(post.mock.calls[0][0])).not.toMatch(/userId|email/i);
  });
});

describe('collectHealthRows against MongoDB', () => {
  let server: Awaited<ReturnType<typeof createMongoServer>>;
  const hour = new Date('2026-11-18T09:00:00.000Z');
  const inHour = (minutes: number) => new Date(hour.getTime() + minutes * 60_000);

  beforeAll(async () => {
    server = await createMongoServer();
    await mongoose.connect(server.getUri());
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });

  it('groups all four sources by client and clock hour and skips non-exchange rows', async () => {
    await ApiKeyUsageLog.collection.insertMany([
      { oauthClientId: 'app', timestamp: inHour(5), endpoint: '/api/tools/web-search', statusCode: 200 },
      { oauthClientId: 'app', timestamp: inHour(50), endpoint: '/api/tools/web-search', statusCode: 200 },
      { oauthClientId: 'app', timestamp: inHour(7), endpoint: '/api/chat', statusCode: 500 },
      { timestamp: inHour(7), endpoint: '/api/chat', statusCode: 500 },
    ]);
    await Quest.collection.insertOne({ oauthClientId: 'app', timestamp: inHour(10), status: 'done' });
    await AgentExecutionModel.collection.insertOne({ oauthClientId: 'app', createdAt: inHour(12), status: 'failed' });
    await SideAppRefusal.collection.insertOne({
      clientId: 'app',
      stage: 'mint',
      reason: 'server_error',
      status: 500,
      createdAt: inHour(15),
    });

    const from = new Date(hour.getTime() - 60 * 60 * 1000);
    const to = new Date(hour.getTime() + 2 * 60 * 60 * 1000);
    const bucketed = await collectHealthRows(from, to, true);
    expect(bucketed.every(row => row.clientId === 'app' && row.hourStart === hour.getTime())).toBe(true);
    expect(bucketed.map(row => [row.source, row.count]).sort()).toEqual(
      [
        ['agent', 1],
        ['quest', 1],
        ['refusal', 1],
        ['usage', 1],
        ['usage', 2],
      ].sort()
    );

    const flat = await collectHealthRows(from, to, false);
    expect(flat.every(row => row.hourStart === 0)).toBe(true);
    expect(await collectHealthRows(new Date(hour.getTime() + 3 * 60 * 60 * 1000), to, true)).toEqual([]);
  });

  it('carries the failure code of a failed completion into the row and its failure reason', async () => {
    const codedHour = new Date('2026-11-19T09:00:00.000Z');
    const observation = (outcome: string, failureCode?: string) => ({
      requestId: 'r',
      requestedModel: 'm',
      startedAt: 's',
      outcome,
      failureCode,
    });
    await ApiKeyUsageLog.collection.insertMany([
      {
        oauthClientId: 'coded',
        timestamp: new Date(codedHour.getTime() + 60_000),
        endpoint: '/api/chat',
        statusCode: 202,
        completionObservation: observation('failed', 'some_code'),
      },
      {
        oauthClientId: 'coded',
        timestamp: new Date(codedHour.getTime() + 120_000),
        endpoint: '/api/chat',
        statusCode: 202,
        completionObservation: observation('failed', 'other_code'),
      },
    ]);

    const rows = await collectHealthRows(codedHour, new Date(codedHour.getTime() + 60 * 60 * 1000), true);
    const reasons = rows
      .map(row => classifyHealthRow(row))
      .map(event => (event?.kind === 'failure' ? event.reason : ''));
    expect(rows).toHaveLength(2);
    expect(reasons.sort()).toEqual(['completion_failed other_code', 'completion_failed some_code']);
  });
});
