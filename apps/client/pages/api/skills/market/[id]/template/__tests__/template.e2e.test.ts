import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMocks } from 'node-mocks-http';
import { ZodError } from 'zod';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../../../packages/database/src/__test__/createMongoServer';

type Handler = (req: unknown, res: unknown) => unknown;

// One stub model for both the scan (the security-reviewer prompt) and the draft. "EVIL" in the
// scanned copy fails the classifier verdict, "THROW" errors it; `onComplete` runs a side effect.
const llm = vi.hoisted(() => ({
  calls: [] as Array<{ system: string; user: string }>,
  onComplete: null as null | (() => Promise<void>),
}));
const classifier = vi.hoisted(() => ({
  model: 'stub',
  complete: async (system: string, user: string) => {
    llm.calls.push({ system, user });
    await llm.onComplete?.();
    if (!system.includes('security reviewer')) {
      return JSON.stringify({
        headline: 'Turn any article into three bullets',
        inputs: [{ label: 'Article text', required: true }],
        examplePrompt: 'Summarize this post about solar panels',
      });
    }
    if (user.includes('THROW')) throw new Error('provider down');
    return JSON.stringify({
      nonce: system.match(/Set "nonce" to exactly "([0-9a-f]+)"/)?.[1],
      verdict: user.includes('EVIL') ? 'fail' : 'pass',
      confidence: 0.95,
      findings: user.includes('EVIL') ? [{ rule: 'injection', severity: 'critical', message: 'Hijacks' }] : [],
      honestSummary: {
        whatItDoes: 'Describes a summarizer.',
        toolsUsed: [],
        dataItTouches: 'None.',
        riskNotes: [],
        descriptionMatches: true,
      },
    });
  },
}));

vi.mock('@server/skillMarket/classifySkill', async importOriginal => ({
  ...(await importOriginal<object>()),
  getOperationsClassifierLlm: async () => classifier,
}));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: vi.fn() },
  getEffectiveApiKeyByBackend: vi.fn(),
}));
vi.mock('@bike4mind/database/infra', async importOriginal => ({
  ...(await importOriginal<object>()),
  organizationRepository: { findMembershipOrgIds: async () => [], findIdsAdministeredBy: async () => [] },
}));
vi.mock('@server/utils/dispatchQuest', () => ({ dispatchSigned: vi.fn() }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: (error?: unknown) => void) => next(),
}));
// Run the real route handlers without the auth/DB middleware chain: req.user is set by the test.
vi.mock('@client/server/middlewares/baseApi', () => ({
  baseApi: () => {
    const handlers: Record<string, Handler> = {};
    const fn = (async (req: { method: string }, res: unknown) => handlers[req.method](req, res)) as Handler &
      Record<string, (handler: unknown) => unknown>;
    for (const method of ['get', 'post', 'put', 'delete']) {
      fn[method] = (handler: unknown) => ((handlers[method.toUpperCase()] = handler as Handler), fn);
    }
    fn.use = () => fn;
    return fn;
  },
}));

import { HTTPError } from '@bike4mind/common';
import { SkillListing, SkillListingTemplate, SkillListingVersion, skillRepository } from '@bike4mind/database';
import templateHandler from '../index';
import draftHandler from '../draft';
import publishHandler from '../publish';
import exampleHandler from '../example';
import { writeTemplateExample } from '@server/skillMarket/template';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([
    SkillListing.ensureIndexes(),
    SkillListingVersion.ensureIndexes(),
    SkillListingTemplate.ensureIndexes(),
  ]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});
beforeEach(async () => {
  llm.calls.length = 0;
  llm.onComplete = null;
  await Promise.all(
    ['skills', 'skill_listings', 'skill_listing_versions', 'skill_listing_templates'].map(c =>
      mongoose.connection.db!.collection(c).deleteMany({})
    )
  );
});

const AUTHOR = { id: 'author-1', isAdmin: false };
const OTHER = { id: 'other-1', isAdmin: false };
const ADMIN = { id: 'admin-1', isAdmin: true };

/** An approved listing whose live skill and pending version both differ from the approved snapshot. */
async function makeListing(name = 'summarize', authorUserId = AUTHOR.id): Promise<string> {
  const skill = await skillRepository.create({
    name,
    description: 'Summarizes',
    body: 'LIVE SKILL BODY',
    userId: authorUserId,
    users: [],
    groups: [],
    isGlobalRead: false,
    isGlobalWrite: false,
  } as never);
  const listing = await SkillListing.create({
    sourceSkillId: String((skill as { id: string }).id),
    authorUserId,
    visibility: 'public',
    name,
    description: 'Summarizes',
    status: 'approved',
  });
  const listingId = String(listing._id);
  const version = (body: string, n: number, reviewStatus: string) =>
    SkillListingVersion.create({
      listingId,
      version: n,
      snapshot: { name, description: 'Summarizes', body },
      contentHash: `hash-${n}`,
      scanStatus: 'passed',
      reviewStatus,
    });
  const approved = await version('APPROVED BODY', 1, 'auto_approved');
  const pending = await version('PENDING BODY', 2, 'pending');
  await SkillListing.updateOne(
    { _id: listingId },
    {
      $set: {
        currentApprovedVersionId: String(approved._id),
        currentVersion: 1,
        pendingVersionId: String(pending._id),
        pendingVersion: 2,
        latestVersion: 2,
      },
    }
  );
  return listingId;
}

type Result = { status: number; body?: Record<string, unknown>; error?: string };

async function call(
  handler: unknown,
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  listingId: string,
  user: { id: string; isAdmin: boolean } = AUTHOR,
  body?: Record<string, unknown>
): Promise<Result> {
  const { req, res } = createMocks({ method, query: { id: listingId }, body });
  Object.assign(req, { user, logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } });
  try {
    await (handler as Handler)(req, res);
    return { status: res._getStatusCode(), body: res._isJSON() ? res._getJSONData() : undefined };
  } catch (error) {
    if (error instanceof HTTPError) return { status: error.statusCode, error: error.message };
    if (error instanceof ZodError) return { status: 400, error: error.message };
    throw error;
  }
}

const template = (r: Result) => r.body?.template as Record<string, unknown>;
const stored = (listingId: string) => SkillListingTemplate.findOne({ listingId }).lean();
const copy = {
  headline: 'Turn any article into three bullets',
  inputs: [{ label: 'Article text', required: true }],
  examplePrompt: 'Summarize this post about solar panels',
};

async function publishedTemplate(listingId: string) {
  await call(templateHandler, 'PUT', listingId, AUTHOR, copy);
  const published = await call(publishHandler, 'POST', listingId);
  expect(template(published).status).toBe('published');
}

describe('access', () => {
  it.each([
    ['GET', templateHandler, undefined],
    ['PUT', templateHandler, copy],
    ['DELETE', templateHandler, undefined],
    ['POST', draftHandler, undefined],
    ['POST', publishHandler, undefined],
    ['DELETE', publishHandler, undefined],
  ] as const)('%s refuses a non-author and a non-author super-admin', async (method, handler, body) => {
    const listingId = await makeListing();
    await call(templateHandler, 'PUT', listingId, AUTHOR, copy);
    for (const user of [OTHER, ADMIN]) {
      expect((await call(handler, method, listingId, user, body)).status).toBe(403);
    }
    expect(llm.calls).toEqual([]);
    expect(await stored(listingId)).toMatchObject({ status: 'draft', headline: copy.headline });
  });

  it.each([
    ['GET', templateHandler],
    ['PUT', templateHandler],
    ['DELETE', templateHandler],
    ['POST', draftHandler],
    ['POST', publishHandler],
    ['DELETE', publishHandler],
  ] as const)('%s 404s for a missing or malformed listing id', async (method, handler) => {
    for (const id of [new mongoose.Types.ObjectId().toHexString(), 'not-an-id']) {
      expect((await call(handler, method, id, AUTHOR, {})).status).toBe(404);
    }
  });

  it('the author reads, updates and deletes the template', async () => {
    const listingId = await makeListing();
    expect((await call(templateHandler, 'GET', listingId)).body).toMatchObject({
      template: null,
      suggestedSlug: 'summarize',
      currentApprovedVersionId: expect.any(String),
      eligibility: { eligible: true },
      listing: { id: listingId, name: 'summarize', visibility: 'public', live: true },
      previewImageUrl: null,
      previewImageStatus: null,
    });

    const created = await call(templateHandler, 'PUT', listingId, AUTHOR, copy);
    expect(created.status).toBe(200);
    expect(template(created)).toMatchObject({ ...copy, slug: 'summarize', status: 'draft', listingId });

    await call(templateHandler, 'PUT', listingId, AUTHOR, { headline: 'Edited' });
    expect(template(await call(templateHandler, 'GET', listingId))).toMatchObject({
      headline: 'Edited',
      inputs: copy.inputs,
    });

    expect((await call(templateHandler, 'DELETE', listingId)).status).toBe(204);
    expect((await call(templateHandler, 'GET', listingId)).body).toMatchObject({ template: null });
    expect((await call(templateHandler, 'DELETE', listingId)).status).toBe(404);
  });

  it('refuses to create or edit a template for a listing that is not approved', async () => {
    const listingId = await makeListing();
    await SkillListing.updateOne({ _id: listingId }, { $set: { status: 'withdrawn' } });
    expect((await call(templateHandler, 'PUT', listingId, AUTHOR, copy)).status).toBe(409);
    expect(await stored(listingId)).toBeNull();
  });
});

describe('slug', () => {
  it('derives the slug from the skill name with a numeric suffix on a clash', async () => {
    const slugs = [];
    for (const author of ['a-1', 'a-2', 'a-3']) {
      const listingId = await makeListing('Summarize', author);
      slugs.push(template(await call(templateHandler, 'PUT', listingId, { id: author, isAdmin: false }, copy)).slug);
    }
    expect(slugs).toEqual(['summarize', 'summarize-2', 'summarize-3']);
  });

  it('skips a reserved word when deriving', async () => {
    const listingId = await makeListing('admin');
    expect(template(await call(templateHandler, 'PUT', listingId, AUTHOR, copy)).slug).toBe('admin-2');
  });

  it('accepts an author-chosen slug and refuses a reserved, malformed or taken one', async () => {
    const first = await makeListing('summarize', 'a-1');
    await call(templateHandler, 'PUT', first, { id: 'a-1', isAdmin: false }, { ...copy, slug: 'article-bullets' });
    const listingId = await makeListing();

    expect(await call(templateHandler, 'PUT', listingId, AUTHOR, { slug: 'login' })).toMatchObject({ status: 400 });
    expect(await call(templateHandler, 'PUT', listingId, AUTHOR, { slug: 'Not_Valid' })).toMatchObject({
      status: 400,
    });
    expect(await call(templateHandler, 'PUT', listingId, AUTHOR, { slug: 'article-bullets' })).toMatchObject({
      status: 409,
    });
    expect(template(await call(templateHandler, 'PUT', listingId, AUTHOR, { slug: 'my-bullets' })).slug).toBe(
      'my-bullets'
    );
    expect(template(await call(templateHandler, 'PUT', listingId, AUTHOR, { slug: 'other-bullets' })).slug).toBe(
      'other-bullets'
    );
    expect(await call(templateHandler, 'PUT', listingId, AUTHOR, { slug: 'article-bullets' })).toMatchObject({
      status: 409,
    });
  });

  it('freezes the slug once the template has been published, even after unpublishing', async () => {
    const listingId = await makeListing();
    await publishedTemplate(listingId);
    expect(await call(templateHandler, 'PUT', listingId, AUTHOR, { slug: 'renamed' })).toMatchObject({ status: 409 });
    await call(publishHandler, 'DELETE', listingId);
    expect(await call(templateHandler, 'PUT', listingId, AUTHOR, { slug: 'renamed' })).toMatchObject({ status: 409 });
    expect((await stored(listingId))?.slug).toBe('summarize');
    expect(template(await call(templateHandler, 'PUT', listingId, AUTHOR, { slug: 'summarize' })).slug).toBe(
      'summarize'
    );
  });
});

describe('draft', () => {
  it('builds the draft from the approved version snapshot only', async () => {
    const listingId = await makeListing();
    const approvedId = (await SkillListing.findById(listingId).lean())!.currentApprovedVersionId;

    const res = await call(draftHandler, 'POST', listingId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ draft: { ...copy, takesFile: false }, generatedFromVersionId: approvedId });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].user).toContain('APPROVED BODY');
    expect(llm.calls[0].user).not.toContain('PENDING BODY');
    expect(llm.calls[0].user).not.toContain('LIVE SKILL BODY');
    expect(await stored(listingId)).toBeNull();
  });

  it('refuses a listing that is not approved', async () => {
    const listingId = await makeListing();
    await SkillListing.updateOne({ _id: listingId }, { $set: { status: 'delisted' } });
    expect((await call(draftHandler, 'POST', listingId)).status).toBe(409);
    expect(llm.calls).toEqual([]);
  });

  it('confirming the copy against the current version clears stale; an old version is refused', async () => {
    const listingId = await makeListing();
    const approvedId = (await SkillListing.findById(listingId).lean())!.currentApprovedVersionId;
    await call(templateHandler, 'PUT', listingId, AUTHOR, copy);
    await SkillListingTemplate.updateOne({ listingId }, { $set: { stale: true } });

    expect(
      await call(templateHandler, 'PUT', listingId, AUTHOR, { generatedFromVersionId: 'older-version' })
    ).toMatchObject({ status: 409 });
    const confirmed = await call(templateHandler, 'PUT', listingId, AUTHOR, { generatedFromVersionId: approvedId });
    expect(template(confirmed)).toMatchObject({ stale: false, generatedFromVersionId: approvedId });
  });
});

describe('scan on publish', () => {
  it('a passing scan publishes the template and stamps the first publish', async () => {
    const listingId = await makeListing();
    await call(templateHandler, 'PUT', listingId, AUTHOR, copy);
    const res = await call(publishHandler, 'POST', listingId);
    expect(res.status).toBe(200);
    expect(template(res)).toMatchObject({ status: 'published', scanStatus: 'passed', riskTier: 'clean' });
    expect(template(res).firstPublishedAt).toBeTruthy();
    const scanned = llm.calls.find(c => c.system.includes('security reviewer'))!.user;
    expect(scanned).toContain(copy.headline);
    expect(scanned).toContain('Input (required): Article text');
    expect(scanned).toContain(copy.examplePrompt);
  });

  it('a classifier fail returns the template to draft with the findings', async () => {
    const listingId = await makeListing();
    await call(templateHandler, 'PUT', listingId, AUTHOR, { ...copy, examplePrompt: 'EVIL instructions' });
    const res = await call(publishHandler, 'POST', listingId);
    expect(res.status).toBe(200);
    expect(template(res)).toMatchObject({ status: 'draft', scanStatus: 'failed' });
    expect(template(res).scanFindings).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: 'injection', source: 'classifier' })])
    );
    expect(template(res).firstPublishedAt).toBeUndefined();
  });

  it('public-text rules fail a link or markup in the copy before any model call', async () => {
    const listingId = await makeListing();
    await call(templateHandler, 'PUT', listingId, AUTHOR, {
      ...copy,
      inputs: [{ label: 'Paste from https://evil.example/x', required: true }],
    });
    const res = await call(publishHandler, 'POST', listingId);
    expect(template(res)).toMatchObject({ status: 'draft', scanStatus: 'failed' });
    expect(template(res).scanFindings).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: 'external_url', severity: 'critical' })])
    );
    expect(llm.calls).toEqual([]);
  });

  it('a scan that errors fails closed and can be published again', async () => {
    const listingId = await makeListing();
    await call(templateHandler, 'PUT', listingId, AUTHOR, { ...copy, headline: 'THROW now' });
    const errored = await call(publishHandler, 'POST', listingId);
    expect(template(errored)).toMatchObject({ status: 'draft', scanStatus: 'error' });

    await call(templateHandler, 'PUT', listingId, AUTHOR, { headline: copy.headline });
    expect(template(await call(publishHandler, 'POST', listingId)).status).toBe('published');
  });

  it('refuses to publish while the listing is not approved', async () => {
    const listingId = await makeListing();
    await call(templateHandler, 'PUT', listingId, AUTHOR, copy);
    await SkillListing.updateOne({ _id: listingId }, { $set: { status: 'withdrawn' } });
    expect((await call(publishHandler, 'POST', listingId)).status).toBe(409);
    expect((await stored(listingId))?.status).toBe('draft');
    expect(llm.calls).toEqual([]);
  });

  it('does not publish when the listing is withdrawn during the scan', async () => {
    const listingId = await makeListing();
    await call(templateHandler, 'PUT', listingId, AUTHOR, copy);
    llm.onComplete = async () => {
      await SkillListing.updateOne({ _id: listingId }, { $set: { status: 'withdrawn' } });
    };
    expect((await call(publishHandler, 'POST', listingId)).status).toBe(409);
    expect((await stored(listingId))?.status).toBe('draft');
  });

  it('refuses to publish without a headline, or twice', async () => {
    const listingId = await makeListing();
    await call(templateHandler, 'PUT', listingId, AUTHOR, { examplePrompt: 'x' });
    expect((await call(publishHandler, 'POST', listingId)).status).toBe(400);
    await call(templateHandler, 'PUT', listingId, AUTHOR, copy);
    await call(publishHandler, 'POST', listingId);
    expect((await call(publishHandler, 'POST', listingId)).status).toBe(409);
  });

  it('editing published copy re-runs the scan and keeps it published on a pass', async () => {
    const listingId = await makeListing();
    await publishedTemplate(listingId);
    llm.calls.length = 0;
    const res = await call(templateHandler, 'PUT', listingId, AUTHOR, { headline: 'Three bullets from any article' });
    expect(template(res)).toMatchObject({ status: 'published', headline: 'Three bullets from any article' });
    expect(llm.calls.filter(c => c.system.includes('security reviewer'))).toHaveLength(1);
  });

  it('editing published copy into something failing takes the page down with the findings', async () => {
    const listingId = await makeListing();
    await publishedTemplate(listingId);
    const res = await call(templateHandler, 'PUT', listingId, AUTHOR, { examplePrompt: 'EVIL now' });
    expect(template(res)).toMatchObject({ status: 'draft', scanStatus: 'failed', examplePrompt: 'EVIL now' });
  });

  it('a save that leaves the published copy unchanged does not re-scan', async () => {
    const listingId = await makeListing();
    await publishedTemplate(listingId);
    llm.calls.length = 0;
    const res = await call(templateHandler, 'PUT', listingId, AUTHOR, { headline: copy.headline });
    expect(template(res).status).toBe('published');
    expect(llm.calls).toEqual([]);
  });

  it('refuses edits while a scan is in flight', async () => {
    const listingId = await makeListing();
    await call(templateHandler, 'PUT', listingId, AUTHOR, copy);
    await SkillListingTemplate.updateOne(
      { listingId },
      { $set: { status: 'in_review', scanStatus: 'scanning', scanClaimedAt: new Date() } }
    );
    expect((await call(templateHandler, 'PUT', listingId, AUTHOR, { headline: 'x' })).status).toBe(409);
  });

  it('unpublish takes the page down; a second unpublish conflicts', async () => {
    const listingId = await makeListing();
    await publishedTemplate(listingId);
    expect(template(await call(publishHandler, 'DELETE', listingId)).status).toBe('draft');
    expect((await call(publishHandler, 'DELETE', listingId)).status).toBe(409);
  });

  it('refuses an edit that would blank the headline of a published template', async () => {
    const listingId = await makeListing();
    await publishedTemplate(listingId);
    llm.calls.length = 0;
    expect((await call(templateHandler, 'PUT', listingId, AUTHOR, { headline: '  ' })).status).toBe(400);
    expect(llm.calls).toEqual([]);
    expect(await stored(listingId)).toMatchObject({ status: 'published', headline: copy.headline });
  });

  it('refuses to publish or re-scan once the author has left the listing organization', async () => {
    const listingId = await makeListing();
    await SkillListing.updateOne({ _id: listingId }, { $set: { visibility: 'organization', organizationId: 'org-1' } });
    await call(templateHandler, 'PUT', listingId, AUTHOR, copy);
    expect((await call(publishHandler, 'POST', listingId)).status).toBe(403);
    await SkillListingTemplate.updateOne({ listingId }, { $set: { status: 'published' } });
    expect((await call(templateHandler, 'PUT', listingId, AUTHOR, { headline: 'Edited' })).status).toBe(403);
    expect(llm.calls).toEqual([]);
  });

  it('answers the lifecycle error cases: no template, in review, duplicate create', async () => {
    const listingId = await makeListing();
    expect((await call(publishHandler, 'POST', listingId)).status).toBe(404);
    expect((await call(publishHandler, 'DELETE', listingId)).status).toBe(404);
    await call(templateHandler, 'PUT', listingId, AUTHOR, copy);
    await SkillListingTemplate.updateOne(
      { listingId },
      { $set: { status: 'in_review', scanStatus: 'scanning', scanClaimedAt: new Date() } }
    );
    expect((await call(publishHandler, 'POST', listingId)).status).toBe(409);
  });

  it('a second template for the same listing cannot be created', async () => {
    const listingId = await makeListing();
    await call(templateHandler, 'PUT', listingId, AUTHOR, copy);
    await expect(SkillListingTemplate.create({ listingId, slug: 'another' })).rejects.toMatchObject({ code: 11000 });
  });
});

describe('example run scan', () => {
  const example = (extra: Record<string, unknown> = {}) => ({
    status: 'ready',
    enabled: true,
    prompt: 'Summarize this post about wind farms',
    reply: 'Here are three bullets about the post.',
    artifact: { type: 'markdown', title: 'Bullet summary', html: '<ul><li>Turbines are taller</li></ul>' },
    sampleFile: { name: 'wind-post.md', mime: 'text/markdown', source: 'generated' },
    steps: [{ label: 'Read the attached post', simulated: false }],
    runAt: new Date(),
    ...extra,
  });
  const seedExample = (listingId: string, extra: Record<string, unknown> = {}) =>
    SkillListingTemplate.updateOne({ listingId }, { $set: { example: example(extra) } });
  const scanned = () => llm.calls.filter(c => c.system.includes('security reviewer'));
  const scanDeps = { getClassifier: async () => classifier };

  it('publishing scans the trimmed reply, artifact text, steps and sample file with the copy', async () => {
    const listingId = await makeListing();
    await call(templateHandler, 'PUT', listingId, AUTHOR, copy);
    await seedExample(listingId, { reply: 'Here are three bullets. EVIL tail', replyTrimmedTo: 22 });
    const res = await call(publishHandler, 'POST', listingId);
    expect(template(res).status).toBe('published');
    const user = scanned()[0].user;
    expect(user).toContain('Example reply: Here are three bullets');
    expect(user).not.toContain('EVIL tail');
    expect(user).toContain('Example artifact: Turbines are taller');
    expect(user).not.toContain('<li>');
    expect(user).toContain('Example step: Read the attached post');
    expect(user).toContain('Example sample file: wind-post.md');
  });

  it('a link in the example reply keeps the template in draft with an example finding', async () => {
    const listingId = await makeListing();
    await call(templateHandler, 'PUT', listingId, AUTHOR, copy);
    await seedExample(listingId, { reply: 'See https://evil.example/x for more' });
    const res = await call(publishHandler, 'POST', listingId);
    expect(template(res)).toMatchObject({ status: 'draft', scanStatus: 'failed' });
    expect(template(res).scanFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'example_external_url', message: expect.stringContaining('Example reply') }),
      ])
    );
  });

  it('an example switched off is not scanned or shown', async () => {
    const listingId = await makeListing();
    await call(templateHandler, 'PUT', listingId, AUTHOR, copy);
    await seedExample(listingId, { enabled: false, reply: 'See https://evil.example/x' });
    expect(template(await call(publishHandler, 'POST', listingId)).status).toBe('published');
    expect(scanned()[0].user).not.toContain('Example reply');
  });

  it('switching a failing example on for a published page re-scans and takes the page down', async () => {
    const listingId = await makeListing();
    await publishedTemplate(listingId);
    await seedExample(listingId, { enabled: false, reply: 'EVIL reply' });
    llm.calls.length = 0;
    const res = await call(exampleHandler, 'PUT', listingId, AUTHOR, { enabled: true });
    expect(template(res)).toMatchObject({ status: 'draft', scanStatus: 'failed' });
    expect((await stored(listingId))?.example?.enabled).toBe(true);
  });

  it('a trim of a published example re-scans and stays published on a pass; switching off does not scan', async () => {
    const listingId = await makeListing();
    await publishedTemplate(listingId);
    await seedExample(listingId);
    llm.calls.length = 0;
    const trimmed = await call(exampleHandler, 'PUT', listingId, AUTHOR, { replyTrimmedTo: 10 });
    expect(template(trimmed)).toMatchObject({ status: 'published', example: { replyTrimmedTo: 10 } });
    expect(scanned()).toHaveLength(1);

    llm.calls.length = 0;
    const off = await call(exampleHandler, 'PUT', listingId, AUTHOR, { enabled: false });
    expect(template(off)).toMatchObject({ status: 'published', example: { enabled: false } });
    expect(llm.calls).toEqual([]);
  });

  it('a finished run on a published page lands with a scan claim; a draft or hidden example lands as is', async () => {
    const runAt = new Date('2026-11-25T12:00:00.000Z');
    const running = { 'example.status': 'running', 'example.runAt': runAt };
    const result = { $set: { 'example.status': 'ready', 'example.reply': 'EVIL new reply' } };

    const listingId = await makeListing();
    await publishedTemplate(listingId);
    await seedExample(listingId, { status: 'running', runAt });
    const landed = await writeTemplateExample(listingId, running, result, { 'example.enabled': true }, scanDeps);
    expect(landed).toMatchObject({ status: 'draft', scanStatus: 'failed', example: { reply: 'EVIL new reply' } });

    const hidden = await makeListing('hidden-one');
    await publishedTemplate(hidden);
    await seedExample(hidden, { status: 'running', runAt, enabled: false });
    llm.calls.length = 0;
    const quiet = await writeTemplateExample(hidden, running, result, { 'example.enabled': true }, scanDeps);
    expect(quiet).toMatchObject({ status: 'published', example: { status: 'ready', reply: 'EVIL new reply' } });
    expect(llm.calls).toEqual([]);

    expect(await writeTemplateExample(hidden, running, result, { 'example.enabled': true }, scanDeps)).toBeNull();
  });

  it('a run that finishes during a publish scan takes over the claim, so the old verdict cannot publish it', async () => {
    const runAt = new Date('2026-11-25T12:00:00.000Z');
    const listingId = await makeListing();
    await call(templateHandler, 'PUT', listingId, AUTHOR, copy);
    await seedExample(listingId, { status: 'running', runAt });
    let landed: unknown;
    llm.onComplete = async () => {
      llm.onComplete = null;
      // Keeps the takeover's claim time distinct from the publish claim at millisecond precision.
      await new Promise(resolve => setTimeout(resolve, 5));
      landed = await writeTemplateExample(
        listingId,
        { 'example.status': 'running', 'example.runAt': runAt },
        { $set: { 'example.status': 'ready', 'example.reply': 'EVIL late reply' } },
        { 'example.enabled': true },
        scanDeps
      );
    };
    await call(publishHandler, 'POST', listingId);
    expect(landed).toMatchObject({ status: 'draft', scanStatus: 'failed' });
    expect((await stored(listingId))?.status).toBe('draft');
  });
});
