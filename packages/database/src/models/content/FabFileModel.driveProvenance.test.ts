import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType, FabFileSourceType } from '@bike4mind/common';
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

// Parity guard for the Drive-ingest provenance fields (#1589). These MUST live in both the Zod
// type (IFabFile) and the Mongoose schema - a field added to only one is silently dropped on
// write (the bug that already hit sourceType/dataLakeMetadata). This reads straight from Mongo
// to prove the fields were actually persisted, not just echoed by the in-memory doc.
describe('FabFile Drive provenance fields persist (schema/type parity)', () => {
  it('round-trips driveFileId, driveModifiedTime, driveMd5Checksum, sourceLakeId, driveConnectionId, sourceType', async () => {
    const modified = new Date('2026-08-01T00:00:00.000Z');
    const created = await FabFile.create({
      userId: 'u-prov',
      fileName: 'spec.txt',
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      filePath: 'spec.txt',
      status: 'complete',
      sourceType: FabFileSourceType.GOOGLE_DRIVE,
      driveFileId: 'drive-abc123',
      driveModifiedTime: modified,
      driveMd5Checksum: 'md5-xyz',
      sourceLakeId: 'lake-1',
      driveConnectionId: 'conn-1',
    });

    const reloaded = await FabFile.findById(created.id);
    expect(reloaded?.sourceType).toBe(FabFileSourceType.GOOGLE_DRIVE);
    expect(reloaded?.driveFileId).toBe('drive-abc123');
    expect(reloaded?.driveModifiedTime?.getTime()).toBe(modified.getTime());
    expect(reloaded?.driveMd5Checksum).toBe('md5-xyz');
    expect(reloaded?.sourceLakeId).toBe('lake-1');
    expect(reloaded?.driveConnectionId).toBe('conn-1');
  });
});

// Drive re-sync dedup key: driveFileId is stable across edits (contentHash is not), so this is
// how the ingest job decides create-vs-skip-vs-update. Mirrors findByContentHashesInDataLake.
describe('findByDriveFileIdsInDataLake', () => {
  const datalakeTag = 'datalake:test-lake';

  const makeFile = (over: Record<string, unknown>) => ({
    userId: 'u-sync',
    fileName: 'f.txt',
    mimeType: 'text/plain',
    type: KnowledgeType.FILE,
    filePath: `${Math.random()}.txt`,
    status: 'complete',
    tags: [{ name: datalakeTag, strength: 1.0 }],
    ...over,
  });

  it('returns files in the lake matching any driveFileId', async () => {
    await FabFile.create(makeFile({ driveFileId: 'd1' }));
    await FabFile.create(makeFile({ driveFileId: 'd2' }));

    const result = await fabFileRepository.findByDriveFileIdsInDataLake(['d1', 'd2', 'missing'], datalakeTag);
    expect(result.map(f => f.driveFileId).sort()).toEqual(['d1', 'd2']);
  });

  it('excludes pending orphans (a failed prior ingest must not block a re-ingest)', async () => {
    await FabFile.create(makeFile({ driveFileId: 'd-orphan', status: 'pending' }));
    const result = await fabFileRepository.findByDriveFileIdsInDataLake(['d-orphan'], datalakeTag);
    expect(result).toHaveLength(0);
  });

  it('excludes deleted, archived, and other-lake matches', async () => {
    await FabFile.create(makeFile({ driveFileId: 'd-del', deletedAt: new Date() }));
    await FabFile.create(makeFile({ driveFileId: 'd-arch', archivedAt: new Date() }));
    await FabFile.create(makeFile({ driveFileId: 'd-other', tags: [{ name: 'datalake:other', strength: 1.0 }] }));

    const result = await fabFileRepository.findByDriveFileIdsInDataLake(['d-del', 'd-arch', 'd-other'], datalakeTag);
    expect(result).toHaveLength(0);
  });

  it('matches a file owned by a different user in the same lake (shared-lake dedup)', async () => {
    await FabFile.create(makeFile({ userId: 'someone-else', driveFileId: 'd-shared' }));
    const result = await fabFileRepository.findByDriveFileIdsInDataLake(['d-shared'], datalakeTag);
    expect(result.map(f => f.driveFileId)).toContain('d-shared');
  });
});
