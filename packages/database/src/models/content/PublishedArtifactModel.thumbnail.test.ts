import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { PublishedArtifact, recordPublishedArtifactThumbnail } from './PublishedArtifactModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await PublishedArtifact.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await PublishedArtifact.deleteMany({});
});

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

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
    sha256Index: SHA_A,
    ...over,
  });
};

const thumb = (publicId: string, versionId: string) => ({
  key: `publish-thumbnails/${publicId}/${versionId}.webp`,
  versionId,
  renderedAt: new Date('2026-10-01T00:00:00.000Z'),
});

describe('PublishedArtifact thumbnail', () => {
  it('is absent until a render lands', async () => {
    const doc = await make();
    const lean = await PublishedArtifact.findOne({ publicId: doc.publicId }).lean();
    expect(lean?.thumbnail).toBeUndefined();
  });

  it('records a thumbnail for the current version and reports no replaced key the first time', async () => {
    const doc = await make();
    const result = await recordPublishedArtifactThumbnail(doc.publicId, thumb(doc.publicId, SHA_A));
    expect(result).toEqual({ replacedKey: null });

    const lean = await PublishedArtifact.findOne({ publicId: doc.publicId }).lean();
    expect(lean?.thumbnail).toEqual(thumb(doc.publicId, SHA_A));
  });

  it('returns the key it replaced when the version moved on and was re-rendered', async () => {
    const doc = await make();
    await recordPublishedArtifactThumbnail(doc.publicId, thumb(doc.publicId, SHA_A));
    await PublishedArtifact.updateOne({ publicId: doc.publicId }, { $set: { sha256Index: SHA_B } });

    const result = await recordPublishedArtifactThumbnail(doc.publicId, thumb(doc.publicId, SHA_B));
    expect(result).toEqual({ replacedKey: thumb(doc.publicId, SHA_A).key });
  });

  it('does not report the same key as replaced on a re-render of the same version', async () => {
    const doc = await make();
    await recordPublishedArtifactThumbnail(doc.publicId, thumb(doc.publicId, SHA_A));
    const result = await recordPublishedArtifactThumbnail(doc.publicId, thumb(doc.publicId, SHA_A));
    expect(result).toEqual({ replacedKey: null });
  });

  it('refuses a render for a superseded version and leaves the record untouched', async () => {
    const doc = await make({ sha256Index: SHA_B });
    const result = await recordPublishedArtifactThumbnail(doc.publicId, thumb(doc.publicId, SHA_A));
    expect(result).toBeNull();

    const lean = await PublishedArtifact.findOne({ publicId: doc.publicId }).lean();
    expect(lean?.thumbnail).toBeUndefined();
  });

  it('refuses a render for a soft-deleted artifact', async () => {
    const doc = await make({ deletedAt: new Date() });
    expect(await recordPublishedArtifactThumbnail(doc.publicId, thumb(doc.publicId, SHA_A))).toBeNull();
  });

  it('drops the thumbnail record on soft delete, so a restored artifact never points at deleted objects', async () => {
    const doc = await make();
    await recordPublishedArtifactThumbnail(doc.publicId, thumb(doc.publicId, SHA_A));
    const loaded = await PublishedArtifact.findOne({ publicId: doc.publicId });
    await loaded?.softDelete('owner1');

    const lean = await PublishedArtifact.findOne({ publicId: doc.publicId }).lean();
    expect(lean?.deletedAt).toBeInstanceOf(Date);
    expect(lean?.thumbnail).toBeUndefined();

    await loaded?.restore();
    const restored = await PublishedArtifact.findOne({ publicId: doc.publicId }).lean();
    expect(restored?.deletedAt).toBeNull();
    expect(restored?.thumbnail).toBeUndefined();
  });
});
