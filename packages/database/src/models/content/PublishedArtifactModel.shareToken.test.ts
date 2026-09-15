import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { PublishedArtifact, publishedArtifactRepository } from './PublishedArtifactModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // Build indexes (incl. the partial-unique shareToken index) before asserting on them.
  await PublishedArtifact.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

let seq = 0;
const make = (over: Record<string, unknown> = {}) => {
  seq += 1;
  return PublishedArtifact.create({
    publicId: `pub-${seq}`,
    tier: 'user',
    scopeId: 'scope1',
    slug: `slug-${seq}`,
    title: 'T',
    ownerId: 'owner1',
    source: { kind: 'bundle' },
    ...over,
  });
};

describe('PublishedArtifact shareToken', () => {
  it('allows many rows with NO shareToken (partial index does not force uniqueness on absent tokens)', async () => {
    await make();
    await make();
    const untokened = await PublishedArtifact.countDocuments({ shareToken: { $exists: false } });
    expect(untokened).toBeGreaterThanOrEqual(2);
  });

  it('rejects two rows sharing the same shareToken', async () => {
    await make({ shareToken: 'DUPLICATE' });
    await expect(make({ shareToken: 'DUPLICATE' })).rejects.toThrow();
  });

  it('findByShareToken resolves a live row and skips a soft-deleted one', async () => {
    const doc = await make({ shareToken: 'LIVE-TOKEN' });
    const found = await publishedArtifactRepository.findByShareToken('LIVE-TOKEN');
    expect(found?.publicId).toBe(doc.publicId);

    await PublishedArtifact.updateOne({ _id: doc._id }, { $set: { deletedAt: new Date() } });
    expect(await publishedArtifactRepository.findByShareToken('LIVE-TOKEN')).toBeFalsy();
  });

  it('toJSON never serializes the capability token', async () => {
    const doc = await make({ shareToken: 'SECRET-TOKEN' });
    const json = doc.toJSON() as Record<string, unknown>;
    expect(json.publicId).toBe(doc.publicId); // real fields survive
    expect(json.shareToken).toBeUndefined();
    expect(json.shareTokenUpdatedAt).toBeUndefined();
  });

  it('a projected lean read (the management GET) omits the token', async () => {
    const doc = await make({ shareToken: 'PROJECTED-OUT' });
    const lean = await PublishedArtifact.findOne({ _id: doc._id })
      .select('-shareToken -shareTokenUpdatedAt')
      .lean<Record<string, unknown>>();
    expect(lean?.publicId).toBe(doc.publicId);
    expect(lean?.shareToken).toBeUndefined();
  });
});
