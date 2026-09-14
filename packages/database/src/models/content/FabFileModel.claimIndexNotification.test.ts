import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { FabFile, fabFileRepository } from './FabFileModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await FabFile.deleteMany({});
});

// The redelivery-safety primitive for a completion notification (#2027 introduced it for
// 'slack') - see notifySlackIndexingComplete.ts. Mirrors dataLakeBatchRepository.claimFileStatus's
// shape. Generalized to (fabFileId, channel) rather than a single `slackIndexNotifiedAt: Date`
// field, so a future notification channel (Teams, email, webhook) reuses this instead of
// accreting its own per-channel timestamp field on FabFile.
describe('FabFileRepository.claimIndexNotification', () => {
  const create = () =>
    FabFile.create({
      userId: 'u-slack-notify',
      fileName: 'a.txt',
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      filePath: 'a.txt',
    });

  it('claims (returns true and appends an entry) the first time', async () => {
    const fabFile = await create();

    const claimed = await fabFileRepository.claimIndexNotification(fabFile.id, 'slack');

    expect(claimed).toBe(true);
    // .lean() so the subdocument array comes back as plain objects, not Mongoose EmbeddedDocuments
    // (which carry a circular $__parent reference that trips up a plain toEqual).
    const stored = await FabFile.findById(fabFile.id).lean();
    expect(stored?.dispatchedNotifications).toEqual([{ channel: 'slack', at: expect.any(Date) }]);
  });

  it('refuses a second claim for the same (fabFileId, channel) pair - the redelivery/concurrency guard', async () => {
    const fabFile = await create();

    const first = await fabFileRepository.claimIndexNotification(fabFile.id, 'slack');
    const second = await fabFileRepository.claimIndexNotification(fabFile.id, 'slack');

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('claiming one channel does not block or get blocked by claiming a different channel on the same file', async () => {
    const fabFile = await create();

    const slackClaim = await fabFileRepository.claimIndexNotification(fabFile.id, 'slack');
    const emailClaim = await fabFileRepository.claimIndexNotification(fabFile.id, 'email');
    const slackReclaim = await fabFileRepository.claimIndexNotification(fabFile.id, 'slack');

    expect(slackClaim).toBe(true);
    expect(emailClaim).toBe(true);
    expect(slackReclaim).toBe(false);
    const stored = await FabFile.findById(fabFile.id).lean();
    expect(stored?.dispatchedNotifications).toHaveLength(2);
    expect(stored?.dispatchedNotifications?.map(n => n.channel).sort()).toEqual(['email', 'slack']);
  });

  it('returns false for a nonexistent fabFileId rather than throwing', async () => {
    await expect(fabFileRepository.claimIndexNotification('000000000000000000000000', 'slack')).resolves.toBe(false);
  });
});
