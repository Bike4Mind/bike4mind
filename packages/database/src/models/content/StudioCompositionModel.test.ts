import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  StudioBrandKitSchema,
  StudioCompositionBriefSchema,
  StudioCompositionContentSchema,
  StudioCompositionSchema,
  defaultStudioTimeline,
  type IStudioComposition,
} from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { StudioComposition, studioCompositionRepository } from './StudioCompositionModel';

const OWNER = 'user-owner';
const OTHER = 'user-other';
const PROJECT_ID = 'f'.repeat(24);

const composition = (overrides: Partial<IStudioComposition> = {}): IStudioComposition => ({
  ...StudioCompositionContentSchema.parse({ title: 'Spring ad', timeline: defaultStudioTimeline('ad_campaign') }),
  userId: OWNER,
  ...overrides,
});

const MONGOOSE_MANAGED_PATHS = ['_id', 'createdAt', 'updatedAt'];

const topLevelPaths = (schema: mongoose.Schema, prefix = '') =>
  Object.keys(schema.paths)
    .filter(path => !MONGOOSE_MANAGED_PATHS.includes(path))
    .map(path => path.slice(prefix.length))
    .sort();

describe('StudioComposition model / Zod parity', () => {
  it('declares exactly the fields of StudioCompositionSchema', () => {
    expect(topLevelPaths(StudioComposition.schema)).toEqual(Object.keys(StudioCompositionSchema.shape).sort());
  });

  it.each([
    ['brief', StudioCompositionBriefSchema.shape],
    ['brandKit', StudioBrandKitSchema.shape],
  ])('declares exactly the %s fields', (field, zodShape) => {
    const subdocument = StudioComposition.schema.path(field) as unknown as { schema: mongoose.Schema };
    expect(topLevelPaths(subdocument.schema)).toEqual(Object.keys(zodShape).sort());
  });
});

describe('StudioCompositionRepository', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
    await StudioComposition.ensureIndexes();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  afterEach(async () => {
    await StudioComposition.deleteMany({});
  });

  it('round-trips a composition with a string id and the Zod-parsed shape', async () => {
    const input = composition({ projectId: PROJECT_ID });
    const created = await studioCompositionRepository.createOwned(input);
    expect(created.id).toMatch(/^[a-f0-9]{24}$/);
    expect(created).not.toHaveProperty('_id');

    const found = await studioCompositionRepository.findOwned(created.id, OWNER);
    expect(found).toMatchObject({ ...input, id: created.id });
    // An empty brief survives as {} (minimize: false), so the stored shape parses back unchanged.
    expect(found?.brief).toEqual({});
    expect(StudioCompositionSchema.parse(found)).toMatchObject(input);
  });

  it("hides another user's composition from every owner-scoped call", async () => {
    const created = await studioCompositionRepository.createOwned(composition());

    expect(await studioCompositionRepository.findOwned(created.id, OTHER)).toBeNull();
    expect(await studioCompositionRepository.listOwned(OTHER, { limit: 10, skip: 0 })).toEqual([]);
    expect(await studioCompositionRepository.updateOwned(created.id, OTHER, { title: 'Hijack' })).toBeNull();
    expect(await studioCompositionRepository.deleteOwned(created.id, OTHER)).toBe(false);
    expect((await studioCompositionRepository.findOwned(created.id, OWNER))?.title).toBe('Spring ad');
  });

  it('treats a malformed id as missing', async () => {
    expect(await studioCompositionRepository.findOwned('not-an-id', OWNER)).toBeNull();
    expect(await studioCompositionRepository.deleteOwned('not-an-id', OWNER)).toBe(false);
  });

  it('lists summaries newest-updated first, without shots or timeline', async () => {
    const first = await studioCompositionRepository.createOwned(composition({ title: 'First' }));
    await studioCompositionRepository.createOwned(composition({ title: 'Second' }));
    // Ensure the edit lands on a later millisecond than both creates.
    await new Promise(resolve => setTimeout(resolve, 5));
    await studioCompositionRepository.updateOwned(first.id, OWNER, { title: 'First, edited' });

    const listed = await studioCompositionRepository.listOwned(OWNER, { limit: 10, skip: 0 });
    expect(listed.map(item => item.title)).toEqual(['First, edited', 'Second']);
    expect(listed[0]).not.toHaveProperty('timeline');
    expect(listed[0]).not.toHaveProperty('shots');
    expect(await studioCompositionRepository.listOwned(OWNER, { limit: 1, skip: 1 })).toHaveLength(1);
  });

  it('sets patched fields and unsets the named ones', async () => {
    const created = await studioCompositionRepository.createOwned(composition({ projectId: PROJECT_ID }));
    const updated = await studioCompositionRepository.updateOwned(created.id, OWNER, { title: 'Renamed' }, [
      'projectId',
    ]);
    expect(updated?.title).toBe('Renamed');
    expect(updated).not.toHaveProperty('projectId');
  });

  it('deletes an owned composition', async () => {
    const created = await studioCompositionRepository.createOwned(composition());
    expect(await studioCompositionRepository.deleteOwned(created.id, OWNER)).toBe(true);
    expect(await studioCompositionRepository.findOwned(created.id, OWNER)).toBeNull();
  });

  it('builds the owner list index', async () => {
    const indexes = await StudioComposition.collection.indexes();
    expect(indexes.map(index => index.key)).toContainEqual({ userId: 1, updatedAt: -1, _id: -1 });
  });
});
