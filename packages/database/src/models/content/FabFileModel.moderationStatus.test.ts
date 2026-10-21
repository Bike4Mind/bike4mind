import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { FabFile, fabFileRepository } from './FabFileModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const makeFabFile = (overrides: Record<string, unknown> = {}) =>
  FabFile.create({ userId: 'u1', fileName: 'x.png', mimeType: 'image/png', type: KnowledgeType.FILE, filePath: 'x.png', ...overrides });

describe('FabFile moderationStatus', () => {
  it('defaults to pending and round-trips clean/blocked', async () => {
    const f = await FabFile.create({
      userId: 'u1',
      fileName: 'a.png',
      mimeType: 'image/png',
      type: KnowledgeType.FILE,
      filePath: 'a.png',
    });
    expect(f.moderationStatus).toBe('pending');

    f.moderationStatus = 'blocked';
    await f.save();
    const reloaded = await FabFile.findById(f.id);
    expect(reloaded?.moderationStatus).toBe('blocked');
  });

  // 'scanning' is the atomic-claim interim state written by objectCreated's
  // findOneAndUpdate compare-and-swap before a scan runs - must be a valid enum value.
  it('accepts "scanning" and round-trips it via findOneAndUpdate (the atomic-claim shape)', async () => {
    const f = await FabFile.create({
      userId: 'u1',
      fileName: 'b.png',
      mimeType: 'image/png',
      type: KnowledgeType.FILE,
      filePath: 'b.png',
      moderationStatus: 'pending',
    });

    const claimed = await FabFile.findOneAndUpdate(
      { _id: f._id, moderationStatus: { $in: ['pending', null] } },
      { $set: { moderationStatus: 'scanning' } },
      { new: true }
    );
    expect(claimed?.moderationStatus).toBe('scanning');

    // A second concurrent claim attempt must lose (already 'scanning', no longer matches
    // the $in: ['pending', null] filter) - this is the core atomicity guarantee.
    const secondClaim = await FabFile.findOneAndUpdate(
      { _id: f._id, moderationStatus: { $in: ['pending', null] } },
      { $set: { moderationStatus: 'scanning' } },
      { new: true }
    );
    expect(secondClaim).toBeNull();
  });

  // blockReason is persisted (not just logged) when a file is blocked so ops
  // can distinguish an unscannable format from a confirmed-explicit match.
  it('persists an optional blockReason alongside a blocked moderationStatus', async () => {
    const f = await FabFile.create({
      userId: 'u1',
      fileName: 'c.heic',
      mimeType: 'image/heic',
      type: KnowledgeType.FILE,
      filePath: 'c.heic',
      moderationStatus: 'blocked',
      blockReason: 'unsupported_format',
    });

    const reloaded = await FabFile.findById(f.id);
    expect(reloaded?.moderationStatus).toBe('blocked');
    expect(reloaded?.blockReason).toBe('unsupported_format');
  });

  it('leaves blockReason unset for a confirmed-explicit block (no reason recorded)', async () => {
    const f = await FabFile.create({
      userId: 'u1',
      fileName: 'd.png',
      mimeType: 'image/png',
      type: KnowledgeType.FILE,
      filePath: 'd.png',
      moderationStatus: 'blocked',
    });

    const reloaded = await FabFile.findById(f.id);
    expect(reloaded?.moderationStatus).toBe('blocked');
    expect(reloaded?.blockReason).toBeUndefined();
  });
});

describe('FabFile hard-delete legal-hold guard', () => {
  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  it('hardDeleteOneById throws for a blocked file and leaves it in the DB', async () => {
    const f = await makeFabFile({ moderationStatus: 'blocked' });
    await expect(fabFileRepository.hardDeleteOneById(String(f._id))).rejects.toThrow('legal hold');
    expect(await FabFile.findById(f._id).setOptions({ includeDeleted: true })).not.toBeNull();
  });

  it('hardDeleteOneById succeeds for a non-blocked file', async () => {
    const f = await makeFabFile({ moderationStatus: 'clean' });
    const deleted = await fabFileRepository.hardDeleteOneById(String(f._id));
    expect(deleted).toBe(true);
    expect(await FabFile.findById(f._id).setOptions({ includeDeleted: true })).toBeNull();
  });

  it('hardDeleteByIds throws when any file in the batch is blocked', async () => {
    const clean = await makeFabFile({ moderationStatus: 'clean' });
    const blocked = await makeFabFile({ moderationStatus: 'blocked' });
    const ids = [String(clean._id), String(blocked._id)];
    await expect(fabFileRepository.hardDeleteByIds(ids)).rejects.toThrow('legal hold');
    // Neither file is deleted: the throw fires before deleteMany.
    expect(await FabFile.findById(clean._id).setOptions({ includeDeleted: true })).not.toBeNull();
    expect(await FabFile.findById(blocked._id).setOptions({ includeDeleted: true })).not.toBeNull();
  });

  it('hardDeleteByIds succeeds when no file in the batch is blocked', async () => {
    const f1 = await makeFabFile({ moderationStatus: 'clean' });
    const f2 = await makeFabFile({ moderationStatus: 'pending' });
    const ids = [String(f1._id), String(f2._id)];
    const result = await fabFileRepository.hardDeleteByIds(ids);
    expect(result).toHaveLength(2);
    expect(await FabFile.findById(f1._id).setOptions({ includeDeleted: true })).toBeNull();
    expect(await FabFile.findById(f2._id).setOptions({ includeDeleted: true })).toBeNull();
  });
});
