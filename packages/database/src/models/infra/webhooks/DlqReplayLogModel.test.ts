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

  it('stores discarded bodies and reasons but excludes bodies from discard history', async () => {
    await dlqReplayLogRepository.logReplay({
      queueLabel: 'quest',
      messageId: 'msg-discarded',
      messageBody: 'RECOVERABLE-BODY',
      sourceQueue: 'Quest Export',
      status: 'discarded',
      reason: 'Job obsolete',
      replayedBy: 'admin-1',
    });

    const [stored] = await dlqReplayLogRepository.findRecent({ status: 'discarded' });
    const [history] = await dlqReplayLogRepository.findRecent({ status: 'discarded', includeBody: false });
    expect(stored).toMatchObject({ messageBody: 'RECOVERABLE-BODY', reason: 'Job obsolete' });
    expect(history).toMatchObject({ status: 'discarded', reason: 'Job obsolete' });
    expect(history).not.toHaveProperty('messageBody');
    expect(await dlqReplayLogRepository.countAttempts('msg-discarded')).toBe(0);
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

  it('keeps a failed discard out of the replay attempt count', async () => {
    const log = await dlqReplayLogRepository.logReplay({
      queueLabel: 'quest',
      messageId: 'msg-discard-failed',
      messageBody: 'BODY',
      sourceQueue: 'Quest Export',
      status: 'discarded',
      reason: 'Job obsolete',
      replayedBy: 'admin-1',
    });
    await dlqReplayLogRepository.markDiscardFailed(log.id, 'expired receipt');

    const [row] = await dlqReplayLogRepository.findRecent({ search: 'msg-discard-failed' });
    expect(row).toMatchObject({ status: 'failed', errorMessage: 'expired receipt', reason: 'Job obsolete' });
    expect(await dlqReplayLogRepository.countAttempts('msg-discard-failed')).toBe(0);
  });

  it('markDiscardFailed leaves a row that is not a discard untouched', async () => {
    const [ok] = await dlqReplayLogRepository.findRecent({ search: 'msg-beta-2' });
    await dlqReplayLogRepository.markDiscardFailed(ok.id, 'nope');
    const [after] = await dlqReplayLogRepository.findRecent({ search: 'msg-beta-2' });
    expect(after.status).toBe('success');
  });

  it('searches the discard reason', async () => {
    await dlqReplayLogRepository.logReplay({
      queueLabel: 'quest',
      messageId: 'msg-reasoned',
      messageBody: 'BODY',
      sourceQueue: 'Quest Export',
      status: 'discarded',
      reason: 'Obsolete Job',
      replayedBy: 'admin-1',
    });
    const found = await dlqReplayLogRepository.findRecent({ search: 'obsolete' });
    expect(found.map(r => r.messageId)).toEqual(['msg-reasoned']);
  });
});
