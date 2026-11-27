import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { PublishedArtifact, publishedArtifactRepository } from './PublishedArtifactModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

let seq = 0;
const makeArtifact = (over: Record<string, unknown>) => {
  seq += 1;
  return PublishedArtifact.create({
    publicId: `pub-${seq}`,
    slug: `slug-${seq}`,
    title: 'T',
    visibility: 'organization',
    source: { kind: 'bundle' },
    ...over,
  });
};

describe('publishedArtifactRepository.transferOrgTierOwnership', () => {
  it("moves only the member's pages in that organization's namespace, deleted ones included", async () => {
    const live = await makeArtifact({ tier: 'organization', scopeId: 'org1', ownerId: 'leaver' });
    const deleted = await makeArtifact({
      tier: 'organization',
      scopeId: 'org1',
      ownerId: 'leaver',
      deletedAt: new Date(),
    });
    const otherOrg = await makeArtifact({ tier: 'organization', scopeId: 'org2', ownerId: 'leaver' });
    const personal = await makeArtifact({ tier: 'user', scopeId: 'leaver', ownerId: 'leaver', visibility: 'public' });
    const colleague = await makeArtifact({ tier: 'organization', scopeId: 'org1', ownerId: 'stayer' });

    const moved = await publishedArtifactRepository.transferOrgTierOwnership('org1', 'leaver', 'owner');

    expect(moved).toBe(2);
    const ownerOf = async (id: unknown) => (await PublishedArtifact.findById(id).lean())!.ownerId;
    expect(await ownerOf(live._id)).toBe('owner');
    expect(await ownerOf(deleted._id)).toBe('owner');
    expect(await ownerOf(otherOrg._id)).toBe('leaver');
    expect(await ownerOf(personal._id)).toBe('leaver');
    expect(await ownerOf(colleague._id)).toBe('stayer');
  });
});
