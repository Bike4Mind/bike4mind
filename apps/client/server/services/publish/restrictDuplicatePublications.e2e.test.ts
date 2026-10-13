import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { PublishedArtifact } from '@bike4mind/database';
import { resolveVisibility } from './resolveVisibility';

const { invalidateMock } = vi.hoisted(() => ({ invalidateMock: vi.fn() }));
vi.mock('./invalidatePublishCdn', async importOriginal => ({
  ...(await importOriginal<typeof import('./invalidatePublishCdn')>()),
  invalidatePublishCdn: invalidateMock,
}));

import { restrictDuplicatePublications } from './restrictDuplicatePublications';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// Against a real database: a Private pick on the record the dialog shows reaches every other copy
// of the same reply the OWNER has, leaves everyone else's copies alone, lands each copy in a
// visibility its tier allows, and is a no-op when repeated.

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

afterEach(async () => {
  invalidateMock.mockReset();
  await mongoose.connection.dropDatabase();
});

let seq = 0;
const publishReply = (
  ownerId: string,
  messageId: string,
  over: { tier?: 'user' | 'organization'; scopeId?: string; visibility?: string } = {}
) => {
  seq += 1;
  return PublishedArtifact.create({
    publicId: `pub-${seq}`,
    tier: over.tier ?? 'user',
    scopeId: over.scopeId ?? ownerId,
    slug: `r-pub-${seq}`,
    title: 'Answer',
    ownerId,
    visibility: over.visibility ?? 'public',
    discoverable: true,
    source: { kind: 'reply', sessionId: 's1', messageId },
    renderedBody: 'body',
    storageKeyPrefix: '',
    manifest: [],
  });
};

const visibilityOf = async (publicId: string) =>
  (await PublishedArtifact.findOne({ publicId }).lean<{ visibility: string; discoverable?: boolean }>())!;

describe('restrictDuplicatePublications (real database)', () => {
  it("narrows only the owner's other copies of the same reply, to a visibility each tier allows", async () => {
    const keep = await publishReply('owner', 'm1', { visibility: 'private' });
    const oldTeam = await publishReply('owner', 'm1', { tier: 'organization', scopeId: 'org1' });
    const oldPersonal = await publishReply('owner', 'm1');
    const otherReply = await publishReply('owner', 'm2');
    const otherOwner = await publishReply('someone-else', 'm1');

    expect(await restrictDuplicatePublications(keep)).toBe(2);

    for (const row of [oldTeam, oldPersonal]) {
      const now = await visibilityOf(row.publicId);
      expect(now).toMatchObject({ visibility: 'private', discoverable: false });
      expect(resolveVisibility(row.tier, 'private').ok).toBe(true);
    }
    expect((await visibilityOf(otherReply.publicId)).visibility).toBe('public');
    expect((await visibilityOf(otherOwner.publicId)).visibility).toBe('public');
    expect(invalidateMock.mock.calls.map(([t]) => (t as { publicId: string }).publicId).sort()).toEqual(
      [oldTeam.publicId, oldPersonal.publicId].sort()
    );
  });

  it('is a no-op the second time', async () => {
    const keep = await publishReply('owner', 'm1', { visibility: 'private' });
    await publishReply('owner', 'm1');

    expect(await restrictDuplicatePublications(keep)).toBe(1);
    invalidateMock.mockReset();
    expect(await restrictDuplicatePublications(keep)).toBe(0);
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it('leaves removed copies alone', async () => {
    const keep = await publishReply('owner', 'm1', { visibility: 'private' });
    const removed = await publishReply('owner', 'm1');
    await PublishedArtifact.updateOne({ _id: removed._id }, { $set: { deletedAt: new Date() } });

    expect(await restrictDuplicatePublications(keep)).toBe(0);
    expect((await visibilityOf(removed.publicId)).visibility).toBe('public');
  });
});
