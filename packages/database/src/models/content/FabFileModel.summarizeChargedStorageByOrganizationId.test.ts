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

const organizationId = 'o-usage';

const makeFile = (userId: string, fileSize: number, fields: Record<string, unknown> = {}) =>
  FabFile.create({
    userId,
    organizationId,
    fileName: `${userId}-${fileSize}.txt`,
    mimeType: 'text/plain',
    type: KnowledgeType.FILE,
    filePath: `${userId}-${fileSize}.txt`,
    status: 'complete',
    storageChargedAt: new Date(),
    fileSize,
    ...fields,
  });

describe('FabFileRepository.summarizeChargedStorageByOrganizationId', () => {
  it('groups the org rows by uploader, largest first, and sums to sumFileSizeByOrganizationId', async () => {
    await makeFile('alice', 100);
    await makeFile('alice', 50);
    await makeFile('bob', 300);
    await makeFile('carol', 10);

    const groups = await fabFileRepository.summarizeChargedStorageByOrganizationId(organizationId, {
      limit: 10,
      maxTimeMS: 5000,
    });

    expect(groups).toEqual([
      { userId: 'bob', bytes: 300, fileCount: 1 },
      { userId: 'alice', bytes: 150, fileCount: 2 },
      { userId: 'carol', bytes: 10, fileCount: 1 },
    ]);
    expect(groups.reduce((sum, g) => sum + g.bytes, 0)).toBe(
      await fabFileRepository.sumFileSizeByOrganizationId(organizationId)
    );
  });

  it('leaves out personal, other-org, deleted and uncharged rows', async () => {
    await makeFile('alice', 100);
    await makeFile('alice', 7, { organizationId: undefined });
    await makeFile('alice', 8, { organizationId: 'o-other' });
    await makeFile('alice', 9, { deletedAt: new Date() });
    await makeFile('alice', 11, { storageChargedAt: undefined });

    const groups = await fabFileRepository.summarizeChargedStorageByOrganizationId(organizationId, { limit: 10 });
    expect(groups).toEqual([{ userId: 'alice', bytes: 100, fileCount: 1 }]);
  });

  it('caps the groups at limit', async () => {
    await makeFile('alice', 100);
    await makeFile('bob', 300);
    await makeFile('carol', 10);

    const groups = await fabFileRepository.summarizeChargedStorageByOrganizationId(organizationId, { limit: 2 });
    expect(groups.map(g => g.userId)).toEqual(['bob', 'alice']);
  });
});
