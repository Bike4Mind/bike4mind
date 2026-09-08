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
beforeEach(async () => {
  await FabFile.deleteMany({});
});

// Shares-aware id lookup for engine callers (image generation / edit_image) that hold only a
// userId and have no req.ability. Must match the CASL FabFile read rule: owner OR user-share
// OR group-share OR global-read, and NOTHING else.
describe('FabFileRepository.findAccessibleInIds', () => {
  const owner = 'u-owner';
  const other = 'u-other';

  const makeImage = (userId: string, extra: Record<string, unknown> = {}) =>
    FabFile.create({
      userId,
      fileName: 'img.png',
      mimeType: 'image/png',
      type: KnowledgeType.FILE,
      filePath: `${new mongoose.Types.ObjectId().toString()}.png`,
      ...extra,
    });

  it("denies another user's private file (the IDOR)", async () => {
    const foreign = await makeImage(other);
    const files = await fabFileRepository.findAccessibleInIds([foreign.id], { userId: owner });
    expect(files).toEqual([]);
  });

  it('returns the caller-owned file', async () => {
    const mine = await makeImage(owner);
    const files = await fabFileRepository.findAccessibleInIds([mine.id], { userId: owner });
    expect(files.map(f => f.id)).toEqual([mine.id]);
  });

  it('returns a file shared with the caller by userId', async () => {
    const shared = await makeImage(other, { users: [{ userId: owner, permissions: ['read'] }] });
    const files = await fabFileRepository.findAccessibleInIds([shared.id], { userId: owner });
    expect(files.map(f => f.id)).toEqual([shared.id]);
  });

  it('returns a file shared with one of the caller groups', async () => {
    const shared = await makeImage(other, { groups: [{ groupId: 'g1', permissions: ['read'] }] });
    const files = await fabFileRepository.findAccessibleInIds([shared.id], { userId: owner, userGroups: ['g1'] });
    expect(files.map(f => f.id)).toEqual([shared.id]);
  });

  it('does NOT return a group-shared file when the caller is not in that group', async () => {
    const shared = await makeImage(other, { groups: [{ groupId: 'g1', permissions: ['read'] }] });
    const files = await fabFileRepository.findAccessibleInIds([shared.id], { userId: owner, userGroups: ['g2'] });
    expect(files).toEqual([]);
  });

  it('returns a global-read file owned by another user', async () => {
    const global = await makeImage(other, { isGlobalRead: true });
    const files = await fabFileRepository.findAccessibleInIds([global.id], { userId: owner });
    expect(files.map(f => f.id)).toEqual([global.id]);
  });

  it('returns only the accessible subset from a mixed id list', async () => {
    const mine = await makeImage(owner);
    const foreign = await makeImage(other);
    const files = await fabFileRepository.findAccessibleInIds([mine.id, foreign.id], { userId: owner });
    expect(files.map(f => f.id)).toEqual([mine.id]);
  });

  it('drops invalid ObjectIds and returns [] for an empty/invalid-only list', async () => {
    expect(await fabFileRepository.findAccessibleInIds([], { userId: owner })).toEqual([]);
    expect(await fabFileRepository.findAccessibleInIds(['not-an-object-id'], { userId: owner })).toEqual([]);
  });
});
