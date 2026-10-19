import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { GENERATED_ASSET_TAG, KnowledgeType } from '@bike4mind/common';
import { createMongoServer } from '../__test__/createMongoServer';
import { FabFile, fabFileRepository } from '../models/content/FabFileModel';

/**
 * The Files "Generated" quick filter. Run against a real server because the hazard is silent: the selected-tags
 * filter is also a top-level `tags` predicate and matches ANY of its names, so a generated filter folded into it
 * (or spread over it) would widen the list instead of narrowing it, with no error anywhere.
 */

const OWNER = 'owner-1';

const list = async (filters: { tags?: string[]; generated?: boolean } = {}) => {
  const result = await fabFileRepository.search(
    OWNER,
    '',
    filters,
    { page: 1, limit: 50 },
    { by: 'fileName', direction: 'asc' },
    { excludeContent: true }
  );
  return result.data.map(file => file.fileName).sort();
};

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await FabFile.create(
    [
      { fileName: 'song', tags: [GENERATED_ASSET_TAG, 'music'] },
      { fileName: 'work-song', tags: [GENERATED_ASSET_TAG, 'music', 'work'] },
      { fileName: 'work-notes', tags: ['work'] },
      { fileName: 'notes', tags: [] },
      { fileName: 'cased', tags: ['Generated'] },
      { fileName: 'lookalike', tags: [`${GENERATED_ASSET_TAG}-x`] },
      { fileName: 'foreign-song', tags: [GENERATED_ASSET_TAG], userId: 'owner-2' },
    ].map(file => ({
      userId: file.userId ?? OWNER,
      fileName: file.fileName,
      type: KnowledgeType.FILE,
      tags: file.tags.map(name => ({ name, strength: 1 })),
    }))
  );
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 30000);

describe('fabFileRepository.search generated filter', () => {
  it('lists only generated files', async () => {
    await expect(list({ generated: true })).resolves.toEqual(['cased', 'song', 'work-song']);
  });

  it('narrows the selected tags instead of adding to them', async () => {
    await expect(list({ tags: ['work'], generated: true })).resolves.toEqual(['work-song']);
  });

  it('is a no-op when unset or false', async () => {
    const all = ['cased', 'lookalike', 'notes', 'song', 'work-notes', 'work-song'];
    await expect(list()).resolves.toEqual(all);
    await expect(list({ generated: false })).resolves.toEqual(all);
  });

  it('matches the tag case-insensitively', async () => {
    await expect(list({ generated: true })).resolves.toContain('cased');
  });

  it('does not match tags that merely start with the generated tag', async () => {
    await expect(list({ generated: true })).resolves.not.toContain('lookalike');
  });

  it('still scopes to the owner', async () => {
    await expect(list({ generated: true })).resolves.not.toContain('foreign-song');
  });
});
