import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import {
  SkillListingTemplate,
  claimSkillTemplateScan,
  markListingTemplateStale,
  releaseStaleSkillTemplateScan,
  unpublishListingTemplate,
  unpublishSkillTemplate,
  writeSkillTemplateScanVerdict,
} from './SkillListingTemplateModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await SkillListingTemplate.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

beforeEach(async () => {
  await SkillListingTemplate.collection.deleteMany({});
});

const create = (fields: Record<string, unknown> = {}) =>
  SkillListingTemplate.create({ listingId: 'listing-1', slug: 'formatter', ...fields });
const find = async (listingId = 'listing-1') => (await SkillListingTemplate.findOne({ listingId }).lean())!;

describe('SkillListingTemplate', () => {
  it('defaults to an empty draft with zeroed counters, free run off and not stale', async () => {
    const doc = (await create()).toJSON();
    expect(doc).toMatchObject({
      headline: '',
      inputs: [],
      examplePrompt: '',
      status: 'draft',
      freeRunEnabled: false,
      generatedFromVersionId: null,
      stale: false,
      viewCount: 0,
      freeRunCount: 0,
      tryCount: 0,
      scanFindings: [],
    });
    expect(doc.firstPublishedAt).toBeUndefined();
    expect(doc.previewImage).toBeUndefined();
  });

  it('holds one template per listing', async () => {
    await create();
    await expect(create({ slug: 'other' })).rejects.toMatchObject({ code: 11000 });
  });

  it('keeps slugs unique across listings', async () => {
    await create();
    await expect(create({ listingId: 'listing-2' })).rejects.toMatchObject({ code: 11000 });
  });

  it('accepts up to three inputs and refuses a fourth', async () => {
    const input = (label: string) => ({ label, required: true });
    await expect(create({ inputs: [input('a'), input('b'), input('c')] })).resolves.toBeTruthy();
    await expect(
      create({ listingId: 'listing-2', slug: 'other', inputs: [input('a'), input('b'), input('c'), input('d')] })
    ).rejects.toThrow(/at most 3 inputs/);
  });

  it('defaults an input to optional', async () => {
    await create({ inputs: [{ label: 'Article text' }] });
    expect((await find()).inputs).toEqual([{ label: 'Article text', required: false }]);
  });

  it('stores a preview image reference with its source', async () => {
    await create({ previewImage: { fabFileId: 'file-1', source: 'upload' } });
    expect((await find()).previewImage).toEqual({ fabFileId: 'file-1', source: 'upload' });
    await expect(
      create({ listingId: 'listing-2', slug: 'other', previewImage: { fabFileId: 'f', source: 'stock' } })
    ).rejects.toThrow(/source/);
  });
});

describe('template scan claim and verdict', () => {
  it('claims a draft with the new copy in the same write and publishes on a passing verdict', async () => {
    await create({ headline: 'old' });
    const claimedAt = new Date();
    const claimed = await claimSkillTemplateScan('listing-1', claimedAt, ['draft'], { headline: 'new' });
    expect(claimed).toMatchObject({ status: 'in_review', scanStatus: 'scanning', headline: 'new' });

    expect(
      await writeSkillTemplateScanVerdict('listing-1', claimedAt, { scanStatus: 'passed', scanFindings: [] }, true)
    ).toBe(true);
    const published = await find();
    expect(published).toMatchObject({ status: 'published', scanStatus: 'passed', scanClaimedAt: null });
    expect(published.firstPublishedAt).toBeInstanceOf(Date);
  });

  it('returns to draft on a failing verdict and keeps the findings', async () => {
    await create();
    const claimedAt = new Date();
    await claimSkillTemplateScan('listing-1', claimedAt, ['draft']);
    const finding = { rule: 'html_or_script', severity: 'critical' as const, message: 'm', source: 'rules' as const };
    await writeSkillTemplateScanVerdict(
      'listing-1',
      claimedAt,
      { scanStatus: 'failed', scanFindings: [finding] },
      false
    );
    const draft = await find();
    expect(draft).toMatchObject({ status: 'draft', scanStatus: 'failed', scanFindings: [finding] });
    expect(draft.firstPublishedAt).toBeUndefined();
  });

  it('keeps the first publish date on a later publish', async () => {
    const first = new Date('2026-01-01T00:00:00Z');
    await create({ status: 'published', firstPublishedAt: first });
    const claimedAt = new Date();
    await claimSkillTemplateScan('listing-1', claimedAt, ['published'], { headline: 'edited' });
    await writeSkillTemplateScanVerdict('listing-1', claimedAt, { scanStatus: 'passed', scanFindings: [] }, true);
    expect((await find()).firstPublishedAt).toEqual(first);
  });

  it('refuses a claim from a status the caller did not name', async () => {
    await create({ status: 'published' });
    expect(await claimSkillTemplateScan('listing-1', new Date(), ['draft'])).toBeNull();
  });

  it('drops a verdict whose claim was replaced', async () => {
    await create();
    const stale = new Date(Date.now() - 1000);
    await claimSkillTemplateScan('listing-1', stale, ['draft']);
    await releaseStaleSkillTemplateScan('listing-1', new Date());
    await claimSkillTemplateScan('listing-1', new Date(), ['draft']);
    expect(
      await writeSkillTemplateScanVerdict('listing-1', stale, { scanStatus: 'passed', scanFindings: [] }, true)
    ).toBe(false);
    expect((await find()).status).toBe('in_review');
  });

  it('releases only an abandoned claim', async () => {
    await create();
    await claimSkillTemplateScan('listing-1', new Date(), ['draft']);
    await releaseStaleSkillTemplateScan('listing-1', new Date(Date.now() - 60_000));
    expect((await find()).status).toBe('in_review');

    await releaseStaleSkillTemplateScan('listing-1', new Date(Date.now() + 1000));
    expect(await find()).toMatchObject({ status: 'draft', scanStatus: 'error' });
  });

  it('unpublishSkillTemplate takes a published page down and keeps the free-run switch', async () => {
    await create({ status: 'published', freeRunEnabled: true });
    expect(await unpublishSkillTemplate('listing-1')).toBe(true);
    expect(await find()).toMatchObject({ status: 'draft', freeRunEnabled: true });
    expect(await unpublishSkillTemplate('listing-1')).toBe(false);
  });
});

describe('lifecycle rules', () => {
  it('markListingTemplateStale flags the template and leaves the author copy as written', async () => {
    const copy = {
      headline: 'Summarize any article',
      inputs: [{ label: 'Article', required: true }],
      examplePrompt: 'Summarize this',
      generatedFromVersionId: 'version-1',
    };
    await create({ ...copy, status: 'published' });
    await markListingTemplateStale('listing-1');
    expect(await find()).toMatchObject({ ...copy, stale: true, status: 'published' });
  });

  it('markListingTemplateStale is a no-op for a listing without a template', async () => {
    await markListingTemplateStale('no-template');
    expect(await SkillListingTemplate.countDocuments()).toBe(0);
  });

  it('unpublishListingTemplate unpublishes and switches the free run off', async () => {
    await create({ status: 'published', freeRunEnabled: true, headline: 'kept' });
    await unpublishListingTemplate('listing-1');
    expect(await find()).toMatchObject({ status: 'draft', freeRunEnabled: false, headline: 'kept' });
  });

  it('unpublishListingTemplate voids a publish scan in flight', async () => {
    await create();
    const claimedAt = new Date();
    await claimSkillTemplateScan('listing-1', claimedAt, ['draft']);
    await unpublishListingTemplate('listing-1');
    expect(
      await writeSkillTemplateScanVerdict('listing-1', claimedAt, { scanStatus: 'passed', scanFindings: [] }, true)
    ).toBe(false);
    expect(await find()).toMatchObject({ status: 'draft', scanStatus: 'error', freeRunEnabled: false });
  });
});
