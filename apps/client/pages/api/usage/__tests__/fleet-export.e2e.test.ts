import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';
import { CounterLog, UsageEvent, User } from '@bike4mind/database';
import { resolveApiCompletionSource } from '@bike4mind/common';
import handler from '../fleet-export';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'unused', STAGE: 'test' } }));
vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/database')>()),
  connectDB: vi.fn(),
}));

let server: MongoMemoryServer;
const actor = new mongoose.Types.ObjectId().toString();
const outsider = new mongoose.Types.ObjectId().toString();
const missingActor = new mongoose.Types.ObjectId().toString();
const owner = 'billing-owner';
const token = 'test-export-credential-with-at-least-32-characters';
const scope = { userIds: [actor, missingActor], owners: [{ ownerId: owner, ownerType: 'Organization' }] };

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.stubEnv('FLEET_USAGE_EXPORT_TOKEN', token);
  vi.stubEnv('FLEET_USAGE_EXPORT_SCOPE', JSON.stringify(scope));
  await Promise.all([UsageEvent.deleteMany({}), User.deleteMany({}), CounterLog.deleteMany({})]);
  await User.collection.insertMany([
    { _id: new mongoose.Types.ObjectId(actor), username: 'export-actor', email: 'actor@example.test' },
    { _id: new mongoose.Types.ObjectId(outsider), username: 'export-outsider', email: 'outsider@example.test' },
  ]);
});

const event = (overrides: Record<string, unknown> = {}) => ({
  requestId: 'request',
  userId: actor,
  ownerId: owner,
  ownerType: 'Organization',
  feature: 'completion_api',
  provider: 'provider-a',
  model: 'exact-model',
  source: resolveApiCompletionSource({ 'User-Agent': 'b4m-desktop/1.2.3' }),
  settledBasis: 'provider',
  status: 'ok',
  inputTokens: 100,
  outputTokens: 20,
  providerInputTokens: 90,
  providerOutputTokens: 18,
  cachedInputTokens: 40,
  cacheWriteTokens: 5,
  costUsd: 0.01,
  creditsCharged: 5,
  writtenOffCredits: 1,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

async function call(
  options: { authorization?: string; query?: Record<string, unknown>; method?: 'GET' | 'POST' } = {}
) {
  const { req, res } = createMocks({
    method: options.method ?? 'GET',
    query: options.query ?? { from: '2026-01-01', to: '2026-01-03' },
    headers: { authorization: options.authorization ?? `Bearer ${token}` },
  });
  await handler(req, res);
  return { status: res._getStatusCode(), body: res._getJSONData(), res };
}

describe('Fleet export route against real Mongo', () => {
  it('serves the allow and deny paths through real HTTP with durable audit records', async () => {
    await UsageEvent.collection.insertOne(event());
    const http = createServer(async (incoming, outgoing) => {
      const { req, res } = createMocks({
        method: 'GET',
        query: { from: '2026-01-01', to: '2026-01-03' },
        headers: incoming.headers,
      });
      await handler(req, res);
      outgoing.writeHead(res._getStatusCode(), res._getHeaders());
      outgoing.end(res._getData());
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/usage/fleet-export?from=2026-01-01&to=2026-01-03`;
      const allowed = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      expect(allowed.status).toBe(200);
      const snapshot = await allowed.json();
      expect(snapshot.days[0].rows[0]).toMatchObject({ userId: actor, email: 'actor@example.test', source: 'desktop' });
      const denied = await fetch(url);
      expect(denied.status).toBe(401);
      expect(await denied.json()).not.toHaveProperty('days');
      expect(await CounterLog.countDocuments({ 'metadata.outcome': 'allow' })).toBe(1);
      expect(await CounterLog.countDocuments({ 'metadata.outcome': 'deny' })).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => http.close(error => (error ? reject(error) : resolve())));
    }
  });

  it('exports only allowed actors AND billing owner pairs, with account email and no content', async () => {
    await UsageEvent.collection.insertMany([
      event({ prompt: 'not exported', toolArguments: 'not exported', path: '/not-exported' }),
      event({ userId: outsider }),
      event({ ownerId: 'outside-owner' }),
      event({ ownerType: 'User' }),
      event({ createdAt: new Date('2025-12-31T23:59:59.999Z') }),
      event({ createdAt: new Date('2026-01-04T00:00:00.000Z') }),
    ]);
    const { status, body, res } = await call();
    expect(status).toBe(200);
    expect(body.days.map((day: { date: string }) => day.date)).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);
    expect(body.days[0].rows).toHaveLength(1);
    expect(body.days[0].rows[0]).toEqual({
      userId: actor,
      email: 'actor@example.test',
      ownerId: owner,
      ownerType: 'Organization',
      provider: 'provider-a',
      model: 'exact-model',
      source: 'desktop',
      settledBasis: 'provider',
      status: 'ok',
      inputTokens: 100,
      outputTokens: 20,
      providerInputTokens: 90,
      providerOutputTokens: 18,
      cacheReadTokens: 40,
      cacheWriteTokens: 5,
      costUsd: 0.01,
      creditsCharged: 5,
      writtenOffCredits: 1,
      requests: 1,
    });
    expect(body.days[1].rows).toEqual([]);
    expect(body.days[2].rows).toEqual([]);
    expect(res.getHeader('Cache-Control')).toBe('no-store');
    const audit = await CounterLog.findOne({ counterName: 'Fleet Usage Export Access' }).lean();
    expect(audit?.metadata).toMatchObject({ outcome: 'allow', from: '2026-01-01', to: '2026-01-03' });
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it('preserves every grouping dimension, failures, inclusive caches and partial provider axes', async () => {
    await UsageEvent.collection.insertMany([
      event(),
      event({ providerOutputTokens: undefined }),
      event({ status: 'error', costUsd: 0.03, creditsCharged: 8 }),
      event({ settledBasis: 'local' }),
      event({ provider: 'provider-b' }),
      event({ model: 'other-model' }),
      event({ userId: missingActor }),
      event({ source: 'cli' }),
      event({ source: 'api' }),
      event({ source: undefined, settledBasis: undefined }),
      event({ createdAt: new Date('2026-01-03T23:59:59.999Z') }),
    ]);
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body.days[0].rows).toHaveLength(9);
    const rows = body.days[0].rows;
    const combined = rows.find((row: Record<string, unknown>) => row.requests === 2);
    expect(combined).toMatchObject({
      inputTokens: 200,
      outputTokens: 40,
      providerInputTokens: 180,
      providerOutputTokens: null,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
      costUsd: 0.02,
      creditsCharged: 10,
      writtenOffCredits: 2,
    });
    expect(rows.find((row: Record<string, unknown>) => row.status === 'error')).toMatchObject({
      costUsd: 0.03,
      creditsCharged: 8,
    });
    expect(rows.find((row: Record<string, unknown>) => row.userId === missingActor)?.email).toBeNull();
    expect(rows.find((row: Record<string, unknown>) => row.source === 'unclassified')?.settledBasis).toBe(
      'unclassified'
    );
    expect(body.days[2].rows).toHaveLength(1);
    expect((await UsageEvent.findOne({ source: { $exists: false } }).lean())?.source).toBeUndefined();
  });

  it('returns replaceable identical rows and reflects late records without accumulated pulls', async () => {
    await UsageEvent.collection.insertOne(event());
    const first = await call();
    const second = await call();
    expect(second.body.days).toEqual(first.body.days);
    await UsageEvent.collection.insertOne(event());
    const third = await call();
    expect(third.body.days[0].rows[0].requests).toBe(2);
    expect(await UsageEvent.countDocuments()).toBe(2);
    await UsageEvent.deleteMany({});
    expect((await call()).body.days.every((day: { rows: unknown[] }) => day.rows.length === 0)).toBe(true);
  });

  it('denies wrong/missing/default credentials and scope and persists denial audits', async () => {
    await UsageEvent.collection.insertOne(event());
    const read = vi.spyOn(UsageEvent, 'find');
    for (const authorization of ['', 'Bearer wrong', 'Bearer ordinary-api-key']) {
      expect((await call({ authorization })).status).toBe(401);
    }
    for (const config of [
      '',
      '{}',
      'null',
      JSON.stringify({ ...scope, userIds: [] }),
      JSON.stringify({ ...scope, owners: [] }),
    ]) {
      vi.stubEnv('FLEET_USAGE_EXPORT_SCOPE', config);
      expect((await call()).status).toBe(401);
    }
    vi.stubEnv('FLEET_USAGE_EXPORT_SCOPE', JSON.stringify(scope));
    vi.stubEnv('FLEET_USAGE_EXPORT_TOKEN', undefined);
    expect((await call()).status).toBe(401);
    expect(read).not.toHaveBeenCalled();
    expect(await CounterLog.countDocuments({ 'metadata.outcome': 'deny' })).toBe(9);
  });

  it('refuses caller-selected scope, invalid ranges, and non-GET methods before reading usage', async () => {
    const read = vi.spyOn(UsageEvent, 'find');
    for (const query of [
      { from: '2026-01-01', to: '2026-02-01' },
      { from: '2026-01-01', to: '2026-01-01', userId: outsider },
      { from: '2026-01-01', to: '2026-01-01', ownerId: 'other' },
    ]) {
      expect((await call({ query })).status).toBe(422);
    }
    const result = await call({ method: 'POST' });
    expect(result.status).toBe(405);
    expect(result.res.getHeader('Allow')).toBe('GET');
    expect(read).not.toHaveBeenCalled();
  });

  it('never releases invalid accounting or data whose audit write failed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await UsageEvent.collection.insertOne(event({ costUsd: -1 }));
    expect((await call()).status).toBe(500);
    await UsageEvent.deleteMany({});
    await UsageEvent.collection.insertOne(event());
    vi.spyOn(CounterLog, 'create').mockRejectedValueOnce(new Error('audit unavailable'));
    const response = await call();
    expect(response.status).toBe(500);
    expect(response.body.days).toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
});
