import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { FabFile, fabFileRepository } from './FabFileModel';

/**
 * The two projected readers the lake-memory source-reachability filter runs on. A lake profile cites
 * one source document per belief with no cap, so this filter reads a document per cited source on
 * every profile render - and `findAllByIds` builds a full mongoose document for each of them to
 * answer a question about existence and eight scalars.
 *
 * These have to be exercised against a real Mongo: the resolvers' own unit tests mock the repository,
 * so they can pin WHICH method is called and nothing about what it projects.
 */
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

const makeFile = (fileName: string, extra: Record<string, unknown> = {}) =>
  FabFile.create({
    userId: 'u-citable',
    fileName,
    mimeType: 'text/plain',
    type: KnowledgeType.FILE,
    filePath: fileName,
    // The bulk the projection exists to leave behind: unbounded Mixed metadata, a subdocument array
    // and an array of arbitrary tag objects, none of which a reachability check reads.
    notes: 'operator notes nobody asking about reachability needs',
    presignedUrl: 'https://example.invalid/signed',
    sourceMetadata: { arbitrary: 'payload', of: ['no', 'fixed', 'size'] },
    tags: [{ name: 'datalake:test' }],
    ...extra,
  });

describe('FabFileRepository.findExistingIdsByIds', () => {
  it('returns the ids that still exist, as strings, and omits the rest', async () => {
    const alive = await makeFile('alive.txt');
    const gone = new mongoose.Types.ObjectId();

    const surviving = await fabFileRepository.findExistingIdsByIds([String(alive._id), String(gone)]);

    expect(surviving).toEqual([String(alive._id)]);
  });

  it('tolerates an unusable id rather than throwing the render that asked', async () => {
    // Source ids come out of ledger events written by earlier runs, so a malformed one is a data
    // question, not a programming error - and it must not take down a profile read.
    const alive = await makeFile('alive.txt');

    expect(await fabFileRepository.findExistingIdsByIds(['not-an-objectid', String(alive._id)])).toEqual([
      String(alive._id),
    ]);
    expect(await fabFileRepository.findExistingIdsByIds([])).toEqual([]);
  });
});

describe('FabFileRepository.findCitableFieldsByIds', () => {
  it('projects exactly the citability fields, with `id` populated and no document body', async () => {
    const file = await makeFile('cited.md', {
      chunkCount: 4,
      vectorizedChunkCount: 4,
      embeddingModel: 'text-embedding-3-small',
      vectorized: true,
    });

    const [row] = await fabFileRepository.findCitableFieldsByIds([String(file._id)]);

    // `.lean()` skips the `id` virtual, so this is mapped explicitly - leaning on toJSON instead would
    // hydrate the document and defeat the projection outright.
    expect(row.id).toBe(String(file._id));
    expect(row).toMatchObject({
      fileName: 'cited.md',
      chunkCount: 4,
      vectorizedChunkCount: 4,
      embeddingModel: 'text-embedding-3-small',
      vectorized: true,
    });
    // The whole reason this reader exists: everything outside the projection must stay behind.
    expect(row).not.toHaveProperty('notes');
    expect(row).not.toHaveProperty('presignedUrl');
    expect(row).not.toHaveProperty('sourceMetadata');
    expect(row).not.toHaveProperty('tags');
    expect(row).not.toHaveProperty('_id');
  });

  it('treats a soft-deleted file as gone, and returns an archived one with its stamp', async () => {
    const deleted = await makeFile('deleted.md', { deletedAt: new Date() });
    const archived = await makeFile('archived.md', { archivedAt: new Date() });
    const gone = new mongoose.Types.ObjectId();

    const rows = await fabFileRepository.findCitableFieldsByIds([
      String(deleted._id),
      String(archived._id),
      String(gone),
    ]);

    // The soft-delete plugin's query middleware scopes every `find`, so a soft-deleted source is
    // indistinguishable from a hard-deleted one here - which is exactly the semantics the
    // reachability filter wants, and the same behaviour the unprojected reader had. `deletedAt` stays
    // in the projection so the caller's predicate does not silently depend on that plugin staying
    // mounted.
    expect(rows.map(r => r.id)).toEqual([String(archived._id)]);
    expect(rows[0].archivedAt).toBeInstanceOf(Date);
  });

  it('is consistent with findExistingIdsByIds about what still exists', async () => {
    // The two readers answer for two different arms of the same filter (surviving vs citable), so a
    // divergence here would show up as a belief that is withheld by one arm and cited by the other.
    const alive = await makeFile('alive.md');
    const deleted = await makeFile('deleted.md', { deletedAt: new Date() });
    const ids = [String(alive._id), String(deleted._id)];

    const surviving = await fabFileRepository.findExistingIdsByIds(ids);
    const citable = await fabFileRepository.findCitableFieldsByIds(ids);

    expect(surviving).toEqual([String(alive._id)]);
    expect(citable.map(r => r.id)).toEqual(surviving);
  });
});
