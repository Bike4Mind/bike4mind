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

const charged = new Date('2026-01-01T00:00:00Z');
const makeFile = (fields: Record<string, unknown> = {}) =>
  FabFile.create({
    userId: 'u-rewrite',
    fileName: 'a.txt',
    mimeType: 'text/plain',
    type: KnowledgeType.FILE,
    filePath: 'files/a.txt',
    fileSize: 100,
    storageChargedAt: charged,
    ...fields,
  });

// The storage delta in fabFileService/rewriteStorage.ts is computed from what this returns, so a
// post-image here would silently charge nothing.
describe('FabFileRepository.commitContentRewrite', () => {
  it('returns the pre-image and writes the new size with a fresh charge stamp', async () => {
    const file = await makeFile();

    const pre = await fabFileRepository.commitContentRewrite(file.id, { fileSize: 250 });

    expect(pre).toEqual({
      userId: 'u-rewrite',
      fileSize: 100,
      storageChargedAt: charged,
      status: file.status,
      createdAt: file.createdAt,
    });
    const after = await FabFile.findById(file.id).lean();
    expect(after?.fileSize).toBe(250);
    expect(after?.storageChargedAt?.getTime()).toBeGreaterThan(charged.getTime());
  });

  it('returns null and writes nothing when the filter misses', async () => {
    const file = await makeFile();

    expect(await fabFileRepository.commitContentRewrite(file.id, { fileSize: 250 }, { filePath: 'other' })).toBeNull();
    expect((await FabFile.findById(file.id).lean())?.fileSize).toBe(100);
  });

  // The rewrite delta is billed to storageOwnerOf(pre), so dropping the org would bill the uploader.
  it('carries the owning organizationId on the pre-image', async () => {
    const file = await makeFile({ organizationId: 'o1' });

    const pre = await fabFileRepository.commitContentRewrite(file.id, { fileSize: 250 });

    expect(pre?.organizationId).toBe('o1');
  });
});

describe('FabFileRepository.findChargeState', () => {
  it('carries the owning organizationId', async () => {
    const file = await makeFile({ organizationId: 'o1' });

    expect(await fabFileRepository.findChargeState(file.id)).toMatchObject({
      userId: 'u-rewrite',
      organizationId: 'o1',
    });
  });
});
