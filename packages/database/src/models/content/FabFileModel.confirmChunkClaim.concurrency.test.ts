import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoClient, ObjectId } from 'mongodb';
import { withTransaction } from '@bike4mind/db-core';
import { KnowledgeType } from '@bike4mind/common';
import { createMongoReplSet } from '../../__test__/createMongoServer';
import { FabFile, fabFileRepository } from './FabFileModel';

// #1802 Phase 2: unlike confirmChunkClaim.test.ts (sequential setup-then-check, standalone Mongo),
// this exercises the guard against a GENUINELY concurrent takeover - a real, non-transactional write
// landing while chunkFabfile's own transaction is still open, mirroring the actual production shape
// (fabFileChunk.ts's stale-arm CAS commits outside any transaction). Needs a real replica set:
// standalone Mongo cannot run transactions at all (see createMongoServer.ts).
let server: Awaited<ReturnType<typeof createMongoReplSet>>;
let externalClient: MongoClient;

beforeAll(async () => {
  server = await createMongoReplSet();
  const uri = server.getUri();
  await mongoose.connect(uri);
  // A genuinely separate driver connection/session - the takeover below must NOT be able to run
  // inside chunkFabfile's transaction, or this test would not be testing concurrency at all.
  externalClient = new MongoClient(uri);
  await externalClient.connect();
}, 60000);

afterAll(async () => {
  await externalClient.close();
  await mongoose.disconnect();
  await server.stop();
});

describe('FabFileRepository.confirmChunkClaim - genuine concurrent takeover', () => {
  it("detects a stale-claim takeover that commits WHILE the guard's own transaction is still open", async () => {
    const file = await FabFile.create({
      userId: 'u-concurrency',
      fileName: 'a.txt',
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      filePath: 'a.txt',
      isChunking: true,
      chunkClaimedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const fabFileId = String(file._id);
    const originalStamp = new Date('2026-01-01T00:00:00.000Z');
    const successorStamp = new Date('2026-01-01T00:31:00.000Z');

    let releaseTakeover: () => void;
    const takeoverReady = new Promise<void>(resolve => (releaseTakeover = resolve));

    // Mirrors chunkFabfile's real shape: an early read establishes the transaction's snapshot,
    // then simulated chunking work (S3 download, tokenize) elapses, THEN the guard runs.
    const guardPromise = withTransaction(async () => {
      await FabFile.findById(fabFileId);
      releaseTakeover();
      await new Promise(resolve => setTimeout(resolve, 300));
      return fabFileRepository.confirmChunkClaim(fabFileId, originalStamp);
    });

    await takeoverReady;
    // The real mechanism this simulates: fabFileChunk.ts's stale-arm CAS, a plain findOneAndUpdate
    // with no session, via a wholly separate client - genuinely concurrent, genuinely external.
    const takeoverResult = await externalClient
      .db(mongoose.connection.name)
      .collection('fabfiles')
      .findOneAndUpdate(
        { _id: new ObjectId(fabFileId) },
        { $set: { isChunking: true, chunkClaimedAt: successorStamp } }
      );
    expect(takeoverResult).not.toBeNull();

    const guardResult = await guardPromise;
    expect(guardResult).toBe(false);

    const finalFile = await FabFile.findById(fabFileId).lean();
    expect(finalFile?.chunkClaimedAt?.toISOString()).toBe(successorStamp.toISOString());
  }, 30000);
});
