import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Artifact, artifactRepository } from './ArtifactModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await Artifact.deleteMany({});
});

const OWNER = 'user-owner';
const OTHER = 'user-other';

const makeArtifact = (title: string, overrides: Record<string, unknown> = {}) =>
  Artifact.create({
    id: `artifact-${title}`,
    type: 'mermaid',
    title,
    userId: OWNER,
    permissions: { canRead: [], canWrite: [], canDelete: [] },
    contentId: new mongoose.Types.ObjectId(),
    contentHash: 'h',
    contentSize: 1,
    ...overrides,
  });

async function collectAllPages(limit: number) {
  const titles: string[] = [];
  let afterId: string | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const page = await artifactRepository.listOwnedAfterId(OWNER, { afterId, limit });
    titles.push(...page.data.map(a => a.title));
    if (!page.hasMore) return titles;
    afterId = String(page.data.at(-1)!._id);
  }
  throw new Error('paging did not terminate');
}

describe('ArtifactRepository.listOwnedAfterId', () => {
  it('lists only live artifacts the user owns, in _id order', async () => {
    await makeArtifact('a');
    await makeArtifact('deleted', { deletedAt: new Date(), status: 'deleted' });
    await makeArtifact('theirs', { userId: OTHER, permissions: { canRead: [OWNER], canWrite: [], canDelete: [] } });
    await makeArtifact('b');

    expect(await collectAllPages(10)).toEqual(['a', 'b']);
  });

  it('pages across the whole set without gaps or repeats', async () => {
    for (let i = 0; i < 5; i++) await makeArtifact(`f${i}`);

    expect(await collectAllPages(2)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4']);
  });

  it('reports hasMore false on a page that ends exactly at the last row', async () => {
    for (let i = 0; i < 4; i++) await makeArtifact(`f${i}`);

    const first = await artifactRepository.listOwnedAfterId(OWNER, { limit: 2 });
    expect(first.hasMore).toBe(true);
    const second = await artifactRepository.listOwnedAfterId(OWNER, { afterId: String(first.data[1]._id), limit: 2 });
    expect(second.data.map(a => a.title)).toEqual(['f2', 'f3']);
    expect(second.hasMore).toBe(false);
  });

  it('does not load content pointers or sharing state', async () => {
    await makeArtifact('a');

    const [row] = (await artifactRepository.listOwnedAfterId(OWNER, { limit: 1 })).data as Record<string, unknown>[];
    expect(row).not.toHaveProperty('permissions');
    expect(row).not.toHaveProperty('contentId');
    expect(row).not.toHaveProperty('contentHash');
  });

  it('throws on a non-ObjectId cursor', async () => {
    await expect(artifactRepository.listOwnedAfterId(OWNER, { afterId: 'nope', limit: 1 })).rejects.toThrow();
  });
});
