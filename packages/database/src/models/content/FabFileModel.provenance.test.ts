import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { FabFileSourceType, KnowledgeType } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { FabFile } from './FabFileModel';

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

// Regression guard: both fields were absent from the schema, so Mongoose strict mode dropped
// them on every save without erroring. Asserting against the RAW collection document (not the
// hydrated model) is the point - a hydrated doc can echo back a value that never reached Mongo.
describe('FabFile provenance fields persist', () => {
  it('round-trips sourceType and sourceMetadata to the stored document', async () => {
    const created = await FabFile.create({
      userId: 'u-provenance',
      fileName: 'notes.txt',
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      filePath: 'notes.txt',
      sourceType: FabFileSourceType.SLACK,
      sourceMetadata: { channel: 'C0123', messageTs: '1700000000.0001' },
    });

    const stored = await FabFile.collection.findOne({ _id: created._id });

    expect(stored?.sourceType).toBe(FabFileSourceType.SLACK);
    expect(stored?.sourceMetadata).toEqual({ channel: 'C0123', messageTs: '1700000000.0001' });
  });

  it('rejects a sourceType outside the enum', async () => {
    await expect(
      FabFile.create({
        userId: 'u-provenance',
        fileName: 'bad.txt',
        mimeType: 'text/plain',
        type: KnowledgeType.FILE,
        filePath: 'bad.txt',
        sourceType: 'carrier-pigeon',
      } as never)
    ).rejects.toThrow();
  });

  it('leaves both fields unset when the caller supplies neither', async () => {
    const created = await FabFile.create({
      userId: 'u-provenance',
      fileName: 'plain.txt',
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      filePath: 'plain.txt',
    });

    const stored = await FabFile.collection.findOne({ _id: created._id });

    expect(stored).not.toHaveProperty('sourceType');
    expect(stored).not.toHaveProperty('sourceMetadata');
  });
});
