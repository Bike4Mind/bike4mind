import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { ArtifactVersion, artifactVersionRepository } from './ArtifactVersionModel';

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
  await ArtifactVersion.deleteMany({});
});

const makeVersion = (artifactId: string, version: number) =>
  ArtifactVersion.create({ artifactId, version, contentId: new mongoose.Types.ObjectId(), createdBy: 'u1' });

async function collectAllPages(artifactId: string, limit: number) {
  const versions: number[] = [];
  let afterVersion: number | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const page = await artifactVersionRepository.listByArtifactAfterVersion(artifactId, { afterVersion, limit });
    versions.push(...page.data.map(v => v.version));
    if (!page.hasMore) return versions;
    afterVersion = page.data.at(-1)!.version;
  }
  throw new Error('paging did not terminate');
}

describe('ArtifactVersionRepository.listByArtifactAfterVersion', () => {
  it("pages one artifact's versions in version order, whatever the insert order", async () => {
    for (const v of [3, 1, 5, 2, 4]) await makeVersion('a1', v);
    await makeVersion('a2', 1);

    expect(await collectAllPages('a1', 2)).toEqual([1, 2, 3, 4, 5]);
    expect(await collectAllPages('a2', 2)).toEqual([1]);
  });

  it('reports hasMore false on a page that ends exactly at the last version', async () => {
    for (const v of [1, 2, 3, 4]) await makeVersion('a1', v);

    const second = await artifactVersionRepository.listByArtifactAfterVersion('a1', { afterVersion: 2, limit: 2 });
    expect(second.data.map(v => v.version)).toEqual([3, 4]);
    expect(second.hasMore).toBe(false);
  });

  it('returns an empty page for an unknown artifact', async () => {
    expect(await artifactVersionRepository.listByArtifactAfterVersion('missing', { limit: 5 })).toEqual({
      data: [],
      hasMore: false,
    });
  });
});
