import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { ConcurrencyConflictError, IUserShare, KnowledgeType, Permission } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { FabFile, fabFileRepository } from './FabFileModel';

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

const seed = async (users: Partial<IUserShare>[] = []) => {
  const doc = await FabFile.create({
    userId: 'owner-1',
    fileName: 'a.png',
    mimeType: 'image/png',
    type: KnowledgeType.FILE,
    filePath: 'a.png',
    users,
  });
  return doc.id as string;
};

const rowsOf = async (id: string) => {
  const doc = await FabFile.findById(id).setOptions({ includeDeleted: true }).lean();
  return (doc!.users ?? []).map(({ userId, permissions, projectId, sessionId, extraData }) => ({
    userId: String(userId),
    permissions,
    ...(projectId ? { projectId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(extraData ? { extraData } : {}),
  }));
};

const { read, update, share } = Permission;

describe('shareable.updateUserShares', () => {
  it('appends a new row for a user with no matching row', async () => {
    const id = await seed([{ userId: 'u1', permissions: [read] }]);

    await fabFileRepository.shareable.updateUserShares(id, {
      add: [{ userId: 'u2', permissions: [read, update] }],
    });

    expect(await rowsOf(id)).toEqual([
      { userId: 'u1', permissions: [read] },
      { userId: 'u2', permissions: [read, update] },
    ]);
  });

  it('unions permissions into an existing row and keeps its extra fields', async () => {
    const id = await seed([{ userId: 'u1', permissions: [read], extraData: { lastExportDate: new Date(0) } }]);

    await fabFileRepository.shareable.updateUserShares(id, {
      add: [{ userId: 'u1', permissions: [update, read, update] }],
    });

    expect(await rowsOf(id)).toEqual([
      { userId: 'u1', permissions: [read, update], extraData: { lastExportDate: new Date(0) } },
    ]);
  });

  it('keys rows on userId, projectId and sessionId together', async () => {
    const id = await seed([
      { userId: 'u1', permissions: [read] },
      { userId: 'u1', permissions: [read], projectId: 'p1' },
    ]);

    await fabFileRepository.shareable.updateUserShares(id, {
      add: [
        { userId: 'u1', permissions: [update], projectId: 'p1' },
        { userId: 'u1', permissions: [read], projectId: 'p2' },
        { userId: 'u1', permissions: [read], sessionId: 's1' },
      ],
    });

    expect(await rowsOf(id)).toEqual([
      { userId: 'u1', permissions: [read] },
      { userId: 'u1', permissions: [read, update], projectId: 'p1' },
      { userId: 'u1', permissions: [read], projectId: 'p2' },
      { userId: 'u1', permissions: [read], sessionId: 's1' },
    ]);
  });

  it('matches a row whose userId was stored as an ObjectId', async () => {
    const userId = new mongoose.Types.ObjectId();
    const id = await seed();
    await FabFile.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { users: [{ userId, permissions: [read] }] } }
    );

    await fabFileRepository.shareable.updateUserShares(id, {
      add: [{ userId: userId.toString(), permissions: [update] }],
    });
    expect(await rowsOf(id)).toEqual([{ userId: userId.toString(), permissions: [read, update] }]);

    await fabFileRepository.shareable.updateUserShares(id, { remove: { userId: userId.toString() } });
    expect(await rowsOf(id)).toEqual([]);
  });

  it('removes only rows matching every given field', async () => {
    const id = await seed([
      { userId: 'u1', permissions: [read] },
      { userId: 'u1', permissions: [read], projectId: 'p1' },
      { userId: 'u2', permissions: [read], projectId: 'p1' },
      { userId: 'u2', permissions: [read], projectId: 'p2' },
    ]);

    await fabFileRepository.shareable.updateUserShares(id, { remove: { userId: 'u2', projectId: 'p1' } });
    expect(await rowsOf(id)).toEqual([
      { userId: 'u1', permissions: [read] },
      { userId: 'u1', permissions: [read], projectId: 'p1' },
      { userId: 'u2', permissions: [read], projectId: 'p2' },
    ]);

    await fabFileRepository.shareable.updateUserShares(id, { remove: { projectId: 'p1' } });
    expect(await rowsOf(id)).toEqual([
      { userId: 'u1', permissions: [read] },
      { userId: 'u2', permissions: [read], projectId: 'p2' },
    ]);
  });

  it('removes before adding, in one write', async () => {
    const id = await seed([
      { userId: 'u1', permissions: [read, update], projectId: 'p1' },
      { userId: 'u2', permissions: [read], projectId: 'p1' },
    ]);

    const result = await fabFileRepository.shareable.updateUserShares(id, {
      remove: { projectId: 'p1' },
      add: [{ userId: 'u1', permissions: [read] }],
    });

    expect(result?.users.map(u => u.userId)).toEqual(['u1']);
    expect(await rowsOf(id)).toEqual([{ userId: 'u1', permissions: [read] }]);
  });

  it('refuses a remove with no fields to match on', async () => {
    const id = await seed([{ userId: 'u1', permissions: [read] }]);
    await expect(fabFileRepository.shareable.updateUserShares(id, { remove: {} })).rejects.toThrow();
    expect(await rowsOf(id)).toHaveLength(1);
  });

  it('skips a soft-deleted document and an unusable id', async () => {
    const id = await seed([{ userId: 'u1', permissions: [read] }]);
    await FabFile.updateOne({ _id: id }, { $set: { deletedAt: new Date() } });

    expect(
      await fabFileRepository.shareable.updateUserShares(id, { add: [{ userId: 'u2', permissions: [read] }] })
    ).toBeNull();
    expect(await rowsOf(id)).toEqual([{ userId: 'u1', permissions: [read] }]);
    expect(await fabFileRepository.shareable.updateUserShares('not-an-id', { remove: { userId: 'u1' } })).toBeNull();
  });

  it('bumps the version key and updatedAt', async () => {
    const id = await seed();
    const before = await FabFile.findById(id).lean();

    await fabFileRepository.shareable.updateUserShares(id, { add: [{ userId: 'u1', permissions: [read] }] });

    const after = await FabFile.findById(id).lean();
    expect(after!.__v).toBe((before!.__v ?? 0) + 1);
    expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(before!.updatedAt.getTime());
  });

  it('keeps every grant when many land at once', async () => {
    const id = await seed();
    const userIds = Array.from({ length: 10 }, (_, i) => `u${i}`);

    await Promise.all(
      userIds.map(userId =>
        fabFileRepository.shareable.updateUserShares(id, { add: [{ userId, permissions: [read] }] })
      )
    );

    expect((await rowsOf(id)).map(row => row.userId).sort()).toEqual([...userIds].sort());
  });
});

describe('concurrent share and revoke', () => {
  // Mirrors sharingService/revoke.ts: read, filter users in memory, then a version-guarded write.
  const readForRevoke = async (id: string) => (await fabFileRepository.findById(id))!;
  const writeRevoke = (doc: Awaited<ReturnType<typeof readForRevoke>>, userId: string) =>
    fabFileRepository.updateGuarded(
      { id: doc.id, users: doc.users.filter(u => u.userId !== userId), __v: doc.__v } as never,
      { includeDeleted: true }
    );

  it('keeps both changes when the revoke commits before a share read earlier lands', async () => {
    const id = await seed([{ userId: 'revoked', permissions: [read, share] }]);

    const staleShareRead = await fabFileRepository.findById(id);
    expect(staleShareRead!.users.map(u => u.userId)).toEqual(['revoked']);

    await writeRevoke(await readForRevoke(id), 'revoked');
    await fabFileRepository.shareable.updateUserShares(id, { add: [{ userId: 'other', permissions: [read] }] });

    expect(await rowsOf(id)).toEqual([{ userId: 'other', permissions: [read] }]);
  });

  it('makes a revoke that read before a share retry rather than drop the share', async () => {
    const id = await seed([{ userId: 'revoked', permissions: [read] }]);

    const revokeRead = await readForRevoke(id);
    await fabFileRepository.shareable.updateUserShares(id, { add: [{ userId: 'other', permissions: [read] }] });

    await expect(writeRevoke(revokeRead, 'revoked')).rejects.toBeInstanceOf(ConcurrencyConflictError);
    expect((await rowsOf(id)).map(row => row.userId)).toEqual(['revoked', 'other']);

    await writeRevoke(await readForRevoke(id), 'revoked');
    expect(await rowsOf(id)).toEqual([{ userId: 'other', permissions: [read] }]);
  });

  it('keeps every change under interleaved shares and a revoke', async () => {
    const id = await seed([{ userId: 'revoked', permissions: [read] }]);

    const revoke = async () => {
      for (;;) {
        try {
          return await writeRevoke(await readForRevoke(id), 'revoked');
        } catch (e) {
          if (!(e instanceof ConcurrencyConflictError)) throw e;
        }
      }
    };
    const shares = Array.from({ length: 8 }, (_, i) =>
      fabFileRepository.shareable.updateUserShares(id, { add: [{ userId: `u${i}`, permissions: [read] }] })
    );

    await Promise.all([revoke(), ...shares]);

    const userIds = (await rowsOf(id)).map(row => row.userId);
    expect(userIds).not.toContain('revoked');
    expect(userIds.sort()).toEqual(Array.from({ length: 8 }, (_, i) => `u${i}`));
  });
});
