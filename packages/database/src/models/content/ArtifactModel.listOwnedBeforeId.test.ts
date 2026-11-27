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
  let beforeId: string | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const page = await artifactRepository.listOwnedBeforeId(OWNER, { beforeId, limit });
    titles.push(...page.data.map(a => a.title));
    if (!page.hasMore) return titles;
    beforeId = String(page.data.at(-1)!._id);
  }
  throw new Error('paging did not terminate');
}

describe('ArtifactRepository.listOwnedBeforeId', () => {
  it('lists only live artifacts the user owns, newest first', async () => {
    await makeArtifact('a');
    await makeArtifact('deleted', { deletedAt: new Date(), status: 'deleted' });
    await makeArtifact('theirs', { userId: OTHER, permissions: { canRead: [OWNER], canWrite: [], canDelete: [] } });
    await makeArtifact('b');

    expect(await collectAllPages(10)).toEqual(['b', 'a']);
  });

  it('pages across the whole set without gaps or repeats', async () => {
    for (let i = 0; i < 5; i++) await makeArtifact(`f${i}`);

    expect(await collectAllPages(2)).toEqual(['f4', 'f3', 'f2', 'f1', 'f0']);
  });

  it('reports hasMore false on a page that ends exactly at the last row', async () => {
    for (let i = 0; i < 4; i++) await makeArtifact(`f${i}`);

    const first = await artifactRepository.listOwnedBeforeId(OWNER, { limit: 2 });
    expect(first.hasMore).toBe(true);
    const second = await artifactRepository.listOwnedBeforeId(OWNER, { beforeId: String(first.data[1]._id), limit: 2 });
    expect(second.data.map(a => a.title)).toEqual(['f1', 'f0']);
    expect(second.hasMore).toBe(false);
  });

  it('does not load content pointers or sharing state', async () => {
    await makeArtifact('a');

    const [row] = (await artifactRepository.listOwnedBeforeId(OWNER, { limit: 1 })).data as Record<string, unknown>[];
    expect(row).not.toHaveProperty('permissions');
    expect(row).not.toHaveProperty('contentId');
    expect(row).not.toHaveProperty('contentHash');
  });

  it('throws on a non-ObjectId cursor', async () => {
    await expect(artifactRepository.listOwnedBeforeId(OWNER, { beforeId: 'nope', limit: 1 })).rejects.toThrow();
  });
});

describe('ArtifactRepository.searchOwnedBeforeId', () => {
  beforeAll(async () => {
    await Artifact.init();
  });

  async function collectSearchPages(term: string, limit: number, type?: string) {
    const titles: string[] = [];
    let beforeId: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = await artifactRepository.searchOwnedBeforeId(OWNER, term, { type, beforeId, limit });
      titles.push(...page.data.map(a => a.title));
      if (!page.hasMore) return titles;
      beforeId = String(page.data.at(-1)!._id);
    }
    throw new Error('paging did not terminate');
  }

  it('matches only live artifacts the user owns, newest first', async () => {
    await makeArtifact('signup a');
    await makeArtifact('signup deleted', { deletedAt: new Date(), status: 'deleted' });
    await makeArtifact('signup theirs', { userId: OTHER });
    await makeArtifact('unrelated');
    await makeArtifact('signup b');

    expect(await collectSearchPages('signup', 10)).toEqual(['signup b', 'signup a']);
  });

  it('pages across the matches without gaps or repeats', async () => {
    for (let i = 0; i < 5; i++) await makeArtifact(`signup ${i}`);

    expect(await collectSearchPages('signup', 2)).toEqual(['signup 4', 'signup 3', 'signup 2', 'signup 1', 'signup 0']);
  });

  it('narrows by type', async () => {
    await makeArtifact('signup flow', { type: 'mermaid' });
    await makeArtifact('signup page', { type: 'html' });

    expect(await collectSearchPages('signup', 10, 'html')).toEqual(['signup page']);
  });

  it('throws on a non-ObjectId cursor', async () => {
    await expect(
      artifactRepository.searchOwnedBeforeId(OWNER, 'signup', { beforeId: 'nope', limit: 1 })
    ).rejects.toThrow();
  });
});
