import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import { IUserDocument, KnowledgeType } from '@bike4mind/common';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { FabFile, fabFileRepository } from './FabFileModel';

/**
 * Real server, because the behaviour under test is Mongo's casting: an unguarded
 * `_id: { $in: [...] }` here rejects the whole query, and /api/files/byIds turns that CastError
 * into a 404 on the notebook file list. Stubs would encode the assumption instead of checking it.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;
let liveId: string;

const OWNER = 'owner-1';
// The shape a session row written before the id filtering can still hold.
const JUNK_ID = 'legacy-uuid-not-an-objectid';

const user = { id: OWNER, groups: [] } as unknown as IUserDocument;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  const file = await FabFile.create({
    userId: OWNER,
    fileName: 'live.txt',
    type: KnowledgeType.FILE,
    mimeType: 'text/plain',
    fileSize: 4,
  });
  liveId = String(file._id);
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

describe('findAllAccessibleByIds', () => {
  it('resolves the row when every id is castable', async () => {
    const rows = await fabFileRepository.shareable.findAllAccessibleByIds(user, [liveId]);
    expect(rows.map(r => String(r.id))).toEqual([liveId]);
  });

  it('keeps the valid row when one id cannot address a row by _id', async () => {
    const rows = await fabFileRepository.shareable.findAllAccessibleByIds(user, [JUNK_ID, liveId]);
    expect(rows.map(r => String(r.id))).toEqual([liveId]);
  });

  it('matches nothing rather than throwing when every id is unusable', async () => {
    const rows = await fabFileRepository.shareable.findAllAccessibleByIds(user, [JUNK_ID]);
    expect(rows).toEqual([]);
  });
});
