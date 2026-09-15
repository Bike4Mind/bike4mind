import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { BriefcasePrompt, briefcasePromptRepository } from './BriefcasePromptModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await BriefcasePrompt.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await BriefcasePrompt.deleteMany({}, { hardDelete: true } as Record<string, unknown>);
});

const systemPrompt = (over: Record<string, unknown> = {}) => ({
  type: 'general',
  name: 'Summarize',
  promptText: 'Summarize {{userName}}',
  userId: null,
  executionMode: 'inject' as const,
  schemaVersion: 1,
  ...over,
});

describe('BriefcasePromptModel repository — id surfacing on .lean() finders', () => {
  // Regression guard: the catalog finders use .lean(), which returns raw `_id`
  // and SKIPS the Mongoose `id` virtual. Without the withId() mapping, `prompt.id`
  // is undefined client-side and clicking a launcher fires
  // GET /api/briefcase/prompts/undefined. These assertions fail if the _id -> id
  // mapping is ever dropped.

  it('listSystemByType returns a string `id` matching `_id`', async () => {
    const created = await BriefcasePrompt.create(systemPrompt({ type: 'news' }));
    const [doc] = await briefcasePromptRepository.listSystemByType('news', null);
    expect(doc).toBeDefined();
    expect(typeof doc.id).toBe('string');
    expect(doc.id).toBe(String(created._id));
  });

  it('listSystemByTags returns a string `id`', async () => {
    await BriefcasePrompt.create(systemPrompt({ tags: ['starter'] }));
    const [doc] = await briefcasePromptRepository.listSystemByTags(['starter'], null);
    expect(typeof doc.id).toBe('string');
    expect(doc.id).toHaveLength(24);
  });

  it('listPersonal returns a string `id`', async () => {
    await BriefcasePrompt.create(systemPrompt({ userId: 'user-1', type: 'mine', name: 'My Prompt' }));
    const [doc] = await briefcasePromptRepository.listPersonal('user-1');
    expect(typeof doc.id).toBe('string');
  });

  it('findByIdForCaller returns a string `id`', async () => {
    const created = await BriefcasePrompt.create(systemPrompt());
    const found = await briefcasePromptRepository.findByIdForCaller(String(created._id), 'anyone');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(String(created._id));
  });

  // Catalog finders exclude promptText (rendering only needs metadata); the
  // by-id refetch includes it (it supplies the actual prompt at click time).
  it('catalog finders exclude promptText; findByIdForCaller includes it', async () => {
    await BriefcasePrompt.create(systemPrompt({ type: 'docs', promptText: 'SECRET BODY' }));
    const [listed] = await briefcasePromptRepository.listSystemByType('docs', null);
    expect(listed.promptText).toBeUndefined();

    const full = await briefcasePromptRepository.findByIdForCaller(listed.id, 'anyone');
    expect(full!.promptText).toBe('SECRET BODY');
  });
});

describe('BriefcasePromptModel repository — visibilityScopes pushed into the query', () => {
  // The entitlement filter runs IN the Mongo query so the per-sub-query cap
  // applies to the visible set (not dropping entitled prompts ranked past the cap).
  beforeEach(async () => {
    await BriefcasePrompt.create(systemPrompt({ type: 'v', name: 'Open', visibilityScopes: [] }));
    await BriefcasePrompt.create(systemPrompt({ type: 'v', name: 'VIP', visibilityScopes: ['vip'] }));
  });

  it('null visibility (admin bypass) returns scoped + unscoped', async () => {
    const names = (await briefcasePromptRepository.listSystemByType('v', null)).map(p => p.name).sort();
    expect(names).toEqual(['Open', 'VIP']);
  });

  it('empty scopes returns only unscoped prompts', async () => {
    const names = (await briefcasePromptRepository.listSystemByType('v', [])).map(p => p.name);
    expect(names).toEqual(['Open']);
  });

  it('matching scope returns the scoped prompt too (case-insensitive)', async () => {
    const names = (await briefcasePromptRepository.listSystemByType('v', ['VIP'])).map(p => p.name).sort();
    expect(names).toEqual(['Open', 'VIP']);
  });

  it('non-matching scope still returns unscoped only', async () => {
    const names = (await briefcasePromptRepository.listSystemByType('v', ['other'])).map(p => p.name);
    expect(names).toEqual(['Open']);
  });
});

describe('BriefcasePromptModel repository — owner scoping', () => {
  it('findByIdForCaller returns a system prompt to any caller, but never another user’s personal', async () => {
    const sys = await BriefcasePrompt.create(systemPrompt());
    const personalB = await BriefcasePrompt.create(systemPrompt({ userId: 'B', type: 'mine', name: 'B only' }));

    // system prompt: visible to anyone
    expect(await briefcasePromptRepository.findByIdForCaller(String(sys._id), 'A')).not.toBeNull();
    // B's personal: visible to B, NOT to A
    expect(await briefcasePromptRepository.findByIdForCaller(String(personalB._id), 'B')).not.toBeNull();
    expect(await briefcasePromptRepository.findByIdForCaller(String(personalB._id), 'A')).toBeNull();
  });

  it('updateOwned / softDeleteOwned only affect the caller’s own prompt', async () => {
    const pB = await BriefcasePrompt.create(systemPrompt({ userId: 'B', type: 'mine', name: 'B only' }));

    // A cannot update or delete B's prompt
    expect(await briefcasePromptRepository.updateOwned(String(pB._id), 'A', { name: 'hacked' })).toBeNull();
    expect(await briefcasePromptRepository.softDeleteOwned(String(pB._id), 'A')).toBe(false);

    // B can
    const updated = await briefcasePromptRepository.updateOwned(String(pB._id), 'B', { name: 'renamed' });
    expect(updated!.name).toBe('renamed');
    expect(updated!.id).toBe(String(pB._id)); // id surfaced on updateOwned too
    expect(await briefcasePromptRepository.softDeleteOwned(String(pB._id), 'B')).toBe(true);

    // after soft delete it's no longer returned
    expect(await briefcasePromptRepository.findByIdForCaller(String(pB._id), 'B')).toBeNull();
  });

  it('invalid ObjectId is handled without throwing', async () => {
    expect(await briefcasePromptRepository.findByIdForCaller('not-an-id', 'A')).toBeNull();
    expect(await briefcasePromptRepository.updateOwned('not-an-id', 'A', {})).toBeNull();
    expect(await briefcasePromptRepository.softDeleteOwned('not-an-id', 'A')).toBe(false);
  });
});
