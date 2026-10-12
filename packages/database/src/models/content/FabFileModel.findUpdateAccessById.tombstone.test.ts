import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { FabFile, fabFileRepository } from './FabFileModel';

/**
 * Regression guard: the update-access lookup behind PUT /api/files/{id} and PATCH /api/v1/files/{id}
 * has no deletedAt filter of its own. Tombstones stay unreachable only because softDeletePlugin's
 * findOne hook adds one, so this pins that against a real Mongo.
 */
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
  await FabFile.deleteMany({}, { hardDelete: true });
});

const OWNER = { id: 'user-owner', groups: [] as string[] };
const EDITOR = { id: 'user-editor', groups: [] as string[] };

const makeFile = (overrides: Record<string, unknown> = {}) =>
  FabFile.create({
    fileName: 'notes.txt',
    userId: OWNER.id,
    type: KnowledgeType.URL,
    mimeType: 'text/plain',
    users: [{ userId: EDITOR.id, permissions: ['read', 'update'] }],
    ...overrides,
  });

describe('fabFileRepository.shareable.findUpdateAccessById on a soft-deleted file', () => {
  it('resolves a live file for its owner and an update sharee', async () => {
    const file = await makeFile();

    expect(await fabFileRepository.shareable.findUpdateAccessById(OWNER, String(file._id))).not.toBeNull();
    expect(await fabFileRepository.shareable.findUpdateAccessById(EDITOR, String(file._id))).not.toBeNull();
  });

  it('resolves nothing once the file is soft-deleted', async () => {
    const file = await makeFile({ deletedAt: new Date() });

    expect(await fabFileRepository.shareable.findUpdateAccessById(OWNER, String(file._id))).toBeNull();
    expect(await fabFileRepository.shareable.findUpdateAccessById(EDITOR, String(file._id))).toBeNull();
  });

  it('leaves a tombstone untouched when a write is aimed at it directly', async () => {
    const file = await makeFile({ deletedAt: new Date() });

    await fabFileRepository.update({ id: String(file._id), fileName: 'renamed.txt' });

    const raw = await FabFile.collection.findOne({ _id: file._id });
    expect(raw?.fileName).toBe('notes.txt');
    expect(raw?.deletedAt).toBeInstanceOf(Date);
  });
});
