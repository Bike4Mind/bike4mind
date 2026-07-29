import { describe, it, expect, beforeEach } from 'vitest';
import { KnowledgeType } from '@bike4mind/common';
import { FabFile, fabFileRepository } from '../models/content/FabFileModel';
import { setupMongoTest } from '../__test__/utils';

setupMongoTest();

const SESSION = 'sess-meta-1';

/**
 * A file carrying every field a metadata read must NOT return: the extracted
 * body, and the two URL fields that would hand out a download.
 */
const heavyFile = {
  userId: 'owner-9',
  fileName: 'scan.pdf',
  type: KnowledgeType.FILE,
  mimeType: 'application/pdf',
  fileSize: 12345,
  content: 'THE ENTIRE DOCUMENT TEXT',
  presignedUrl: 'https://signed.example.com/scan.pdf?sig=abc',
  fileUrl: 'https://cdn.example.com/scan.pdf',
};

beforeEach(async () => {
  await FabFile.deleteMany({});
});

describe('fabFileRepository metadata reads', () => {
  it('projects out the body and both URL fields', async () => {
    const doc = await FabFile.create({ ...heavyFile, sessionId: SESSION });

    for (const file of [
      (await fabFileRepository.findMetadataByIds([doc.id]))[0],
      (await fabFileRepository.findMetadataBySessionId(SESSION)).data[0],
    ]) {
      expect(file.fileName).toBe('scan.pdf');
      expect(file.fileSize).toBe(12345);
      expect(file.content).toBeUndefined();
      expect(file.presignedUrl).toBeUndefined();
      expect(file.fileUrl).toBeUndefined();
    }
  });

  it('drops ids that are not ObjectIds instead of throwing', async () => {
    const doc = await FabFile.create(heavyFile);
    const found = await fabFileRepository.findMetadataByIds(['not-an-id', doc.id]);
    expect(found.map(f => f.id)).toEqual([doc.id]);
    await expect(fabFileRepository.findMetadataByIds([])).resolves.toEqual([]);
  });

  it('keeps a soft-deleted file visible by id, but out of the session listing', async () => {
    // A knowledgeId can outlive the file. Looked up by id, support must see "this
    // attachment was deleted at T" rather than an empty result indistinguishable
    // from the file never existing; the session listing reports what it still holds.
    const doc = await FabFile.create({ ...heavyFile, sessionId: SESSION });
    const deletedAt = new Date();
    await FabFile.updateOne({ _id: doc.id }, { $set: { deletedAt } });

    const byId = await fabFileRepository.findMetadataByIds([doc.id]);
    expect(byId.map(f => f.id)).toEqual([doc.id]);
    expect(byId[0].deletedAt).toEqual(deletedAt);
    expect((await fabFileRepository.findMetadataBySessionId(SESSION)).data).toEqual([]);
  });

  it('caps the session listing and reports the truncation', async () => {
    for (const n of [0, 1, 2]) {
      await FabFile.create({ ...heavyFile, fileName: `f${n}.pdf`, sessionId: SESSION });
    }

    const capped = await fabFileRepository.findMetadataBySessionId(SESSION, 2);
    expect(capped.data).toHaveLength(2);
    expect(capped.hasMore).toBe(true);

    const whole = await fabFileRepository.findMetadataBySessionId(SESSION, 10);
    expect(whole.data).toHaveLength(3);
    expect(whole.hasMore).toBe(false);
  });
});
