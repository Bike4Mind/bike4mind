import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { FabFileSourceType, KnowledgeType, buildStorageBreakdownBuckets } from '@bike4mind/common';
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

const userId = 'u-breakdown';

const makeFile = (fileName: string, fileSize: number, fields: Record<string, unknown> = {}) =>
  FabFile.create({
    userId,
    fileName,
    mimeType: 'text/plain',
    type: KnowledgeType.FILE,
    filePath: fileName,
    status: 'complete',
    storageChargedAt: new Date(),
    fileSize,
    ...fields,
  });

describe('FabFileRepository.summarizeChargedStorageByUserId', () => {
  it('leaves out org-stamped rows, which the org is billed for', async () => {
    await makeFile('personal.pdf', 110);
    await makeFile('org.pdf', 40, { organizationId: 'o1' });

    const groups = await fabFileRepository.summarizeChargedStorageByUserId(userId);
    expect(groups.reduce((sum, g) => sum + g.bytes, 0)).toBe(110);
    expect(groups.reduce((sum, g) => sum + g.fileCount, 0)).toBe(1);
  });

  it('groups by source, lake and generated mime type, and sums to sumFileSizeByUserId', async () => {
    await makeFile('upload.pdf', 110);
    await makeFile('legacy.txt', 5); // no sourceType
    await makeFile('drive-a.doc', 400, { sourceType: FabFileSourceType.GOOGLE_DRIVE, sourceLakeId: 'lake-a' });
    await makeFile('drive-a2.doc', 200, { sourceType: FabFileSourceType.GOOGLE_DRIVE, sourceLakeId: 'lake-a' });
    await makeFile('repo.ts', 30, { sourceType: FabFileSourceType.GITHUB, sourceLakeId: 'lake-b' });
    await makeFile('song.mp3', 150, { sourceType: FabFileSourceType.TOOL_GENERATED, mimeType: 'audio/mpeg' });
    await makeFile('voice.wav', 100, { sourceType: FabFileSourceType.TOOL_GENERATED, mimeType: 'audio/wav' });
    await makeFile('pic.png', 20, { sourceType: FabFileSourceType.TOOL_GENERATED, mimeType: 'image/png' });
    await makeFile('slack.txt', 7, { sourceType: FabFileSourceType.SLACK, sourceLakeId: 'ignored' });

    const groups = await fabFileRepository.summarizeChargedStorageByUserId(userId, { maxTimeMS: 5000 });
    const total = await fabFileRepository.sumFileSizeByUserId(userId);
    expect(groups.reduce((sum, g) => sum + g.bytes, 0)).toBe(total);

    const buckets = buildStorageBreakdownBuckets(groups);
    expect(buckets.map(b => [b.key, b.bytes, b.fileCount])).toEqual([
      ['google_drive:lake-a', 600, 2],
      ['tool_generated:audio', 250, 2],
      ['manual_upload', 115, 2],
      ['github:lake-b', 30, 1],
      ['tool_generated:image', 20, 1],
      ['slack', 7, 1],
    ]);
  });

  it('counts archived rows and flags them, and skips deleted, uncharged and foreign rows', async () => {
    await makeFile('live.txt', 10);
    await makeFile('archived.txt', 20, { archivedAt: new Date() });
    await makeFile('deleted.txt', 40, { deletedAt: new Date() });
    await makeFile('pending.txt', 80, { status: 'pending', storageChargedAt: null });
    await FabFile.create({
      userId: 'someone-else',
      fileName: 'theirs.txt',
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      filePath: 'theirs.txt',
      status: 'complete',
      storageChargedAt: new Date(),
      fileSize: 160,
    });

    const groups = await fabFileRepository.summarizeChargedStorageByUserId(userId);
    expect(groups.reduce((sum, g) => sum + g.bytes, 0)).toBe(await fabFileRepository.sumFileSizeByUserId(userId));
    const [bucket] = buildStorageBreakdownBuckets(groups);
    expect(bucket).toMatchObject({
      key: 'manual_upload',
      bytes: 30,
      fileCount: 2,
      archivedBytes: 20,
      archivedFileCount: 1,
    });
  });

  it('returns no groups for a user with no files', async () => {
    expect(await fabFileRepository.summarizeChargedStorageByUserId('nobody')).toEqual([]);
  });
});
