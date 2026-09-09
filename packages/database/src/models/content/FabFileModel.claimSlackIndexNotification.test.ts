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

// The redelivery-safety primitive for the "finished indexing" Slack reply (#2027) - see
// notifySlackIndexingComplete.ts. Mirrors dataLakeBatchRepository.claimFileStatus's shape.
describe('FabFileRepository.claimSlackIndexNotification', () => {
  const create = () =>
    FabFile.create({
      userId: 'u-slack-notify',
      fileName: 'a.txt',
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      filePath: 'a.txt',
    });

  it('claims (returns true and stamps the field) the first time', async () => {
    const fabFile = await create();

    const claimed = await fabFileRepository.claimSlackIndexNotification(fabFile.id);

    expect(claimed).toBe(true);
    const stored = await FabFile.findById(fabFile.id);
    expect(stored?.slackIndexNotifiedAt).toBeInstanceOf(Date);
  });

  it('refuses a second claim on the same file - the redelivery/concurrency guard', async () => {
    const fabFile = await create();

    const first = await fabFileRepository.claimSlackIndexNotification(fabFile.id);
    const second = await fabFileRepository.claimSlackIndexNotification(fabFile.id);

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('returns false for a nonexistent fabFileId rather than throwing', async () => {
    await expect(fabFileRepository.claimSlackIndexNotification('000000000000000000000000')).resolves.toBe(false);
  });
});
