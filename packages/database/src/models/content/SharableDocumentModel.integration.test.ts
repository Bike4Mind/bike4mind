import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { FabFile, fabFileRepository } from './FabFileModel';

/**
 * Integration coverage (real Mongo via createMongoServer) for the shareable access
 * statics and the targeted sharing-flag write. Exercises the actual `fabFileRepository`
 * singleton and FabFile schema rather than mocked adapters, so it pins:
 *   - findShareAccessById / findUpdateAccessById gating across owner / users-share /
 *     group-share / no-access / wrong-permission (the group-share arm was previously
 *     missing from findShareAccessById);
 *   - that a sharing-flag write does NOT clobber moderation/URL state (the blocker: a
 *     whole-document $set could revert a moderation block).
 */

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
}, 30000);
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 30000);
afterEach(async () => {
  await FabFile.deleteMany({});
});

const seed = (overrides: Record<string, unknown> = {}) =>
  FabFile.create({
    userId: 'owner-1',
    fileName: 'a.png',
    mimeType: 'image/png',
    type: KnowledgeType.FILE,
    filePath: 'a.png',
    moderationStatus: 'clean',
    ...overrides,
  });

describe('ShareableDocumentRepository.findShareAccessById', () => {
  it('grants the owner', async () => {
    const doc = await seed();
    const got = await fabFileRepository.shareable.findShareAccessById({ id: 'owner-1', groups: [] }, doc.id);
    expect(got?.id).toBe(doc.id);
  });

  it('grants a user with an explicit share grant', async () => {
    const doc = await seed({ users: [{ userId: 'sharer-1', permissions: ['share'] }] });
    const got = await fabFileRepository.shareable.findShareAccessById({ id: 'sharer-1', groups: [] }, doc.id);
    expect(got?.id).toBe(doc.id);
  });

  it('grants a member of a group with a share grant (the restored group arm)', async () => {
    const doc = await seed({ groups: [{ groupId: 'grp-1', permissions: ['share'] }] });
    const got = await fabFileRepository.shareable.findShareAccessById({ id: 'someone', groups: ['grp-1'] }, doc.id);
    expect(got?.id).toBe(doc.id);
  });

  it('denies a group member whose group grant lacks share (read only)', async () => {
    const doc = await seed({ groups: [{ groupId: 'grp-1', permissions: ['read'] }] });
    const got = await fabFileRepository.shareable.findShareAccessById({ id: 'someone', groups: ['grp-1'] }, doc.id);
    expect(got).toBeNull();
  });

  it('denies a caller with no owner/user/group grant', async () => {
    const doc = await seed({ users: [{ userId: 'sharer-1', permissions: ['share'] }] });
    const got = await fabFileRepository.shareable.findShareAccessById(
      { id: 'stranger', groups: ['other-grp'] },
      doc.id
    );
    expect(got).toBeNull();
  });
});

describe('ShareableDocumentRepository.findUpdateAccessById', () => {
  it('grants a group member with an update grant', async () => {
    const doc = await seed({ groups: [{ groupId: 'grp-1', permissions: ['update'] }] });
    const got = await fabFileRepository.shareable.findUpdateAccessById({ id: 'someone', groups: ['grp-1'] }, doc.id);
    expect(got?.id).toBe(doc.id);
  });

  it('denies a caller whose grant is share-only (no update)', async () => {
    const doc = await seed({ users: [{ userId: 'sharer-1', permissions: ['share'] }] });
    const got = await fabFileRepository.shareable.findUpdateAccessById({ id: 'sharer-1', groups: [] }, doc.id);
    expect(got).toBeNull();
  });
});

describe('targeted sharing-flag write preserves moderation/URL state', () => {
  it('update({ id, isGlobalRead, isGlobalWrite }) leaves moderationStatus/blockReason/fileUrl untouched', async () => {
    const doc = await seed({
      moderationStatus: 'blocked',
      blockReason: 'explicit-content',
      fileUrl: 'https://signed-url',
      fileUrlExpireAt: new Date('2030-01-01'),
      isGlobalRead: false,
      isGlobalWrite: false,
    });

    // The sharing write updateDocumentSharing performs: only the two flags.
    await fabFileRepository.update({ id: doc.id, isGlobalRead: true, isGlobalWrite: true } as never);

    const reloaded = await FabFile.findById(doc.id);
    expect(reloaded?.isGlobalRead).toBe(true);
    expect(reloaded?.isGlobalWrite).toBe(true);
    // Moderation block survives the sharing write - not reverted / un-quarantined.
    expect(reloaded?.moderationStatus).toBe('blocked');
    expect(reloaded?.blockReason).toBe('explicit-content');
    expect(reloaded?.fileUrl).toBe('https://signed-url');
  });
});
