import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../__test__/createMongoServer';
import DlqReplayLogModel, { dlqReplayLogRepository } from './DlqReplayLogModel';

describe('DlqReplayLogRepository.findRecent', () => {
  it('pages beyond 200 records with tied timestamps, filters and literal reason search', async () => {
    const createdAt = new Date();
    await DlqReplayLogModel.create(
      Array.from({ length: 225 }, (_, index) => ({
        queueLabel: 'paged',
        messageId: `entity-${index}`,
        messageBody: 'SECRET',
        sourceQueue: 'Paged',
        status: 'discarded',
        operation: 'discard',
        reason: 'Obsolete [job]',
        replayedBy: 'admin-1',
        createdAt,
      }))
    );
    const ids: string[] = [];
    let before: { createdAt: Date; id: string } | undefined;
    for (;;) {
      const rows = await dlqReplayLogRepository.findRecent({
        queueLabel: 'paged',
        status: 'discarded',
        search: '[job]',
        startDate: createdAt,
        endDate: createdAt,
        limit: 50,
        before,
        includeBody: false,
      });
      if (!rows.length) break;
      expect(rows.every(row => row.reason === 'Obsolete [job]' && !('messageBody' in row))).toBe(true);
      ids.push(...rows.map(row => String(row.id)));
      const last = rows.at(-1)!;
      before = { createdAt: last.createdAt, id: String(last.id) };
    }
    expect(ids).toHaveLength(225);
    expect(new Set(ids).size).toBe(225);
    expect(ids).toEqual([...ids].sort().reverse());
    expect(await dlqReplayLogRepository.findRecent({ search: ids[0], includeBody: false })).toHaveLength(1);
    expect(await dlqReplayLogRepository.findRecent({ search: 'entity-224', includeBody: false })).toHaveLength(1);
  });
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

  it('excludes failed discards from the replay budget while preserving legacy replay failures', async () => {
    const base = {
      queueLabel: 'quest',
      messageId: 'budget-message',
      messageBody: 'retained',
      sourceQueue: 'Quest Export',
      replayedBy: 'admin-1',
      status: 'failed',
    };
    await DlqReplayLogModel.create(Array.from({ length: 3 }, () => ({ ...base, operation: 'discard' })));
    expect(await dlqReplayLogRepository.countAttempts(base.messageId)).toBe(0);
    await DlqReplayLogModel.create(Array.from({ length: 3 }, () => base));
    expect(await dlqReplayLogRepository.countAttempts(base.messageId)).toBe(3);
  });

  it.each(['discarded', 'failed'] as const)(
    'finalizes a pending discard as %s without consuming replay attempts',
    async status => {
      const pending = await dlqReplayLogRepository.logReplay({
        queueLabel: 'quest',
        messageId: 'pending-discard',
        messageBody: 'RECOVERY-BODY',
        sourceQueue: 'Quest Export',
        replayedBy: 'admin-1',
        reason: 'Job obsolete',
        operation: 'discard',
        status: 'pending',
      });
      expect(await dlqReplayLogRepository.countAttempts(pending.messageId)).toBe(0);
      const [history] = await dlqReplayLogRepository.findRecent({ status: 'pending', includeBody: false });
      expect(history).toMatchObject({ operation: 'discard', status: 'pending', reason: 'Job obsolete' });
      expect(history).not.toHaveProperty('messageBody');
      await dlqReplayLogRepository.finalizeDiscard(
        pending.id,
        status,
        status === 'failed' ? 'expired receipt' : undefined
      );
      expect(await DlqReplayLogModel.findById(pending.id).lean()).toMatchObject({
        status,
        operation: 'discard',
        messageBody: 'RECOVERY-BODY',
        reason: 'Job obsolete',
      });
      expect(await dlqReplayLogRepository.countAttempts(pending.messageId)).toBe(0);
      await expect(dlqReplayLogRepository.finalizeDiscard(pending.id, 'failed', 'late failure')).rejects.toThrow(
        'pending attempt'
      );
      expect((await DlqReplayLogModel.findById(pending.id))?.status).toBe(status);
    }
  );

  it('refuses to finalize a replay record or a missing discard', async () => {
    const replay = await DlqReplayLogModel.findOne({ status: 'success' });
    expect(replay).not.toBeNull();
    await expect(
      dlqReplayLogRepository.finalizeDiscard(String(replay!._id), 'failed', 'wrong operation')
    ).rejects.toThrow('pending attempt');
    await expect(
      dlqReplayLogRepository.finalizeDiscard(new mongoose.Types.ObjectId().toString(), 'discarded')
    ).rejects.toThrow('pending attempt');
    expect((await DlqReplayLogModel.findById(replay!._id))?.status).toBe('success');
    expect(await dlqReplayLogRepository.countAttempts('msg-beta-2')).toBe(1);
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
      status: 'pending',
      operation: 'discard',
      reason: 'Job obsolete',
      replayedBy: 'admin-1',
    });
    await dlqReplayLogRepository.finalizeDiscard(log.id, 'failed', 'expired receipt');

    const [row] = await dlqReplayLogRepository.findRecent({ search: 'msg-discard-failed' });
    expect(row).toMatchObject({ status: 'failed', errorMessage: 'expired receipt', reason: 'Job obsolete' });
    expect(await dlqReplayLogRepository.countAttempts('msg-discard-failed')).toBe(0);
  });

  it('finalization leaves a row that is not a discard untouched', async () => {
    const [ok] = await dlqReplayLogRepository.findRecent({ search: 'msg-beta-2' });
    await expect(dlqReplayLogRepository.finalizeDiscard(ok.id, 'failed', 'nope')).rejects.toThrow('pending attempt');
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
