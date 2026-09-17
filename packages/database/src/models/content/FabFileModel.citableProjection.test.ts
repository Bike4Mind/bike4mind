import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { FabFile, fabFileRepository } from './FabFileModel';

/**
 * The projected readers the lake-memory source-reachability filter runs on, plus the tag-carrying
 * variant the embedding-comparison capture reads. A lake profile cites one source document per belief
 * with no cap, so this filter reads a document per cited source on every profile render - and
 * `findAllByIds` builds a full mongoose document for each of them to answer a question about
 * existence and eight scalars.
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

/**
 * Every key either projected reader is allowed to return - CITABLE_PROJECTION plus `tags`, with `_id`
 * surfacing as `id`. MUST STAY IN SYNC with CITABLE_PROJECTION in FabFileModel.ts: this list is what
 * turns a widened projection into a failing test rather than a silently fatter hot-path read.
 */
const CITABLE_KEYS = new Set([
  'id',
  'deletedAt',
  'archivedAt',
  'chunkCount',
  'vectorizedChunkCount',
  'embeddingModel',
  'fileName',
  'vectorized',
  'createdAt',
  'tags',
]);

const makeFile = (fileName: string, extra: Record<string, unknown> = {}) =>
  FabFile.create({
    userId: 'u-citable',
    fileName,
    mimeType: 'text/plain',
    type: KnowledgeType.FILE,
    filePath: fileName,
    // The bulk the projection exists to leave behind: unbounded Mixed metadata, a subdocument array
    // and an array of arbitrary tag objects. `notes` is NOT in that class - `isRetrievalExcluded`
    // reads it through `isChunkStalledFile` for the legacy stall rows - it is left out because it is
    // owner-authored free text on a per-cited-source read. See CITABLE_PROJECTION's known-gap note.
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

  it('omits tags, which is why the tag-carrying variant exists', async () => {
    // Pinned as its own case because the capture path's document identity depends on the difference:
    // pointing it at this reader instead would leave every `tags` undefined, and the corpus would
    // join to ground truth by file id rather than help slug - silently scoring zero recall.
    const file = await makeFile('tagged.md', { chunkCount: 1, vectorizedChunkCount: 1 });

    const [row] = await fabFileRepository.findCitableFieldsByIds([String(file._id)]);

    expect(row.id).toBe(String(file._id));
    expect(row).not.toHaveProperty('tags');
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

describe('FabFileRepository.findCitableFieldsWithTagsByIds', () => {
  it('returns the citability fields AND tags, still without the document body', async () => {
    const file = await makeFile('captured.md', {
      chunkCount: 4,
      vectorizedChunkCount: 4,
      embeddingModel: 'text-embedding-3-small',
      vectorized: true,
    });

    const [row] = await fabFileRepository.findCitableFieldsWithTagsByIds([String(file._id)]);

    expect(row.id).toBe(String(file._id));
    expect(row).toMatchObject({ fileName: 'captured.md', chunkCount: 4, vectorizedChunkCount: 4 });
    // The one field this reader exists for: the capture joins its corpus to ground truth by tag.
    expect(row.tags?.map(t => t.name)).toEqual(['datalake:test']);
    // Closed over the WHOLE key set rather than a list of absences: naming fields to exclude only
    // pins the ones someone thought of, so widening the `.select()` would keep a `not.toHaveProperty`
    // suite green. Asserting no key OUTSIDE the projection - rather than an exact list - is what
    // survives an optional field simply being unset on this fixture (`archivedAt` is; `deletedAt`
    // comes back because the soft-delete plugin defaults it). This is what makes the comment above
    // self-enforcing.
    expect(Object.keys(row).filter(key => !CITABLE_KEYS.has(key))).toEqual([]);
  });

  it('applies the same liveness semantics as the tagless reader', async () => {
    // The capture's reachability filter reads `deletedAt`/`archivedAt` off these rows, so the two
    // readers disagreeing about what comes back would move which files enter a scored corpus.
    const deleted = await makeFile('deleted.md', { deletedAt: new Date() });
    const archived = await makeFile('archived.md', { archivedAt: new Date() });
    const ids = [String(deleted._id), String(archived._id)];

    const tagged = await fabFileRepository.findCitableFieldsWithTagsByIds(ids);
    const tagless = await fabFileRepository.findCitableFieldsByIds(ids);

    expect(tagged.map(r => r.id)).toEqual(tagless.map(r => r.id));
    expect(tagged.map(r => r.id)).toEqual([String(archived._id)]);
  });

  it('tolerates an unusable id rather than throwing the capture that asked', async () => {
    const alive = await makeFile('alive.md', { chunkCount: 1, vectorizedChunkCount: 1 });

    expect(
      (await fabFileRepository.findCitableFieldsWithTagsByIds(['not-an-objectid', String(alive._id)])).map(r => r.id)
    ).toEqual([String(alive._id)]);
    expect(await fabFileRepository.findCitableFieldsWithTagsByIds([])).toEqual([]);
  });
});
