import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { FabFile, Session } from '@bike4mind/database';
import { createMongoServer } from '../../../database/src/__test__/createMongoServer';
import { findOwnerMismatches } from './20260806000000_audit-fabfile-session-owner-mismatch';

// Proves the real Mongo query semantics a mocked unit test cannot: soft-delete
// default-scoping on FabFile.find, and that a real Session._id round-trips through String()
// to the same string FabFile.sessionId stores it as.

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
  await FabFile.deleteMany({}, { hardDelete: true } as Record<string, unknown>);
  await Session.deleteMany({}, { hardDelete: true } as Record<string, unknown>);
});

describe('audit-fabfile-session-owner-mismatch migration (real DB)', () => {
  it('finds a real owner mismatch and excludes a matching pair and a soft-deleted file', async () => {
    const owner = await Session.create({
      name: 'Notebook',
      userId: 'owner-1',
      lastUpdated: new Date(),
      firstCreated: new Date(),
    });

    await FabFile.create({
      userId: 'owner-1',
      fileName: 'match.txt',
      mimeType: 'text/plain',
      type: 'FILE',
      sessionId: owner.id,
    });
    const mismatched = await FabFile.create({
      userId: 'someone-else',
      fileName: 'mismatch.txt',
      mimeType: 'text/plain',
      type: 'FILE',
      sessionId: owner.id,
    });
    const softDeleted = await FabFile.create({
      userId: 'someone-else',
      fileName: 'deleted-mismatch.txt',
      mimeType: 'text/plain',
      type: 'FILE',
      sessionId: owner.id,
    });
    await FabFile.deleteOne({ _id: softDeleted._id });

    const fabFiles = (await FabFile.find({ deletedAt: null, sessionId: { $exists: true, $nin: [null, ''] } })
      .select('userId sessionId fileName createdAt')
      .lean()) as { _id: unknown; userId: string; sessionId: string; fileName: string; createdAt?: Date }[];

    expect(fabFiles.map(f => f.fileName).sort()).toEqual(['match.txt', 'mismatch.txt']);

    const sessions = (await Session.find({ _id: { $in: [...new Set(fabFiles.map(f => f.sessionId))] } })
      .select('userId')
      .setOptions({ includeDeleted: true })
      .lean()) as { _id: unknown; userId: string }[];
    const sessionOwnerById = new Map(sessions.map(s => [String(s._id), s.userId]));

    const { mismatches, orphanedSessionIds } = findOwnerMismatches(
      fabFiles as unknown as Parameters<typeof findOwnerMismatches>[0],
      sessionOwnerById
    );

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].fabFileId).toBe(String(mismatched._id));
    expect(orphanedSessionIds).toEqual([]);
  });

  it('resolves the owner of a since-soft-deleted session, not just live ones', async () => {
    const owner = await Session.create({
      name: 'Notebook',
      userId: 'owner-1',
      lastUpdated: new Date(),
      firstCreated: new Date(),
    });
    await Session.findByIdAndDelete(owner.id);

    const mismatched = await FabFile.create({
      userId: 'someone-else',
      fileName: 'mismatch.txt',
      mimeType: 'text/plain',
      type: 'FILE',
      sessionId: owner.id,
    });

    const fabFiles = (await FabFile.find({ deletedAt: null, sessionId: { $exists: true, $nin: [null, ''] } })
      .select('userId sessionId fileName createdAt')
      .lean()) as { _id: unknown; userId: string; sessionId: string; fileName: string; createdAt?: Date }[];

    const sessions = (await Session.find({ _id: { $in: [...new Set(fabFiles.map(f => f.sessionId))] } })
      .select('userId')
      .setOptions({ includeDeleted: true })
      .lean()) as { _id: unknown; userId: string }[];
    const sessionOwnerById = new Map(sessions.map(s => [String(s._id), s.userId]));

    const { mismatches } = findOwnerMismatches(
      fabFiles as unknown as Parameters<typeof findOwnerMismatches>[0],
      sessionOwnerById
    );

    expect(mismatches.map(m => m.fabFileId)).toEqual([String(mismatched._id)]);
  });
});
