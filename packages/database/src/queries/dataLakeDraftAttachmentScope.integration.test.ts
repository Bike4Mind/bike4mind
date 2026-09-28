import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType } from '@bike4mind/common';
import { createMongoServer } from '../__test__/createMongoServer';
import { FabFile, fabFileRepository } from '../models/content/FabFileModel';
import { DataLakeModel, dataLakeRepository } from '../models/ai/DataLakeModel';

/**
 * Pins the DRAFT-lake split between the two scopes that resolve a lake file's arms, against the
 * real lake and fabFile repositories.
 *
 * Browse (`listDataLakes`, behind `GET /api/files/byIds`) selects `status: { $in: ['draft',
 * 'active'] }`, and a new lake defaults to `draft`. Retrieval selects `status: 'active'` alone -
 * deliberately, per `resolveRetrievalLakeScope`: an unpublished lake must not become ground truth
 * for a question the user never pointed at it.
 *
 * The ATTACHMENT doors pass `includeDraftLakes` and track browse instead: were they to inherit
 * retrieval's narrowing, a file the workbench admitted and the user explicitly attached would be
 * silently dropped by `findAccessibleInIds` - the image edit mask, the reference anchors, the
 * generation input. This file asserts BOTH halves, because the contract is the split, not the
 * widening: move either door and one of these assertions must change deliberately.
 *
 * Against a real server rather than asserted structurally: the whole claim is about what Mongo
 * returns for a status filter combined with the tag/prefix arms, which a shape assertion cannot show.
 */

const OWNER = 'lake-curator-1';
const READER = 'reader-1';
const READER_TAG = 'QA3190LakeAccess';
const SLUG = 'qa-3190-lake';
const DATALAKE_TAG = `datalake:${SLUG}`;
const FILE_TAG_PREFIX = `${SLUG}:`;

let server: Awaited<ReturnType<typeof createMongoServer>>;
let lakeId: string;
let lakeFileId: string;

/**
 * The arms a door would hand `findAccessibleInIds`, derived the way production derives them: ask
 * the lake repository what this caller reaches, then project the reachable lakes into tag/prefix
 * buckets. A lake the repository withholds contributes no arm - which is the mechanism under test,
 * so it must not be short-circuited by hardcoding the tag.
 *
 * `includeDraftLakes` is the ONLY difference between the two doors, so both call this.
 */
const armsFor = async (userTags: string[], opts?: { includeDraftLakes?: boolean }) => {
  const lakes = await dataLakeRepository.findActiveByUserTagsAndEntitlements(userTags, undefined, [], undefined, opts);
  return {
    dataLakeTags: lakes.map(lake => lake.datalakeTag),
    dataLakeTagPrefixes: lakes.map(lake => lake.fileTagPrefix),
  };
};

const attachmentArmsFor = (userTags: string[]) => armsFor(userTags, { includeDraftLakes: true });
const retrievalArmsFor = (userTags: string[]) => armsFor(userTags);

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());

  // Status omitted on purpose: a lake created through the UI takes the schema default, and that
  // default being 'draft' is half of what this test is about.
  const lake = await DataLakeModel.create({
    name: 'QA 3190 lake',
    slug: SLUG,
    fileTagPrefix: FILE_TAG_PREFIX,
    datalakeTag: DATALAKE_TAG,
    requiredUserTag: READER_TAG,
    createdByUserId: OWNER,
  });
  lakeId = lake.id;

  // Owned by the curator, shared with nobody, not global-read: lake membership is the only route.
  const file = await FabFile.create({
    userId: OWNER,
    fileName: 'lake-mask-yellow.png',
    type: KnowledgeType.FILE,
    mimeType: 'image/png',
    filePath: 'lakes/lake-mask-yellow.png',
    moderationStatus: 'clean',
    tags: [
      { name: DATALAKE_TAG, strength: 1 },
      { name: `${FILE_TAG_PREFIX}uncategorized`, strength: 1 },
    ],
  });
  lakeFileId = file.id;
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

describe('draft lake, attachment scope', () => {
  it('defaults a newly created lake to draft', async () => {
    const lake = await DataLakeModel.findById(lakeId);

    expect(lake?.status).toBe('draft');
  });

  it('still withholds a draft lake from the RETRIEVAL resolver, for a tag-holding reader', async () => {
    // The half that must NOT move: semantic search and chat retrieval stay active-only.
    const lakes = await dataLakeRepository.findActiveByUserTagsAndEntitlements([READER_TAG], undefined, []);

    expect(lakes.map(l => l.slug)).not.toContain(SLUG);
  });

  it('resolves the draft lake for the ATTACHMENT scope, which tracks the door that admitted the file', async () => {
    const lakes = await dataLakeRepository.findActiveByUserTagsAndEntitlements([READER_TAG], undefined, [], undefined, {
      includeDraftLakes: true,
    });

    expect(lakes.map(l => l.slug)).toContain(SLUG);
  });

  it('finds the draft-lake file through findAccessibleInIds on the attachment arms', async () => {
    // The fix in one assertion: the image edit/generation lookup now returns the file the caller
    // attached and can read through byIds.
    const arms = await attachmentArmsFor([READER_TAG]);
    expect(arms.dataLakeTags).toContain(DATALAKE_TAG);

    const found = await fabFileRepository.findAccessibleInIds([lakeFileId], { userId: READER }, arms);

    expect(found.map(f => f.id)).toEqual([lakeFileId]);
  });

  it('does NOT find it on the retrieval arms, which carry no arm for an unpublished lake', async () => {
    // The control, and the reason the two scopes are separate rather than one widened scope.
    const arms = await retrievalArmsFor([READER_TAG]);
    expect(arms.dataLakeTags).toEqual([]);

    const found = await fabFileRepository.findAccessibleInIds([lakeFileId], { userId: READER }, arms);

    expect(found).toEqual([]);
  });

  it('returns a populated `id` on every hit', async () => {
    // Load-bearing for ImageEdit's strict mask check, which diffs the ids it asked for against
    // the ids that came back and fails the edit on any shortfall. `toObject()` drops virtuals
    // unless the schema opts in, so if `id` ever came back undefined that diff would report
    // EVERY id as unresolved and every edit would fail. Asserted here, against a real server,
    // rather than left to a mock that hands back plain objects.
    const arms = await attachmentArmsFor([READER_TAG]);

    const found = await fabFileRepository.findAccessibleInIds([lakeFileId], { userId: READER }, arms);

    expect(found).toHaveLength(1);
    expect(typeof found[0].id).toBe('string');
    expect(found[0].id).toBe(lakeFileId);
  });

  it('withholds the draft lake from a reader without its required tag, on the attachment scope too', async () => {
    // Guards the widening from proving too much: `includeDraftLakes` opens the STATUS gate and
    // nothing else, so a tag-less caller must still get nothing.
    const arms = await attachmentArmsFor([]);
    expect(arms.dataLakeTags).toEqual([]);

    const found = await fabFileRepository.findAccessibleInIds([lakeFileId], { userId: READER }, arms);

    expect(found).toEqual([]);
  });

  it('resolves the same file on BOTH scopes once the lake is published', async () => {
    // Publishing is what closes the split: the attachment widening is a superset of retrieval, so
    // an active lake must never be the thing that separates them.
    await DataLakeModel.findByIdAndUpdate(lakeId, { status: 'active' });

    for (const arms of [await retrievalArmsFor([READER_TAG]), await attachmentArmsFor([READER_TAG])]) {
      expect(arms.dataLakeTags).toContain(DATALAKE_TAG);

      const found = await fabFileRepository.findAccessibleInIds([lakeFileId], { userId: READER }, arms);

      expect(found.map(f => f.id)).toEqual([lakeFileId]);
    }
  });

  it('still withholds the published lake from a reader without its required tag', async () => {
    // Guards the control above from proving too much: publishing opens the status gate, not the
    // requiredUserTag gate, so a tag-less caller must still get nothing.
    const arms = await attachmentArmsFor([]);

    const found = await fabFileRepository.findAccessibleInIds([lakeFileId], { userId: READER }, arms);

    expect(found).toEqual([]);
  });
});
