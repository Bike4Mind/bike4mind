import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { FabFile } from './FabFileModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

describe('FabFile moderationStatus (#9776 Q2b)', () => {
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
