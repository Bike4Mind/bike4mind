import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { ImageGenerationTemplate, imageGenerationTemplateRepository } from './ImageGenerationTemplateModel';

const seed = (userId: string, overrides: Record<string, unknown> = {}) =>
  imageGenerationTemplateRepository.create({
    userId,
    name: 'Cinematic',
    model: 'flux-pro-1.1',
    settings: { quality: 'hd' },
    usageCount: 0,
    deletedAt: null,
    ...overrides,
  } as any);

describe('ImageGenerationTemplateModel repository', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
    await ImageGenerationTemplate.ensureIndexes();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  afterEach(async () => {
    await ImageGenerationTemplate.deleteMany({});
  });

  it('findOwned returns only templates owned by the caller', async () => {
    const mine = await seed('u1');
    expect(await imageGenerationTemplateRepository.findOwned(mine.id, 'u1')).not.toBeNull();
    // Another user cannot read it by id.
    expect(await imageGenerationTemplateRepository.findOwned(mine.id, 'u2')).toBeNull();
  });

  it('updateOwned refuses to touch a template owned by someone else', async () => {
    const mine = await seed('u1', { name: 'Original' });
    const asOther = await imageGenerationTemplateRepository.updateOwned(mine.id, 'u2', { name: 'Hacked' });
    expect(asOther).toBeNull();
    const fresh = await imageGenerationTemplateRepository.findOwned(mine.id, 'u1');
    expect(fresh?.name).toBe('Original');
  });

  it('softDeleteOwned only deletes templates owned by the caller', async () => {
    const mine = await seed('u1');
    expect(await imageGenerationTemplateRepository.softDeleteOwned(mine.id, 'u2')).toBe(false);
    expect(await imageGenerationTemplateRepository.softDeleteOwned(mine.id, 'u1')).toBe(true);
    // Soft-deleted templates drop out of owner reads.
    expect(await imageGenerationTemplateRepository.findOwned(mine.id, 'u1')).toBeNull();
  });

  it('countOwned counts only non-deleted templates for that user', async () => {
    await seed('u1');
    const second = await seed('u1');
    await seed('u2');
    expect(await imageGenerationTemplateRepository.countOwned('u1')).toBe(2);
    await imageGenerationTemplateRepository.softDeleteOwned(second.id, 'u1');
    expect(await imageGenerationTemplateRepository.countOwned('u1')).toBe(1);
  });

  it('listOwned scopes to the user and sorts by usageCount desc', async () => {
    await seed('u1', { name: 'Low', usageCount: 1 });
    await seed('u1', { name: 'High', usageCount: 9 });
    await seed('u2', { name: 'Other', usageCount: 99 });
    const list = await imageGenerationTemplateRepository.listOwned('u1', 50);
    expect(list.map(t => t.name)).toEqual(['High', 'Low']);
  });

  it('incrementUsage bumps only a template owned by the caller', async () => {
    const mine = await seed('u1', { usageCount: 2 });
    expect(await imageGenerationTemplateRepository.incrementUsage(mine.id, 'u2')).toBeNull();
    const bumped = await imageGenerationTemplateRepository.incrementUsage(mine.id, 'u1');
    expect(bumped?.usageCount).toBe(3);
  });
});
