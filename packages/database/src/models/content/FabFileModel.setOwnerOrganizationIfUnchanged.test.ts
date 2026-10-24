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

const makeFile = (fields: Record<string, unknown> = {}) =>
  FabFile.create({
    userId: 'u-owner',
    fileName: 'a.txt',
    mimeType: 'text/plain',
    type: KnowledgeType.FILE,
    filePath: 'files/a.txt',
    fileSize: 100,
    storageChargedAt: new Date('2026-01-01T00:00:00Z'),
    ...fields,
  });

describe('FabFileRepository.setOwnerOrganizationIfUnchanged', () => {
  it('restamps a row that stores no status', async () => {
    const file = await makeFile();
    await FabFile.collection.updateOne({ _id: new mongoose.Types.ObjectId(file.id) }, { $unset: { status: '' } });
    // The hydrated read fills in the schema default, so the snapshot says 'pending' for a row that
    // stores nothing. The CAS has to treat both as the same charge state or the row never restamps.
    const read = await fabFileRepository.findById(file.id);

    expect(await fabFileRepository.setOwnerOrganizationIfUnchanged(file.id, read!, 'org-1')).toBe(true);
    expect((await FabFile.findById(file.id).lean())?.organizationId).toBe('org-1');
  });

  it('refuses a row whose charged bytes moved since it was read', async () => {
    const file = await makeFile();
    const read = await fabFileRepository.findById(file.id);
    await FabFile.collection.updateOne({ _id: new mongoose.Types.ObjectId(file.id) }, { $set: { fileSize: 200 } });

    expect(await fabFileRepository.setOwnerOrganizationIfUnchanged(file.id, read!, 'org-1')).toBe(false);
    expect((await FabFile.findById(file.id).lean())?.organizationId).toBeUndefined();
  });

  it('refuses to unstamp a file a concurrent join put into another lake', async () => {
    // Request 1 removes the file from its only lake and reads no lakes, so it resolves to personal.
    // Request 2 then adds it to another lake of the same org: the stamp is already right, so its
    // reassign writes nothing. Request 1's CAS must lose, or the lake member ends up billed to its
    // uploader for good.
    const file = await makeFile({ organizationId: 'org-1', tags: [] });
    const removalRead = await fabFileRepository.findById(file.id);
    await fabFileRepository.pushTagsByFabFileId(file.id, ['datalake:b']);

    expect(await fabFileRepository.setOwnerOrganizationIfUnchanged(file.id, removalRead!, undefined)).toBe(false);
    expect((await FabFile.findById(file.id).lean())?.organizationId).toBe('org-1');
  });

  it('refuses a row that lost a tag since it was read', async () => {
    const file = await makeFile({ tags: [{ name: 'datalake:a', strength: 0 }] });
    const read = await fabFileRepository.findById(file.id);
    await fabFileRepository.pullTagsByFabFileId(file.id, ['datalake:a']);

    expect(await fabFileRepository.setOwnerOrganizationIfUnchanged(file.id, read!, 'org-1')).toBe(false);
  });

  it('restamps a row whose tag set is unchanged, regardless of order', async () => {
    const file = await makeFile({
      tags: [
        { name: 'datalake:a', strength: 0 },
        { name: 'notes', strength: 1 },
      ],
    });
    const read = await fabFileRepository.findById(file.id);
    read!.tags = [...read!.tags].reverse();

    expect(await fabFileRepository.setOwnerOrganizationIfUnchanged(file.id, read!, 'org-1')).toBe(true);
  });

  it('unstamps a row when the next owner is personal', async () => {
    const file = await makeFile({ organizationId: 'org-1' });
    const read = await fabFileRepository.findById(file.id);

    expect(await fabFileRepository.setOwnerOrganizationIfUnchanged(file.id, read!, undefined)).toBe(true);
    expect((await FabFile.findById(file.id).lean())?.organizationId).toBeUndefined();
  });
});
