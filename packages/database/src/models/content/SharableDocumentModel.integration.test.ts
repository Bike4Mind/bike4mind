import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { FabFile, fabFileRepository } from './FabFileModel';

/**
 * Integration coverage (real Mongo via createMongoServer) for the shareable access
 * statics and the targeted sharing-flag write. Exercises the actual `fabFileRepository`
 * singleton and FabFile schema rather than mocked adapters, so it pins:
 *   - findAccessibleById / findShareAccessById / findUpdateAccessById gating across
 *     owner / users-share / group-share / no-access / wrong-permission (the group-share
 *     arm was previously missing from findShareAccessById);
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

// A grant row's provenance tags are what both revoke cascades filter on, and mongoose runs strict:
// an undeclared subpath is dropped on write with no error, which would turn every scoped revoke
// into a silent no-op against a direct share. Pinned here rather than trusted, the same way
// SessionModel.retrievalExclusion and OrganizationModel pin their own subpaths.
describe('UserShareableSchema provenance tags survive a round trip', () => {
  it('persists projectId and sessionId, and keeps the two rows distinct', async () => {
    const doc = await seed({
      users: [
        { userId: 'u1', permissions: ['read'] },
        { userId: 'u1', permissions: ['read'], projectId: 'project-a' },
        { userId: 'u1', permissions: ['read'], sessionId: 'session-a' },
      ],
    });

    const reread = await FabFile.findById(doc.id).lean();
    const rows = (reread!.users ?? []) as Array<{ projectId?: string; sessionId?: string }>;

    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.projectId)).toEqual([undefined, 'project-a', undefined]);
    expect(rows.map(r => r.sessionId)).toEqual([undefined, undefined, 'session-a']);
  });

  it('keeps a direct share when only the session-tagged row is filtered out', async () => {
    const doc = await seed({
      users: [
        { userId: 'u1', permissions: ['read'] },
        { userId: 'u1', permissions: ['read'], sessionId: 'session-a' },
      ],
    });

    const loaded = await FabFile.findById(doc.id);
    loaded!.users = loaded!.users.filter(user => user.sessionId !== 'session-a');
    await loaded!.save();

    const reread = await FabFile.findById(doc.id).lean();
    expect(reread!.users).toHaveLength(1);
    expect((reread!.users[0] as { sessionId?: string }).sessionId).toBeUndefined();
  });
});

describe('ShareableDocumentRepository.findAccessibleById', () => {
  it('grants the owner', async () => {
    const doc = await seed();
    const got = await fabFileRepository.shareable.findAccessibleById({ id: 'owner-1', groups: [] }, doc.id);
    expect(got?.id).toBe(doc.id);
  });

  it('grants a user with a read share', async () => {
    const doc = await seed({ users: [{ userId: 'reader-1', permissions: ['read'] }] });
    const got = await fabFileRepository.shareable.findAccessibleById({ id: 'reader-1', groups: [] }, doc.id);
    expect(got?.id).toBe(doc.id);
  });

  it('grants a member of a group with a read share', async () => {
    const doc = await seed({ groups: [{ groupId: 'grp-1', permissions: ['read'] }] });
    const got = await fabFileRepository.shareable.findAccessibleById({ id: 'someone', groups: ['grp-1'] }, doc.id);
    expect(got?.id).toBe(doc.id);
  });

  it('grants a user whose share carries only the legacy write permission', async () => {
    // Raw insert: 'write' is not in the Permission enum, so a validating create() rejects it. The
    // predicate still honours it for legacy/out-of-band rows (same pattern as
    // OrganizationModel.membershipOrgIds.test.ts).
    const result = await FabFile.collection.insertOne({
      userId: 'owner-1',
      fileName: 'a.png',
      mimeType: 'image/png',
      type: KnowledgeType.FILE,
      filePath: 'a.png',
      users: [{ userId: 'writer-1', permissions: ['write'] }],
      groups: [],
    });
    const id = String(result.insertedId);
    const got = await fabFileRepository.shareable.findAccessibleById({ id: 'writer-1', groups: [] }, id);
    expect(got?.id).toBe(id);
  });

  it('denies a user and a group member whose shares carry no permissions', async () => {
    const doc = await seed({
      users: [{ userId: 'reader-1', permissions: [] }],
      groups: [{ groupId: 'grp-1', permissions: [] }],
    });
    const got = await fabFileRepository.shareable.findAccessibleById({ id: 'reader-1', groups: ['grp-1'] }, doc.id);
    expect(got).toBeNull();
  });

  it('denies a caller with no owner/user/group grant', async () => {
    const doc = await seed({
      users: [{ userId: 'reader-1', permissions: ['read'] }],
      groups: [{ groupId: 'grp-1', permissions: ['read'] }],
    });
    const got = await fabFileRepository.shareable.findAccessibleById({ id: 'stranger', groups: ['other-grp'] }, doc.id);
    expect(got).toBeNull();
  });

  it('returns null rather than throwing for an id that cannot address a row', async () => {
    await seed();
    await expect(
      fabFileRepository.shareable.findAccessibleById({ id: 'owner-1', groups: [] }, 'not-an-object-id')
    ).resolves.toBeNull();
  });
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

describe('ShareableDocumentRepository.findAllUpdateAccessByIds', () => {
  it('returns the owner document and omits one the caller only holds read on', async () => {
    const owned = await seed();
    const readOnly = await seed({ userId: 'owner-2', users: [{ userId: 'owner-1', permissions: ['read'] }] });

    const got = await fabFileRepository.shareable.findAllUpdateAccessByIds({ id: 'owner-1', groups: [] }, [
      owned.id,
      readOnly.id,
    ]);

    expect(got.map(doc => doc.id)).toEqual([owned.id]);
  });

  it('includes a document whose user grant carries update, and one via a group update grant', async () => {
    const viaUser = await seed({ userId: 'owner-2', users: [{ userId: 'editor-1', permissions: ['update'] }] });
    const viaGroup = await seed({ userId: 'owner-2', groups: [{ groupId: 'grp-1', permissions: ['update'] }] });

    const got = await fabFileRepository.shareable.findAllUpdateAccessByIds({ id: 'editor-1', groups: ['grp-1'] }, [
      viaUser.id,
      viaGroup.id,
    ]);

    expect(got.map(doc => doc.id).sort()).toEqual([viaUser.id, viaGroup.id].sort());
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
