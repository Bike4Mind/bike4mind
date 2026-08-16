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

/**
 * Fail a handshake wait with a message naming WHICH side hung, instead of letting the whole test
 * die on vitest's timeout with no indication of where.
 *
 * Deliberately generous: this must never fire on a merely slow runner (the waits it guards are one
 * transaction-start-plus-read and one non-transactional write), only on a genuine deadlock. It
 * exists because a previous CI failure was an unexplained 30s timeout whose cause - slow vs stuck -
 * could not be told apart from the log.
 */
const HANDSHAKE_DEADLINE_MS = 20_000;
function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not settle within ${HANDSHAKE_DEADLINE_MS}ms - handshake deadlock`)),
      HANDSHAKE_DEADLINE_MS
    );
  });
  // clearTimeout on settle, or the pending timer keeps the worker's event loop alive after the test.
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

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
    let signalTakeoverCommitted: () => void;
    const takeoverCommitted = new Promise<void>(resolve => (signalTakeoverCommitted = resolve));

    // Mirrors chunkFabfile's real shape: an early read establishes the transaction's snapshot,
    // then simulated chunking work (S3 download, tokenize) elapses, THEN the guard runs. The delay
    // awaits the takeover's actual commit rather than a fixed sleep - a prior `setTimeout(..., 300)`
    // here raced the takeover below on a hoped-for timing margin (the test's own `await`s only
    // order ITS control flow, not the guard's independently-running transaction), and under CI's
    // more variable latency the takeover could still be in flight when 300ms elapsed, flipping this
    // test's central assertion - reproduced as a real failure on main, not this branch, at the exact
    // commit this file was added in. An explicit signal makes the ordering a guarantee, not a race.
    const guardPromise = withTransaction(async () => {
      await FabFile.findById(fabFileId);
      releaseTakeover();
      await withDeadline(takeoverCommitted, 'takeoverCommitted');
      return fabFileRepository.confirmChunkClaim(fabFileId, originalStamp);
    });

    await withDeadline(takeoverReady, 'takeoverReady');
    try {
      // The real mechanism this simulates: fabFileChunk.ts's stale-arm CAS, a plain
      // findOneAndUpdate with no session, via a wholly separate client - genuinely concurrent,
      // genuinely external.
      const takeoverResult = await externalClient
        .db(mongoose.connection.name)
        .collection('fabfiles')
        .findOneAndUpdate(
          { _id: new ObjectId(fabFileId) },
          { $set: { isChunking: true, chunkClaimedAt: successorStamp } }
        );
      expect(takeoverResult).not.toBeNull();
    } finally {
      // Always release the guard's transaction, even if the takeover itself failed - otherwise a
      // failure here leaves guardPromise's transaction open through afterAll's teardown, trading a
      // clean assertion error for a noisy disconnect/timeout on top of it.
      signalTakeoverCommitted();
    }

    const guardResult = await guardPromise;
    expect(guardResult).toBe(false);

    const finalFile = await FabFile.findById(fabFileId).lean();
    expect(finalFile?.chunkClaimedAt?.toISOString()).toBe(successorStamp.toISOString());
    // 30s was too tight and timed out on CI twice, blocking a production promotion. This test is
    // heavier than its ~2s local runtime suggests: a single-node replica set (so every transaction
    // commit needs majority acknowledgement) plus a guarded write that can raise a WriteConflict and
    // send withTransaction through up to two more full attempts with backoff. Under the shard's
    // parallelism the database package logs ~2470s of test-time in ~221s of wall clock locally, and
    // a 2-core CI runner is slower again - so the ceiling has to be sized for a contended runner,
    // not for an idle laptop. Nothing here should take a minute; if it does, the deadlines above
    // fire first and name the side that hung.
  }, 90_000);
});
