import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { FabFileChunk } from './FabFileModel';
import { setupMongoTest } from '../../__test__/utils';

const makeChunk = (fabFileId: string) => FabFileChunk.create({ fabFileId, text: 't', tokenCount: 1 });

/**
 * The field is a plain String with a `ref`, so before the validator anything stringified into it
 * cleanly - including a whole serialized FabFile document, which is how a batch of permanently
 * unreachable chunks got written. Every reader addresses a chunk by `fabFileId`, so a value that
 * cannot name a row by `_id` is invisible to retrieval AND to the delete-by-file reap.
 */
describe('FabFileChunk.fabFileId format validator', () => {
  setupMongoTest();

  it('accepts a 24-character hex ObjectId string', async () => {
    const id = String(new mongoose.Types.ObjectId());
    const chunk = await makeChunk(id);
    expect(chunk.fabFileId).toBe(id);
  });

  it('rejects a serialized document', async () => {
    const serialized = `{ _id: new ObjectId("${new mongoose.Types.ObjectId()}"), fileName: 'contract.pdf' }`;
    await expect(makeChunk(serialized)).rejects.toThrow(/24-character hex ObjectId/);
  });

  it('rejects anything else that is not an ObjectId string', async () => {
    for (const bad of ['', 'f1', 'not-an-object-id-at-all!', `${new mongoose.Types.ObjectId()}0`]) {
      await expect(makeChunk(bad)).rejects.toThrow();
    }
  });
});
