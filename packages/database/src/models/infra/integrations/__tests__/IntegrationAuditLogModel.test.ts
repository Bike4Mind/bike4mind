import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../../__test__/createMongoServer';
import {
  IntegrationAuditLogModel,
  integrationAuditLogRepository,
  INTEGRATION_AUDIT_INTEGRATION_NAMES,
  type CreateIntegrationAuditLogInput,
} from '../IntegrationAuditLogModel';

const baseLog = (overrides: Partial<CreateIntegrationAuditLogInput> = {}): CreateIntegrationAuditLogInput => ({
  entityType: 'webhook',
  integrationName: 'optihashi',
  action: 'webhook_run.completed',
  requestId: 'req-1',
  sourceIp: '127.0.0.1',
  userAgent: 'test',
  outcome: 'success',
  durationMs: 0,
  ...overrides,
});

describe('IntegrationAuditLogModel', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  afterEach(async () => {
    await IntegrationAuditLogModel.deleteMany({});
  });

  // Regression: the schema enum previously omitted 'optihashi' while the TS type
  // included it, so every OptiHashi webhook's audit write failed enum validation.
  it("accepts 'optihashi' as a valid integrationName", async () => {
    const log = await integrationAuditLogRepository.createLog(baseLog({ integrationName: 'optihashi' }));
    expect(log.integrationName).toBe('optihashi');
  });

  it('accepts every name in the shared const (schema enum stays in sync with the type)', async () => {
    for (const name of INTEGRATION_AUDIT_INTEGRATION_NAMES) {
      const log = await integrationAuditLogRepository.createLog(baseLog({ integrationName: name }));
      expect(log.integrationName).toBe(name);
    }
  });

  it('still rejects an unknown integrationName (enum enforcement intact)', async () => {
    await expect(
      // @ts-expect-error - deliberately invalid value to prove enum still enforces
      integrationAuditLogRepository.createLog(baseLog({ integrationName: 'bogus' }))
    ).rejects.toThrow(/enum|validation/i);
  });
});
