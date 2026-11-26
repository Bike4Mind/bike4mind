import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  StudioBrandKitSchema,
  StudioCompositionBriefSchema,
  StudioCompositionContentSchema,
  StudioCompositionResponseSchema,
  StudioCompositionSchema,
  StudioCompositionSummaryResponseSchema,
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

  it('fills an empty brief, brand kit and shot list on a document written without them', async () => {
    const { brief: _brief, brandKit: _brandKit, shots: _shots, ...bare } = composition();
    const created = await StudioComposition.create(bare);
    const found = await studioCompositionRepository.findOwned(created.id, OWNER);
    expect(found).toMatchObject({ brief: {}, brandKit: { colors: [], productFileIds: [], characters: [] }, shots: [] });
  });

  it('round-trips brand kit characters with their own ids', async () => {
    const characters = [{ id: 'maya', name: 'Maya', fileId: 'a'.repeat(24) }];
    const created = await studioCompositionRepository.createOwned(
      composition({ brandKit: { colors: [], productFileIds: [], characters } })
    );
    const found = await studioCompositionRepository.findOwned(created.id, OWNER);
    expect(found?.brandKit.characters).toEqual(characters);
  });

  it('stores a short film brief tone and its sized timeline', async () => {
    const created = await studioCompositionRepository.createOwned(
      composition({
        template: 'short_film',
        brief: { summary: 'A lighthouse keeper finds a message', tone: 'wistful' },
        timeline: defaultStudioTimeline('short_film', { durationMs: 90_000, aspects: ['16:9', '9:16'] }),
      })
    );
    const found = StudioCompositionSchema.parse(await studioCompositionRepository.findOwned(created.id, OWNER));
    expect(found.brief).toEqual({ summary: 'A lighthouse keeper finds a message', tone: 'wistful' });
    expect(found.timeline.durationMs).toBe(90_000);
    expect(found.timeline.outputs.map(output => output.aspectRatio)).toEqual(['16:9', '9:16']);
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
    expect(await studioCompositionRepository.updateOwned('not-an-id', OWNER, { title: 'Renamed' })).toBeNull();
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

  it('reads back documents the route response schemas accept, without ownership fields', async () => {
    const created = await studioCompositionRepository.createOwned(composition({ organizationId: 'org-1' }));

    const item = StudioCompositionResponseSchema.parse(await studioCompositionRepository.findOwned(created.id, OWNER));
    expect(item.id).toBe(created.id);
    expect(item).not.toHaveProperty('userId');
    expect(item).not.toHaveProperty('organizationId');

    const [row] = await studioCompositionRepository.listOwned(OWNER, { limit: 10, skip: 0 });
    const summary = StudioCompositionSummaryResponseSchema.parse(row);
    expect(summary).toMatchObject({ id: created.id, title: 'Spring ad' });
    expect(summary).not.toHaveProperty('userId');
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
