import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

type Row = Record<string, unknown>;

// Files, quests and notebooks are looked up by id only, so in-memory rows stand in for them.
const rows = vi.hoisted(() => ({
  files: new Map<string, Row>(),
  quests: new Map<string, Row>(),
  sessions: new Map<string, Row>(),
}));

vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<object>()),
  fabFileRepository: { findById: async (id: string) => rows.files.get(id) ?? null },
  questRepository: { findById: async (id: string) => rows.quests.get(id) ?? null },
  sessionRepository: { findById: async (id: string) => rows.sessions.get(id) ?? null },
}));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: vi.fn() },
  getEffectiveApiKeyByBackend: vi.fn(),
}));

import { HTTPError } from '@bike4mind/common';
import { SkillListing, SkillListingTemplate, SkillListingVersion } from '@bike4mind/database';
import { ImageDecodeError } from '@bike4mind/utils/imageResize';
import { publishOwnTemplate, setOwnTemplateFreeRun, templateSummariesByListing } from './template';
import {
  approveOwnTemplateImage,
  findPublicTemplateImage,
  getOwnTemplateView,
  prepareTemplateImageGeneration,
  removeOwnTemplateImage,
  setOwnTemplateImageFromGeneration,
  setOwnTemplateImageFromUpload,
  type TemplateImageDeps,
} from './templateImage';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;
beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const AUTHOR = { id: 'author-1', isAdmin: false };
const OTHER = { id: 'other-1', isAdmin: false };
const SRC_BYTES = Buffer.from('source image');
const NORMALIZED = Buffer.from('normalized jpeg');

let deps: { [K in keyof TemplateImageDeps]: Mock<TemplateImageDeps[K]> };
let stored = 0;

beforeEach(async () => {
  rows.files.clear();
  rows.quests.clear();
  rows.sessions.clear();
  stored = 0;
  deps = {
    readFile: vi.fn<TemplateImageDeps['readFile']>(async () => SRC_BYTES),
    readGeneratedImage: vi.fn<TemplateImageDeps['readGeneratedImage']>(async () => SRC_BYTES),
    normalize: vi.fn<TemplateImageDeps['normalize']>(async () => NORMALIZED),
    storeImage: vi.fn<TemplateImageDeps['storeImage']>(async () => {
      stored += 1;
      const id = `stored-${stored}`;
      rows.files.set(id, file({ filePath: `files/${id}.jpg`, mimeType: 'image/jpeg' }));
      return id;
    }),
    signFileUrl: vi.fn<TemplateImageDeps['signFileUrl']>(async key => `https://signed.example/${key}`),
  };
  await Promise.all([
    SkillListing.deleteMany({}),
    SkillListingVersion.deleteMany({}),
    SkillListingTemplate.deleteMany({}),
  ]);
});

const file = (fields: Row = {}): Row => ({
  userId: AUTHOR.id,
  filePath: 'files/upload.png',
  mimeType: 'image/png',
  fileSize: 1000,
  moderationStatus: 'clean',
  deletedAt: null,
  ...fields,
});

let listingCount = 0;

/** A live listing with an approved version. */
async function makeListing(fields: Row = {}, snapshot: Row = {}): Promise<string> {
  listingCount += 1;
  const name = (fields.name as string | undefined) ?? 'summarize';
  const listing = await SkillListing.create({
    sourceSkillId: `skill-${listingCount}`,
    authorUserId: AUTHOR.id,
    visibility: 'public',
    name,
    description: 'Summarizes',
    status: 'approved',
    ...fields,
  });
  const listingId = String(listing._id);
  const version = await SkillListingVersion.create({
    listingId,
    version: 1,
    snapshot: { name, description: 'Summarizes', body: 'Summarize it.', ...snapshot },
    contentHash: `hash-${listingCount}`,
    scanStatus: 'passed',
    reviewStatus: 'auto_approved',
  });
  await SkillListing.updateOne({ _id: listingId }, { $set: { currentApprovedVersionId: String(version._id) } });
  return listingId;
}

const makeTemplate = (listingId: string, fields: Row = {}) =>
  SkillListingTemplate.create({ listingId, slug: 'summarize', headline: 'Three bullets from any article', ...fields });

const storedTemplate = async (listingId: string) => (await SkillListingTemplate.findOne({ listingId }).lean())!;

async function failure(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HTTPError) return { status: error.statusCode, message: error.message };
    throw error;
  }
  throw new Error('expected a failure');
}

describe('upload', () => {
  it('stores a normalized copy owned by the author as a new, unapproved image', async () => {
    const listingId = await makeListing();
    await makeTemplate(listingId);
    rows.files.set('up-1', file());

    const template = await setOwnTemplateImageFromUpload(AUTHOR, listingId, 'up-1', deps);

    expect(deps.readFile).toHaveBeenCalledWith('files/upload.png');
    expect(deps.normalize).toHaveBeenCalledWith(SRC_BYTES);
    expect(deps.storeImage).toHaveBeenCalledWith(AUTHOR.id, NORMALIZED, 'summarize-preview.jpg');
    expect(template.previewImage).toEqual({ fabFileId: 'stored-1', source: 'upload', approved: false });
  });

  it.each([
    ['a file another user owns', file({ userId: OTHER.id }), 404, 'File not found'],
    ['a deleted file', file({ deletedAt: new Date() }), 404, 'File not found'],
    ['a file that is not a PNG or JPEG', file({ mimeType: 'image/gif' }), 400, 'Upload a PNG or JPEG image'],
    ['a blocked file', file({ moderationStatus: 'blocked' }), 400, 'This image cannot be used. Choose another one.'],
    ['a file over the size cap', file({ fileSize: 11 * 1024 * 1024 }), 400, 'The image must be 10 MB or smaller'],
  ])('refuses %s', async (_label, row, status, message) => {
    const listingId = await makeListing();
    await makeTemplate(listingId);
    rows.files.set('up-1', row);
    expect(await failure(setOwnTemplateImageFromUpload(AUTHOR, listingId, 'up-1', deps))).toEqual({ status, message });
    expect(deps.storeImage).not.toHaveBeenCalled();
    expect((await storedTemplate(listingId)).previewImage).toBeUndefined();
  });

  it('answers 409 while the upload is not readable yet, and 400 for bytes that do not decode', async () => {
    const listingId = await makeListing();
    await makeTemplate(listingId);
    rows.files.set('up-1', file());

    deps.readFile.mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'NoSuchKey' }));
    expect((await failure(setOwnTemplateImageFromUpload(AUTHOR, listingId, 'up-1', deps))).status).toBe(409);

    deps.readFile.mockRejectedValueOnce(new Error('AccessDenied'));
    await expect(setOwnTemplateImageFromUpload(AUTHOR, listingId, 'up-1', deps)).rejects.toThrow('AccessDenied');

    deps.normalize.mockRejectedValueOnce(new ImageDecodeError('bad'));
    expect(await failure(setOwnTemplateImageFromUpload(AUTHOR, listingId, 'up-1', deps))).toEqual({
      status: 400,
      message: 'The image could not be read. Use a PNG or JPEG.',
    });
    expect(deps.storeImage).not.toHaveBeenCalled();
  });

  it('is author only, needs a saved draft and refuses a published template', async () => {
    const listingId = await makeListing();
    rows.files.set('up-1', file());
    expect(await failure(setOwnTemplateImageFromUpload(AUTHOR, listingId, 'up-1', deps))).toEqual({
      status: 404,
      message: 'Save the template first',
    });

    await makeTemplate(listingId, { status: 'published' });
    expect((await failure(setOwnTemplateImageFromUpload(OTHER, listingId, 'up-1', deps))).status).toBe(403);
    expect(await failure(setOwnTemplateImageFromUpload(AUTHOR, listingId, 'up-1', deps))).toEqual({
      status: 409,
      message: 'Unpublish the template to change its image',
    });
    expect(deps.storeImage).not.toHaveBeenCalled();
  });
});

describe('generation', () => {
  it('builds the prompt from the headline and the pasted result in a named notebook', async () => {
    const listingId = await makeListing();
    await makeTemplate(listingId);
    const { prompt, sessionName } = await prepareTemplateImageGeneration(AUTHOR, listingId, 'Bullet one');
    expect(prompt).toContain('Three bullets from any article');
    expect(prompt).toContain('Bullet one');
    expect(sessionName).toBe('Template image for /summarize');
  });

  it('needs a headline and a draft', async () => {
    const listingId = await makeListing();
    await makeTemplate(listingId, { headline: '  ' });
    expect((await failure(prepareTemplateImageGeneration(AUTHOR, listingId, 'x'))).status).toBe(400);
    await SkillListingTemplate.updateOne({ listingId }, { $set: { headline: 'H', status: 'published' } });
    expect((await failure(prepareTemplateImageGeneration(AUTHOR, listingId, 'x'))).status).toBe(409);
  });

  it("uses the first image of the author's own finished generation", async () => {
    const listingId = await makeListing();
    await makeTemplate(listingId);
    rows.sessions.set('s-1', { userId: AUTHOR.id });
    rows.quests.set('q-1', {
      sessionId: 's-1',
      promptMeta: { model: { type: 'image' } },
      images: ['notes.txt', 'abc.png'],
    });

    const template = await setOwnTemplateImageFromGeneration(AUTHOR, listingId, 'q-1', deps);

    expect(deps.readGeneratedImage).toHaveBeenCalledWith('abc.png');
    expect(template.previewImage).toEqual({ fabFileId: 'stored-1', source: 'generated', approved: false });
  });

  it.each([
    ["another user's generation", { userId: OTHER.id }, { images: ['a.png'] }, 404],
    ['a text answer', { userId: AUTHOR.id }, { images: ['a.png'], promptMeta: { model: { type: 'text' } } }, 400],
    ['an unfinished generation', { userId: AUTHOR.id }, { images: [] }, 409],
    ['a failed generation', { userId: AUTHOR.id }, { images: [], type: 'error' }, 409],
  ])('refuses %s', async (_label, session, quest, status) => {
    const listingId = await makeListing();
    await makeTemplate(listingId);
    rows.sessions.set('s-1', session);
    rows.quests.set('q-1', { sessionId: 's-1', promptMeta: { model: { type: 'image' } }, ...quest });
    expect((await failure(setOwnTemplateImageFromGeneration(AUTHOR, listingId, 'q-1', deps))).status).toBe(status);
    expect(deps.storeImage).not.toHaveBeenCalled();
  });
});

describe('approve, remove and publish', () => {
  async function withImage(moderationStatus = 'clean') {
    const listingId = await makeListing();
    await makeTemplate(listingId, { previewImage: { fabFileId: 'img-1', source: 'upload' } });
    rows.files.set('img-1', file({ filePath: 'files/img-1.jpg', mimeType: 'image/jpeg', moderationStatus }));
    return listingId;
  }

  it('approves a checked image, and a replacement starts unapproved again', async () => {
    const listingId = await withImage();
    expect((await approveOwnTemplateImage(AUTHOR, listingId)).previewImage).toMatchObject({ approved: true });

    rows.files.set('up-1', file());
    const replaced = await setOwnTemplateImageFromUpload(AUTHOR, listingId, 'up-1', deps);
    expect(replaced.previewImage).toEqual({ fabFileId: 'stored-1', source: 'upload', approved: false });
  });

  it.each([
    ['pending', 409],
    ['blocked', 400],
  ])('refuses to approve a %s image', async (moderationStatus, status) => {
    const listingId = await withImage(moderationStatus);
    expect((await failure(approveOwnTemplateImage(AUTHOR, listingId))).status).toBe(status);
    expect((await storedTemplate(listingId)).previewImage?.approved).toBe(false);
  });

  it('refuses to approve a missing image or a deleted file', async () => {
    const listingId = await makeListing();
    await makeTemplate(listingId, { slug: 'no-image' });
    expect((await failure(approveOwnTemplateImage(AUTHOR, listingId))).message).toBe('Add a preview image first');

    const withFile = await withImage();
    rows.files.delete('img-1');
    expect((await failure(approveOwnTemplateImage(AUTHOR, withFile))).status).toBe(409);
  });

  it('removes the image from a draft only', async () => {
    const listingId = await withImage();
    expect((await removeOwnTemplateImage(AUTHOR, listingId)).previewImage).toBeUndefined();

    await SkillListingTemplate.updateOne({ listingId }, { $set: { status: 'published' } });
    expect((await failure(removeOwnTemplateImage(AUTHOR, listingId))).status).toBe(409);
    expect((await failure(approveOwnTemplateImage(AUTHOR, listingId))).status).toBe(409);
  });

  it('publish refuses an unapproved image before scanning', async () => {
    const listingId = await withImage();
    const getClassifier = vi.fn();
    expect(await failure(publishOwnTemplate(AUTHOR, listingId, { getClassifier }))).toEqual({
      status: 400,
      message: 'Approve the preview image before publishing',
    });
    expect(getClassifier).not.toHaveBeenCalled();
    expect((await storedTemplate(listingId)).status).toBe('draft');
  });
});

describe('free run', () => {
  it('turns on for an eligible skill and off again', async () => {
    const listingId = await makeListing();
    await makeTemplate(listingId);
    expect((await setOwnTemplateFreeRun(AUTHOR, listingId, true)).freeRunEnabled).toBe(true);
    expect((await setOwnTemplateFreeRun(AUTHOR, listingId, false)).freeRunEnabled).toBe(false);
  });

  it.each([
    [{ allowedTools: ['web_search'] }, 'This skill uses tools, so it cannot offer a free run.'],
    [
      { files: [{ path: 'scripts/run.py', content: 'x' }] },
      'This skill needs supporting files, so it cannot offer a free run.',
    ],
  ])('refuses to turn on for an ineligible skill, with the reason', async (snapshot, message) => {
    const listingId = await makeListing({}, snapshot);
    await makeTemplate(listingId, { freeRunEnabled: true });
    expect(await failure(setOwnTemplateFreeRun(AUTHOR, listingId, true))).toEqual({ status: 409, message });
    expect((await setOwnTemplateFreeRun(AUTHOR, listingId, false)).freeRunEnabled).toBe(false);
  });

  it('refuses while the template is being scanned, and without a template', async () => {
    const listingId = await makeListing();
    expect((await failure(setOwnTemplateFreeRun(AUTHOR, listingId, true))).status).toBe(404);
    await makeTemplate(listingId, { status: 'in_review', scanClaimedAt: new Date() });
    expect((await failure(setOwnTemplateFreeRun(AUTHOR, listingId, true))).status).toBe(409);
    expect((await failure(setOwnTemplateFreeRun(OTHER, listingId, false))).status).toBe(403);
  });
});

describe('editor view', () => {
  it('suggests a free slug and the eligibility before a template exists', async () => {
    const taken = await makeListing({ name: 'other-skill' });
    await makeTemplate(taken, { slug: 'summarize' });
    const listingId = await makeListing({}, { allowedTools: ['web_search'] });

    const view = await getOwnTemplateView(AUTHOR, listingId, deps);

    expect(view).toMatchObject({
      template: null,
      listing: { id: listingId, name: 'summarize', visibility: 'public', live: true },
      currentApprovedVersionId: expect.any(String),
      eligibility: { eligible: false, reason: expect.stringContaining('uses tools') },
      suggestedSlug: 'summarize-2',
      previewImageUrl: null,
      previewImageStatus: null,
    });
  });

  it('signs the image URL only once the image passed moderation', async () => {
    const listingId = await makeListing();
    await makeTemplate(listingId, { previewImage: { fabFileId: 'img-1', source: 'upload' } });
    const image = (fields: Row = {}) => file({ filePath: 'files/img-1.jpg', mimeType: 'image/jpeg', ...fields });
    rows.files.set('img-1', image({ moderationStatus: 'pending' }));
    expect(await getOwnTemplateView(AUTHOR, listingId, deps)).toMatchObject({
      suggestedSlug: null,
      previewImageUrl: null,
      previewImageStatus: 'pending',
    });

    rows.files.set('img-1', image());
    expect(await getOwnTemplateView(AUTHOR, listingId, deps)).toMatchObject({
      previewImageUrl: 'https://signed.example/files/img-1.jpg',
      previewImageStatus: 'ready',
    });

    rows.files.delete('img-1');
    expect((await getOwnTemplateView(AUTHOR, listingId, deps)).previewImageStatus).toBe('missing');
  });

  it('is author only and has no eligibility for a listing that is not live', async () => {
    const listingId = await makeListing({ status: 'withdrawn' });
    expect((await failure(getOwnTemplateView(OTHER, listingId, deps))).status).toBe(403);
    expect(await getOwnTemplateView(AUTHOR, listingId, deps)).toMatchObject({
      listing: { live: false },
      currentApprovedVersionId: null,
      eligibility: null,
    });
  });
});

describe('findPublicTemplateImage', () => {
  async function published(listingFields: Row = {}, imageFields: Row = {}, fileFields: Row = {}) {
    const listingId = await makeListing(listingFields);
    await makeTemplate(listingId, {
      status: 'published',
      previewImage: { fabFileId: 'img-1', source: 'upload', approved: true, ...imageFields },
    });
    rows.files.set('img-1', file({ filePath: 'files/img-1.jpg', mimeType: 'image/jpeg', ...fileFields }));
    return listingId;
  }

  it.each([['public'], ['unlisted']])('serves the approved image of a published %s template', async visibility => {
    await published({ visibility });
    expect(await findPublicTemplateImage('summarize')).toMatchObject({
      filePath: 'files/img-1.jpg',
      mimeType: 'image/jpeg',
    });
  });

  it.each([
    ['an unapproved image', {}, { approved: false }, {}],
    ['an organization listing', { visibility: 'organization', organizationId: 'org-1' }, {}, {}],
    ['a hidden listing', { hiddenByReports: true }, {}, {}],
    ['a withdrawn listing', { status: 'withdrawn' }, {}, {}],
    ['a file still in moderation', {}, {}, { moderationStatus: 'pending' }],
    ['a file the author no longer owns', {}, {}, { userId: OTHER.id }],
  ])('hides %s', async (_label, listingFields, imageFields, fileFields) => {
    await published(listingFields, imageFields, fileFields);
    expect(await findPublicTemplateImage('summarize')).toBeNull();
  });

  it('hides a draft template and an unknown slug', async () => {
    const listingId = await published();
    await SkillListingTemplate.updateOne({ listingId }, { $set: { status: 'draft' } });
    expect(await findPublicTemplateImage('summarize')).toBeNull();
    expect(await findPublicTemplateImage('nothing-here')).toBeNull();
  });
});

describe('templateSummariesByListing', () => {
  it('maps each listing to its slug and status in one lookup', async () => {
    const a = await makeListing({ name: 'a' });
    const b = await makeListing({ name: 'b' });
    await makeTemplate(a, { slug: 'a', status: 'published' });
    const summaries = await templateSummariesByListing([a, b]);
    expect(summaries.get(a)).toEqual({ slug: 'a', status: 'published' });
    expect(summaries.has(b)).toBe(false);
    expect((await templateSummariesByListing([])).size).toBe(0);
  });
});
