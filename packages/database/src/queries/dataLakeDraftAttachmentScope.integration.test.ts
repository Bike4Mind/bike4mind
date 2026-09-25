import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType } from '@bike4mind/common';
import { createMongoServer } from '../__test__/createMongoServer';
import { FabFile, fabFileRepository } from '../models/content/FabFileModel';
import { DataLakeModel, dataLakeRepository } from '../models/ai/DataLakeModel';

/**
 * Pins the DRAFT-lake gap between the two doors that authorize a lake file, against the real
 * lake and fabFile repositories.
 *
 * Browse (`listDataLakes`, behind `GET /api/files/byIds`) selects `status: { $in: ['draft',
 * 'active'] }`. Retrieval (`findActiveByUserTagsAndEntitlements`, which every attachment door
 * resolves its lake arms through) selects `status: 'active'` alone, and a new lake defaults to
 * `draft`. So a file in an unpublished lake is attachable in the UI and readable through byIds,
 * while `findAccessibleInIds` - the predicate the image edit/generation paths scope on - returns
 * nothing for it.
 *
 * That asymmetry is deliberate on the retrieval side (`resolveRetrievalLakeScope`: "Browse stays
 * the wider of the two ... draft lakes. Do not paper those over here") but it means the edit path
 * silently drops a file the workbench admitted. This test exists so the gap is a recorded,
 * asserted behaviour rather than a surprise the next reader has to rediscover from a QA report;
 * whichever door is eventually moved, one of these assertions must be updated deliberately.
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
 * The arms an attachment door would hand `findAccessibleInIds`, derived the way production derives
 * them: ask the lake repository what this caller reaches, then project the reachable lakes into
 * tag/prefix buckets. A lake the repository withholds contributes no arm - which is the mechanism
 * under test, so it must not be short-circuited by hardcoding the tag.
 */
const attachmentArmsFor = async (userTags: string[]) => {
  const lakes = await dataLakeRepository.findActiveByUserTagsAndEntitlements(userTags, undefined, []);
  return {
    dataLakeTags: lakes.map(lake => lake.datalakeTag),
    dataLakeTagPrefixes: lakes.map(lake => lake.fileTagPrefix),
  };
};

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

  it('withholds a draft lake from the retrieval resolver even for a tag-holding reader', async () => {
    const lakes = await dataLakeRepository.findActiveByUserTagsAndEntitlements([READER_TAG], undefined, []);

    expect(lakes.map(l => l.slug)).not.toContain(SLUG);
  });

  it('drops the draft lake file from findAccessibleInIds, though the workbench admitted it', async () => {
    // The gap in one assertion: no arms, so the image edit/generation lookup returns nothing for a
    // file the caller can attach and read through byIds.
    const arms = await attachmentArmsFor([READER_TAG]);
    expect(arms.dataLakeTags).toEqual([]);

    const found = await fabFileRepository.findAccessibleInIds([lakeFileId], { userId: READER }, arms);

    expect(found).toEqual([]);
  });

  it('resolves the same file once the lake is published', async () => {
    // The control: nothing about the file or the caller changes, only the lake's status - which
    // localises the drop above to the status filter and not to the tag arms or the file's shape.
    await DataLakeModel.findByIdAndUpdate(lakeId, { status: 'active' });

    const arms = await attachmentArmsFor([READER_TAG]);
    expect(arms.dataLakeTags).toContain(DATALAKE_TAG);

    const found = await fabFileRepository.findAccessibleInIds([lakeFileId], { userId: READER }, arms);

    expect(found.map(f => f.id)).toEqual([lakeFileId]);
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

  it('still withholds the published lake from a reader without its required tag', async () => {
    // Guards the control above from proving too much: publishing opens the status gate, not the
    // requiredUserTag gate, so a tag-less caller must still get nothing.
    const arms = await attachmentArmsFor([]);

    const found = await fabFileRepository.findAccessibleInIds([lakeFileId], { userId: READER }, arms);

    expect(found).toEqual([]);
  });
});
