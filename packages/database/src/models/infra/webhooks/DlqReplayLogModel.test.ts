import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../__test__/createMongoServer';
import DlqReplayLogModel, { dlqReplayLogRepository } from './DlqReplayLogModel';

describe('DlqReplayLogRepository.findRecent', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
  }, MONGO_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  }, MONGO_TEST_TIMEOUT_MS);

  beforeEach(async () => {
    await DlqReplayLogModel.deleteMany({});
    await DlqReplayLogModel.create([
      {
        queueLabel: 'quest',
        messageId: 'msg-alpha-1',
        messageBody: 'SECRET-BODY-ONE',
        sourceQueue: 'Quest Export',
        status: 'failed',
        errorMessage: 'Connection Timeout',
        replayedBy: 'admin-1',
      },
      {
        queueLabel: 'quest',
        messageId: 'msg-beta-2',
        messageBody: 'SECRET-BODY-TWO',
        sourceQueue: 'Quest Export',
        status: 'success',
        replayedBy: 'admin-1',
      },
    ]);
  });

  it('keeps messageBody by default and when includeBody is true', async () => {
    const byDefault = await dlqReplayLogRepository.findRecent();
    const explicit = await dlqReplayLogRepository.findRecent({ includeBody: true });

    expect(byDefault.map(r => r.messageBody).sort()).toEqual(['SECRET-BODY-ONE', 'SECRET-BODY-TWO']);
    expect(explicit.every(r => typeof r.messageBody === 'string')).toBe(true);
  });

  it('omits messageBody but keeps the other fields when includeBody is false', async () => {
    const rows = await dlqReplayLogRepository.findRecent({ includeBody: false });

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).not.toHaveProperty('messageBody');
      expect(row).toHaveProperty('id');
      expect(row).toHaveProperty('messageId');
      expect(row).toHaveProperty('replayedBy', 'admin-1');
    }
  });

  it('searches messageId and errorMessage case-insensitively', async () => {
    const byId = await dlqReplayLogRepository.findRecent({ search: 'BETA' });
    const byError = await dlqReplayLogRepository.findRecent({ search: 'timeout' });

    expect(byId.map(r => r.messageId)).toEqual(['msg-beta-2']);
    expect(byError.map(r => r.messageId)).toEqual(['msg-alpha-1']);
  });

  it('does not match message body text', async () => {
    expect(await dlqReplayLogRepository.findRecent({ search: 'SECRET-BODY' })).toEqual([]);
  });

  it('escapes regex metacharacters in the search term', async () => {
    expect(await dlqReplayLogRepository.findRecent({ search: '.*' })).toEqual([]);
    expect(await dlqReplayLogRepository.findRecent({ search: 'msg-(' })).toEqual([]);
  });
});
