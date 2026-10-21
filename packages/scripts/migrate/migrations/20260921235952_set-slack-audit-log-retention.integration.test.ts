import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { SLACK_AUDIT_LOG_RETENTION_SECONDS, SlackAuditLogModel } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921235952_set-slack-audit-log-retention';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const NINETY_DAYS_SECONDS = 90 * 24 * 60 * 60;

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // Settle autoIndex before the hooks below drop the collection - see createMongoServer's autoIndex note.
  await SlackAuditLogModel.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await SlackAuditLogModel.collection.drop().catch(() => {});
});

const ttlIndex = async () =>
  (await SlackAuditLogModel.collection.indexes()).find(
    index => JSON.stringify(index.key) === JSON.stringify({ createdAt: 1 })
  );

describe('set-slack-audit-log-retention migration (real DB)', () => {
  it('raises an existing 90-day TTL to 12 months in place', async () => {
    await SlackAuditLogModel.collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: NINETY_DAYS_SECONDS });
    expect((await ttlIndex())?.expireAfterSeconds).toBe(NINETY_DAYS_SECONDS);

    await migration.up();

    expect((await ttlIndex())?.expireAfterSeconds).toBe(SLACK_AUDIT_LOG_RETENTION_SECONDS);
  });

  it('builds the 12-month TTL when the collection does not exist yet', async () => {
    await migration.up();

    expect((await ttlIndex())?.expireAfterSeconds).toBe(SLACK_AUDIT_LOG_RETENTION_SECONDS);
  });

  it('is idempotent', async () => {
    await migration.up();
    await migration.up();

    expect((await ttlIndex())?.expireAfterSeconds).toBe(SLACK_AUDIT_LOG_RETENTION_SECONDS);
  });
});
