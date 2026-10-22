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

// Re-sync (#1591) diffs the fresh folder walk against every file a connection has in the lake, so
// it needs the FULL connection set - not a lookup by known ids - to detect deletes (a stored file
// absent from the walk).
describe('findByDriveConnectionIdInDataLake', () => {
  const datalakeTag = 'datalake:test-lake';
  const connId = 'conn-resync';

  const makeFile = (over: Record<string, unknown>) => ({
    userId: 'u-sync',
    fileName: 'f.txt',
    mimeType: 'text/plain',
    type: KnowledgeType.FILE,
    filePath: `${Math.random()}.txt`,
    status: 'complete',
    tags: [{ name: datalakeTag, strength: 1.0 }],
    driveConnectionId: connId,
    ...over,
  });

  it('returns every lake file this connection ingested', async () => {
    await FabFile.create(makeFile({ driveFileId: 'd1' }));
    await FabFile.create(makeFile({ driveFileId: 'd2' }));

    const result = await fabFileRepository.findByDriveConnectionIdInDataLake(connId, datalakeTag);
    expect(result.map(f => f.driveFileId).sort()).toEqual(['d1', 'd2']);
  });

  it('excludes files ingested by a different connection', async () => {
    await FabFile.create(makeFile({ driveFileId: 'd-mine' }));
    await FabFile.create(makeFile({ driveFileId: 'd-theirs', driveConnectionId: 'conn-other' }));

    const result = await fabFileRepository.findByDriveConnectionIdInDataLake(connId, datalakeTag);
    expect(result.map(f => f.driveFileId)).toEqual(['d-mine']);
  });

  it('excludes pending, deleted, archived, and other-lake rows', async () => {
    await FabFile.create(makeFile({ driveFileId: 'd-pending', status: 'pending' }));
    await FabFile.create(makeFile({ driveFileId: 'd-del', deletedAt: new Date() }));
    await FabFile.create(makeFile({ driveFileId: 'd-arch', archivedAt: new Date() }));
    await FabFile.create(makeFile({ driveFileId: 'd-other', tags: [{ name: 'datalake:other', strength: 1.0 }] }));

    const result = await fabFileRepository.findByDriveConnectionIdInDataLake(connId, datalakeTag);
    expect(result).toHaveLength(0);
  });

  it('includeDeleted reaches deleted and archived rows, still excluding pending and other-lake ones', async () => {
    // Own connection id: beforeEach's deleteMany is a soft delete, so earlier tests' rows linger.
    const purgeConnId = 'conn-purge';
    const purgeFile = (over: Record<string, unknown>) => makeFile({ driveConnectionId: purgeConnId, ...over });
    await FabFile.create(purgeFile({ driveFileId: 'd-live' }));
    await FabFile.create(purgeFile({ driveFileId: 'd-del', deletedAt: new Date() }));
    await FabFile.create(purgeFile({ driveFileId: 'd-arch', archivedAt: new Date() }));
    await FabFile.create(purgeFile({ driveFileId: 'd-pending', status: 'pending' }));
    await FabFile.create(purgeFile({ driveFileId: 'd-other', tags: [{ name: 'datalake:other', strength: 1.0 }] }));

    const result = await fabFileRepository.findByDriveConnectionIdInDataLake(purgeConnId, datalakeTag, {
      includeDeleted: true,
    });
    expect(result.map(f => f.driveFileId).sort()).toEqual(['d-arch', 'd-del', 'd-live']);
    expect(await fabFileRepository.countByDriveConnectionIdInDataLake(purgeConnId, datalakeTag)).toBe(3);
  });

  it('limit caps the includeDeleted set to one bounded slice', async () => {
    const sliceConnId = 'conn-slice';
    for (const driveFileId of ['s-1', 's-2', 's-3']) {
      await FabFile.create(makeFile({ driveConnectionId: sliceConnId, driveFileId }));
    }
    const slice = await fabFileRepository.findByDriveConnectionIdInDataLake(sliceConnId, datalakeTag, {
      includeDeleted: true,
      limit: 2,
    });
    expect(slice).toHaveLength(2);
  });
});

// The disconnect backstop's finder: a file the connector UNPICKED lost the lake meta-tag but kept
// its driveConnectionId, so the meta-tag-scoped purge finders cannot reach it. This must return
// exactly those live orphans - and nothing else the connection owns.
describe('findLiveNonMembersByDriveConnectionId', () => {
  const datalakeTag = 'datalake:orphan-lake';
  const connId = 'conn-orphans';

  const makeFile = (over: Record<string, unknown>) => ({
    userId: 'u-orphan',
    fileName: 'f.txt',
    mimeType: 'text/plain',
    type: KnowledgeType.FILE,
    filePath: `${Math.random()}.txt`,
    status: 'complete',
    driveConnectionId: connId,
    ...over,
  });

  it('returns only the live, non-member orphan this connection owns', async () => {
    // Member: still carries the lake tag -> the member purge's business, not this finder's.
    await FabFile.create(makeFile({ driveFileId: 'member', tags: [{ name: datalakeTag, strength: 1 }] }));
    const orphan = await FabFile.create(makeFile({ driveFileId: 'orphan', tags: [] }));
    // Soft-deleted orphan: already reaped by deleteFabFile -> the plugin's default filter drops it.
    await FabFile.create(makeFile({ driveFileId: 'deleted', tags: [], deletedAt: new Date() }));
    // Archive stamps members only, so this is defensive: an archived non-member is still not live.
    await FabFile.create(makeFile({ driveFileId: 'archived', tags: [], archivedAt: new Date() }));
    // Never-durable in-flight upload.
    await FabFile.create(makeFile({ driveFileId: 'pending', tags: [], status: 'pending' }));
    // A different connection's row must not leak in. (A same-connection row tagged into ANOTHER lake
    // is still a non-member of THIS lake, so the finder does return it - the gate, not this finder,
    // is what keeps it alive. See connectorCopyGate.test.ts.)
    await FabFile.create(makeFile({ driveFileId: 'other-conn', tags: [], driveConnectionId: 'conn-other' }));

    const result = await fabFileRepository.findLiveNonMembersByDriveConnectionId(connId, datalakeTag);
    expect(result.map(f => f.id)).toEqual([orphan.id]);
  });

  it('excludes a member even when its tag array also holds unrelated tags', async () => {
    await FabFile.create(
      makeFile({
        driveFileId: 'member-mixed',
        tags: [
          { name: 'q3', strength: 1 },
          { name: datalakeTag, strength: 1 },
        ],
      })
    );
    const result = await fabFileRepository.findLiveNonMembersByDriveConnectionId(connId, datalakeTag);
    expect(result).toHaveLength(0);
  });
});

// The resume key for a Drive ingest that spans several runs. It excludes `pending` - unlike every
// other accessor above, not because pending rows are throwaway, but because 'pending' is exactly
// what a row minted by createFabFile and never confirmed by storage.upload looks like, and that row
// must NOT be mistaken for "already ingested" (it would then never be retried, and no bytes would
// ever land for its driveFileId). markUploaded is what flips a genuinely-uploaded row out of
// 'pending' synchronously, ahead of the async S3 objectCreated event.
describe('findDriveFileIdsByBatchId', () => {
  const batchId = 'batch-resume';

  const makeFile = (over: Record<string, unknown>) => ({
    userId: 'u-resume',
    fileName: 'f.txt',
    mimeType: 'text/plain',
    type: KnowledgeType.FILE,
    filePath: 'f.txt',
    status: 'complete',
    batchId,
    sourceType: FabFileSourceType.GOOGLE_DRIVE,
    ...over,
  });

  it('excludes a row still pending (upload never confirmed) and ignores other batches', async () => {
    await FabFile.create(makeFile({ driveFileId: 'd1', status: 'pending' }));
    await FabFile.create(makeFile({ driveFileId: 'd2' }));
    await FabFile.create(makeFile({ driveFileId: 'd-other', batchId: 'batch-elsewhere' }));
    await FabFile.create(makeFile({}));

    const result = await fabFileRepository.findDriveFileIdsByBatchId(batchId);
    expect(result).toEqual(['d2']);
  });

  it('includes a row markUploaded confirmed even though its FabFile.status has not vectorized yet', async () => {
    // A dedicated batch id: deleteMany's soft-delete leaves the previous test's rows queryable (this
    // accessor has no deletedAt filter - see its own doc comment), so reusing `batchId` would leak them in.
    const confirmedBatchId = 'batch-resume-confirmed';
    const created = await FabFile.create(makeFile({ batchId: confirmedBatchId, driveFileId: 'd1', status: 'pending' }));
    await fabFileRepository.markUploaded(created.id);

    const result = await fabFileRepository.findDriveFileIdsByBatchId(confirmedBatchId);
    expect(result).toEqual(['d1']);
  });
});

describe('markUploaded', () => {
  it('flips a pending row to complete, and is a no-op once already complete', async () => {
    const created = await FabFile.create({
      userId: 'u-resume',
      fileName: 'f.txt',
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      filePath: 'f.txt',
      status: 'pending',
      sourceType: FabFileSourceType.GOOGLE_DRIVE,
      driveFileId: 'd1',
    });

    await fabFileRepository.markUploaded(created.id);
    expect((await FabFile.findById(created.id))?.status).toBe('complete');

    // Idempotent - the async S3 objectCreated handler may also try this same transition later.
    await fabFileRepository.markUploaded(created.id);
    expect((await FabFile.findById(created.id))?.status).toBe('complete');
  });
});
