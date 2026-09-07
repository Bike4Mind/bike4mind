import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose, { isObjectIdOrHexString } from 'mongoose';
import { KnowledgeType } from '@bike4mind/common';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { FabFile, fabFileRepository } from './FabFileModel';

/**
 * Run against a real server because the behaviour under test IS Mongo's casting, not the shape of
 * a query object. Session id arrays are declared `[{ type: String }]` (SessionModel) while these
 * collections are ObjectId-keyed, so every consumer that resolves them by `_id` inherits whatever
 * this file pins down. `db-core/src/utils/mongo.ts` `usableObjectIds` guards those consumers with
 * `isObjectIdOrHexString`; the service-layer unit tests around it use stubs, which encode an
 * assumption about Mongo rather than checking it. This is where that assumption is checked.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;
let liveId: string;

// Not castable at all: the shape a session row written before this filtering can still hold.
const JUNK_ID = 'legacy-uuid-not-an-objectid';
// 12 hex-ish characters. Mongoose's own docs still show `isValidObjectId('0123456789ab')` as
// true (the old 12-BYTE-string form); on mongoose 8 it is false and casting throws. Pinned here
// so nobody re-derives the stale rule from the docs.
const TWELVE_CHAR_ID = '0123456789ab';

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  const file = await FabFile.create({
    userId: 'owner-1',
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

describe('an `_id: { $in: [...] }` query against real Mongo', () => {
  it('resolves the row when every id is castable', async () => {
    const rows = await FabFile.find({ _id: { $in: [liveId] } });
    expect(rows.map(r => String(r._id))).toEqual([liveId]);
  });

  it('rejects the WHOLE query on one non-castable id, losing the valid rows too', async () => {
    // The premise of the export fix: one bad entry is not a partial result, it is no result.
    await expect(FabFile.find({ _id: { $in: [JUNK_ID, liveId] } })).rejects.toThrow(/Cast to ObjectId failed/);
  });
});

describe('choosing the predicate', () => {
  it('rejects a 12-character string, despite what the mongoose docs still show', () => {
    expect(mongoose.isValidObjectId(TWELVE_CHAR_ID)).toBe(false);
    expect(isObjectIdOrHexString(TWELVE_CHAR_ID)).toBe(false);
  });

  it('agrees with isValidObjectId for every string, so the choice is about intent not behaviour', () => {
    for (const id of [JUNK_ID, TWELVE_CHAR_ID, liveId, liveId.toUpperCase()]) {
      expect(isObjectIdOrHexString(id)).toBe(mongoose.isValidObjectId(id));
    }
  });

  /**
   * Where they DO diverge: isValidObjectId accepts a number and casts it to a fabricated id that
   * can never match a stored row. Session id arrays are declared as String so a number cannot
   * reach them today, but isObjectIdOrHexString states the actual requirement - a stringified
   * ObjectId - and stays correct if a caller ever hands one of these predicates a non-string.
   */
  it('diverges on a number, which isValidObjectId accepts and casts to a fabricated id', async () => {
    expect(mongoose.isValidObjectId(6)).toBe(true);
    expect(isObjectIdOrHexString(6)).toBe(false);

    const fabricated = String(new mongoose.Types.ObjectId(6));
    expect(fabricated).not.toBe(liveId);
    expect(await FabFile.find({ _id: { $in: [fabricated] } })).toEqual([]);
  });
});

describe('FabFileRepository.findAllByIds', () => {
  it('returns the rows for the usable ids and skips the rest, rather than throwing', async () => {
    const rows = await fabFileRepository.findAllByIds([JUNK_ID, liveId]);
    expect(rows.map(r => String(r.id ?? r._id))).toEqual([liveId]);
  });

  it('returns nothing when no id is usable, instead of throwing', async () => {
    expect(await fabFileRepository.findAllByIds([JUNK_ID, TWELVE_CHAR_ID])).toEqual([]);
  });
});
