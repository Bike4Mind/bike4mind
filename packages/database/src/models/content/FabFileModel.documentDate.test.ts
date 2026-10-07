import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { DocumentDateSource, KnowledgeType } from '@bike4mind/common';
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

const baseFile = {
  userId: 'u-vintage',
  fileName: 'report.pdf',
  mimeType: 'application/pdf',
  type: KnowledgeType.FILE,
  filePath: 'report.pdf',
  status: 'complete',
};

// Parity guard for the document-vintage pair (#3048), the same one the Drive provenance fields
// carry: a field present in the Zod type but missing from the Mongoose schema is dropped on write
// with no error. Reads back from Mongo rather than trusting the in-memory document, because an
// unknown key survives in the latter and only vanishes at persist time.
describe('FabFile document vintage persists (schema/type parity)', () => {
  it('round-trips documentDate and documentDateSource', async () => {
    const documentDate = new Date('2019-03-04T09:15:00.000Z');
    const created = await FabFile.create({
      ...baseFile,
      documentDate,
      documentDateSource: DocumentDateSource.PDF_METADATA,
    });

    const reloaded = await FabFile.findById(created.id);
    expect(reloaded?.documentDate?.getTime()).toBe(documentDate.getTime());
    expect(reloaded?.documentDateSource).toBe(DocumentDateSource.PDF_METADATA);
  });

  it('leaves both unset for a file no source offered a vintage for', async () => {
    const created = await FabFile.create(baseFile);

    const reloaded = await FabFile.findById(created.id);
    expect(reloaded?.documentDate).toBeUndefined();
    expect(reloaded?.documentDateSource).toBeUndefined();
  });

  // The stale-vintage guard the chunk commit depends on: it writes the pair on EVERY pass, so an
  // explicit null has to survive as a cleared field rather than being ignored as a no-op.
  it('clears a previously-stamped vintage when written as null', async () => {
    const created = await FabFile.create({
      ...baseFile,
      documentDate: new Date('2019-03-04T09:15:00.000Z'),
      documentDateSource: DocumentDateSource.PDF_METADATA,
    });

    await FabFile.updateOne({ _id: created.id }, { $set: { documentDate: null, documentDateSource: null } });

    // Asserted without a `?? null` coalesce: that would also pass if the fields came back
    // undefined, which is the "the write was dropped entirely" outcome this test exists to catch.
    const reloaded = await FabFile.findById(created.id);
    expect(reloaded?.documentDate).toBeNull();
    expect(reloaded?.documentDateSource).toBeNull();
  });

  it('rejects a source outside the enum rather than storing an unattributable date', async () => {
    await expect(
      FabFile.create({
        ...baseFile,
        documentDate: new Date('2019-03-04T09:15:00.000Z'),
        documentDateSource: 'guessed_from_the_filename',
      })
    ).rejects.toThrow(mongoose.Error.ValidationError);
  });
});
