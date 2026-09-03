import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { buildChunkScanQueuePayload, buildFabFileChunkScanFilter, buildStrandedVectorizeScanFilter } from './chunkScan';
import { CHUNK_STALL_NOTICES, provenancePayloadShape, shouldHaltConvergence } from '@bike4mind/common';

// Minimal evaluator for the subset of Mongo operators the scan filter uses, so we can assert
// which documents the filter would (not) select without a live Mongo.
type Doc = Record<string, unknown>;
const MODELLED_OPERATORS = new Set(['$ne', '$lt', '$type', '$not', '$in', '$nin']);
const matches = (doc: Doc, filter: Record<string, unknown>): boolean =>
  Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return (cond as Record<string, unknown>[]).some(sub => matches(doc, sub));
    if (key === '$and') return (cond as Record<string, unknown>[]).every(sub => matches(doc, sub));
    const value = doc[key];
    if (cond === null) return value === null || value === undefined;
    if (cond instanceof RegExp) return typeof value === 'string' && cond.test(value);
    if (cond && typeof cond === 'object') {
      // EVERY operator in the condition, not just the first one found. A first-match-wins evaluator
      // is green over a query that behaves differently the moment any field carries two operators,
      // which this filter has done before and can again.
      const ops = cond as Record<string, unknown>;
      const checks: boolean[] = [];
      if ('$ne' in ops) {
        const ne = ops.$ne;
        // Mongo treats a MISSING field as null, so `{$ne: null}` does not match one - which is the
        // whole reason the stamped-file arm below can be written as `$ne: null` without matching every
        // legacy row. Other `$ne` values (e.g. `isChunking: {$ne: true}`) do match a missing field.
        checks.push(ne === null ? value !== null && value !== undefined : value !== ne);
      }
      // Type-bracketed, like Mongo: a comparison only ever matches a value of the SAME BSON type, so
      // a missing field or a wrong-typed one never matches `$lt: <Date>`. Written as a JS `<` it
      // would coerce instead, agreeing with Mongo by luck on the fixtures here and diverging on any
      // fixture that ever carries a non-Date.
      if ('$lt' in ops) checks.push(value instanceof Date && ops.$lt instanceof Date && value < ops.$lt);
      // `$type` is what pins buildStrandedVectorizeScanFilter to its partial index (chunkScan.ts),
      // so it has to be modelled or the throw below fires on that filter's own tests. Only the
      // 'date' alias is used; another alias would quietly pass, so name it instead.
      if ('$type' in ops) {
        if (ops.$type !== 'date') {
          throw new Error(`chunkScan.test matches(): unmodelled $type alias '${String(ops.$type)}' on '${key}'`);
        }
        checks.push(value instanceof Date);
      }
      if ('$not' in ops) checks.push(!matches({ [key]: value }, { [key]: ops.$not }));
      // Mongo $in with null also matches a missing field.
      if ('$in' in ops)
        checks.push(
          (ops.$in as unknown[]).some(v => (v === null ? value === null || value === undefined : value === v))
        );
      // $nin is the negation, and it MATCHES a missing field (null is not in a list of note strings).
      if ('$nin' in ops)
        checks.push(
          !(ops.$nin as unknown[]).some(v => (v === null ? value === null || value === undefined : value === v))
        );
      // Loud on drift. An operator this model does not implement used to fall through to the
      // `value === cond` below, which is false for any object - so a filter that grew a new operator
      // would keep every `toBe(false)` assertion passing while asserting nothing, and the
      // `toBe(true)` ones would fail somewhere unrelated. Throwing names the gap instead.
      const unmodelled = Object.keys(ops).filter(k => k.startsWith('$') && !MODELLED_OPERATORS.has(k));
      if (unmodelled.length > 0) {
        throw new Error(`chunkScan.test matches(): unmodelled Mongo operator(s) ${unmodelled.join(', ')} on '${key}'`);
      }
      if (checks.length > 0) return checks.every(Boolean);
    }
    return value === cond;
  });

describe('buildFabFileChunkScanFilter', () => {
  const cutoff = new Date('2026-01-01T00:00:00Z');
  const old = new Date('2025-12-31T00:00:00Z'); // before cutoff
  const filter = buildFabFileChunkScanFilter(cutoff, undefined, { excludeConvergencePaused: false });

  it("requires status 'complete' so a never-completed upload is skipped", () => {
    expect(filter.status).toBe('complete');
  });

  it('selects a completed, un-chunked, old, not-in-progress file', () => {
    const doc = { status: 'complete', chunkCount: 0, isChunking: false, createdAt: old, deletedAt: null };
    expect(matches(doc, filter)).toBe(true);
  });

  it('skips a file whose upload never completed (stuck pending)', () => {
    // The failed-upload case: the record exists but no object ever landed in storage.
    const doc = { status: 'pending', chunkCount: 0, isChunking: false, createdAt: old, deletedAt: null };
    expect(matches(doc, filter)).toBe(false);
  });

  it('skips a file that is actively chunking', () => {
    const doc = { status: 'complete', chunkCount: 0, isChunking: true, createdAt: old, deletedAt: null };
    expect(matches(doc, filter)).toBe(false);
  });

  it('skips an already-chunked file', () => {
    const doc = { status: 'complete', chunkCount: 5, isChunking: false, createdAt: old, deletedAt: null };
    expect(matches(doc, filter)).toBe(false);
  });

  it('skips a just-uploaded file still within the age window', () => {
    const recent = new Date('2026-01-01T00:01:00Z'); // after cutoff
    const doc = { status: 'complete', chunkCount: 0, isChunking: false, createdAt: recent, deletedAt: null };
    expect(matches(doc, filter)).toBe(false);
  });

  it('skips a file already flagged as having no extractable text (terminal - would re-fail every cycle)', () => {
    const doc = {
      status: 'complete',
      chunkCount: 0,
      isChunking: false,
      createdAt: old,
      deletedAt: null,
      noExtractableTextAt: new Date('2025-12-31T12:00:00Z'),
    };
    expect(matches(doc, filter)).toBe(false);
  });

  it('still selects a file with unrelated user notes', () => {
    const doc = {
      status: 'complete',
      chunkCount: 0,
      isChunking: false,
      createdAt: old,
      deletedAt: null,
      notes: 'quarterly report, uploaded for the board deck',
    };
    expect(matches(doc, filter)).toBe(true);
  });

  it('KNOWN STRAND: does NOT re-select a paused MEDIA file - the halt write destroyed its only selection door', () => {
    // Known one-way door, documented on buildChunkScanQueuePayload: a media file reaches this filter
    // only through chunkRebuildRequestedAt, and the halt write nulls it in the same statement that
    // records the stall reason. Asserted rather than left implicit so the strand is visible to
    // whoever closes it - the switch-OFF block below covers the non-media file, which does come back.
    const doc = {
      status: 'complete',
      chunkCount: 0,
      isChunking: false,
      createdAt: old,
      deletedAt: null,
      error: null,
      mimeType: 'audio/mpeg',
      chunkStallReason: 'rechunkPaused',
      chunkRebuildRequestedAt: null,
    };
    expect(matches(doc, filter)).toBe(false);
  });

  it('skips a file whose chunking already failed (error persisted by the chunk handler)', () => {
    const doc = {
      status: 'complete',
      chunkCount: 0,
      isChunking: false,
      createdAt: old,
      deletedAt: null,
      error: 'Invalid PDF structure',
    };
    expect(matches(doc, filter)).toBe(false);
  });

  it('selects a file with an empty-string or missing error field', () => {
    const base = { status: 'complete', chunkCount: 0, isChunking: false, createdAt: old, deletedAt: null };
    expect(matches({ ...base, error: '' }, filter)).toBe(true);
    expect(matches({ ...base, error: null }, filter)).toBe(true);
    expect(matches(base, filter)).toBe(true);
  });

  it('skips audio, image, and video files (0 chunks by design, not a rescue candidate)', () => {
    const base = { status: 'complete', chunkCount: 0, isChunking: false, createdAt: old, deletedAt: null };
    expect(matches({ ...base, mimeType: 'audio/mpeg' }, filter)).toBe(false);
    expect(matches({ ...base, mimeType: 'image/png' }, filter)).toBe(false);
    expect(matches({ ...base, mimeType: 'image/svg+xml' }, filter)).toBe(false);
    expect(matches({ ...base, mimeType: 'video/mp4' }, filter)).toBe(false);
  });

  it('still selects chunkable document types', () => {
    const base = { status: 'complete', chunkCount: 0, isChunking: false, createdAt: old, deletedAt: null };
    expect(matches({ ...base, mimeType: 'text/markdown' }, filter)).toBe(true);
    expect(matches({ ...base, mimeType: 'application/pdf' }, filter)).toBe(true);
  });

  // #1939. This sweep is the only door that reaches a file outside every data lake, so excluding a
  // STAMPED media file by mimeType would leave that stamp with no automatic exit - and a stamped
  // file is withheld from search and named as "returns on its own", so no exit means a permanently
  // false partial-results warning. One pass clears it: the chunker returns 0 chunks as it always
  // would, and the commit clears the stamp.
  it('sweeps a media file carrying a pending-rebuild stamp, which has no other recovery door', () => {
    const base = { status: 'complete', chunkCount: 0, isChunking: false, createdAt: old, deletedAt: null };
    for (const mimeType of ['audio/mpeg', 'image/png', 'video/mp4']) {
      expect(matches({ ...base, mimeType }, filter)).toBe(false);
      expect(matches({ ...base, mimeType, chunkRebuildRequestedAt: new Date() }, filter)).toBe(true);
    }
  });

  // The exception must not widen the sweep past the stamp: the other terminal guards still apply,
  // or a stamped media file that failed terminally would be re-enqueued on every pass forever.
  it('still applies the error and no-extractable-text guards to a stamped media file', () => {
    const stamped = {
      status: 'complete',
      chunkCount: 0,
      isChunking: false,
      createdAt: old,
      deletedAt: null,
      mimeType: 'image/png',
      chunkRebuildRequestedAt: new Date(),
    };
    expect(matches(stamped, filter)).toBe(true);
    expect(matches({ ...stamped, error: 'chunker gave up' }, filter)).toBe(false);
    expect(matches({ ...stamped, noExtractableTextAt: new Date() }, filter)).toBe(false);
  });
});

describe('buildFabFileChunkScanFilter - convergence-paused exclusion (#2120)', () => {
  const cutoff = new Date('2026-01-01T00:00:00Z');
  const old = new Date('2025-12-31T00:00:00Z');
  // chunkRebuildRequestedAt is left UNSET rather than null: only the chunk-handler path clears it,
  // the vectorize path (fabFileVectorize.ts) writes its marker without touching it, so a fixture
  // that pins it to null would only reproduce one of the two marker paths.
  const candidate = (overrides: Doc = {}) => ({
    status: 'complete',
    chunkCount: 0,
    isChunking: false,
    createdAt: old,
    deletedAt: null,
    ...overrides,
  });
  const paused = (reason: string) => candidate({ chunkStallReason: reason });
  /** A pre-#2016 row: the marker is still prose in `notes` and no `chunkStallReason` exists yet. */
  const legacyPaused = (note: string) => candidate({ notes: note });

  describe('while the kill switch is ON', () => {
    const filter = buildFabFileChunkScanFilter(cutoff, undefined, { excludeConvergencePaused: true });

    it.each([
      ['the chunk-handler marker', 'rechunkPaused'],
      ['the vectorize marker', 'vectorizePaused'],
    ])('skips a paused file - %s', (_label, reason) => {
      // A paused file matches every OTHER clause (the reset zeroed chunkCount, the pause writes no
      // error), so without the exclusion it is re-selected every pass and consumes the rescue cap,
      // starving genuine lost-webhook candidates while the sweep still reports a healthy count.
      expect(matches(paused(reason), filter)).toBe(false);
    });

    it.each([
      ['the chunk-handler marker', CHUNK_STALL_NOTICES.rechunkPaused],
      ['the vectorize marker', CHUNK_STALL_NOTICES.vectorizePaused],
    ])('skips a pre-migration paused file carrying the marker as prose - %s', (_label, note) => {
      // #2016's migration and this code do not deploy atomically, so the transitional `notes` arm is
      // what keeps the exclusion working through the window. Delete with the rest of the legacy reads.
      expect(matches(legacyPaused(note), filter)).toBe(false);
    });

    it('still selects an ordinary un-chunked file, so the exclusion is not over-broad', () => {
      expect(matches(legacyPaused('quarterly report for the board deck'), filter)).toBe(true);
    });

    it('still selects a file with no stall reason and no notes at all', () => {
      expect(matches(candidate(), filter)).toBe(true);
    });

    it('still selects a file whose stall reason and notes are explicitly null', () => {
      // $nin matches a null/missing field. Pinned because getting this wrong would silently drop
      // every unstalled file from the sweep - the opposite, and far worse, failure than the churn
      // this exclusion fixes.
      expect(matches(candidate({ chunkStallReason: null, notes: null }), filter)).toBe(true);
    });
  });

  describe('while the kill switch is OFF', () => {
    const filter = buildFabFileChunkScanFilter(cutoff, undefined, { excludeConvergencePaused: false });

    it.each([
      ['the chunk-handler marker', 'rechunkPaused'],
      ['the vectorize marker', 'vectorizePaused'],
    ])('SELECTS a paused file so it is rebuilt - %s', (_label, reason) => {
      // The regression this conditionality prevents. This sweep is the only AUTOMATIC exit a paused
      // file has: the other two recovery paths are human-driven and lake-scoped, so neither reaches a
      // file outside every lake - exactly what the sweep exists to catch. And the re-enqueue really
      // does rebuild it: a batchId-less file is sent without an `origin`, and isConvergenceHalted
      // defaults a missing origin to 'user' and returns false, so it is genuinely re-chunked rather
      // than bounced. Excluding it unconditionally would break the marker's user-visible promise
      // that passages are "rebuilt when convergence resumes".
      expect(matches(paused(reason), filter)).toBe(true);
    });

    it('SELECTS a pre-migration paused file too, so the legacy arm is gated the same way', () => {
      expect(matches(legacyPaused(CHUNK_STALL_NOTICES.rechunkPaused), filter)).toBe(true);
    });

    it('still excludes a zero-chunk file, which is terminal either way', () => {
      expect(matches(candidate({ noExtractableTextAt: new Date('2026-01-02T00:00:00Z') }), filter)).toBe(false);
    });
  });
});

describe('buildFabFileChunkScanFilter - stale-claim recovery arm', () => {
  const cutoff = new Date('2026-01-01T00:00:00Z');
  const staleClaimBefore = new Date('2026-01-01T00:00:00Z'); // a claim older than this is stranded
  const old = new Date('2025-12-31T00:00:00Z'); // before both cutoffs
  const filter = buildFabFileChunkScanFilter(cutoff, staleClaimBefore, { excludeConvergencePaused: false });
  const base = { status: 'complete', chunkCount: 0, createdAt: old, deletedAt: null };

  it('still selects a normal not-in-progress file', () => {
    expect(matches({ ...base, isChunking: false }, filter)).toBe(true);
  });

  it('rescues a claim stranded past the stale cutoff (worker hard-killed before its finally)', () => {
    expect(matches({ ...base, isChunking: true, chunkClaimedAt: old }, filter)).toBe(true);
  });

  it('does NOT rescue a fresh in-flight claim (recent chunkClaimedAt)', () => {
    const recent = new Date('2026-01-01T00:10:00Z'); // after staleClaimBefore
    expect(matches({ ...base, isChunking: true, chunkClaimedAt: recent }, filter)).toBe(false);
  });

  it('RESCUES an isChunking:true claim with no timestamp - the backfill for files stuck before chunkClaimedAt existed', () => {
    // Every code path that sets isChunking:true now stamps chunkClaimedAt in the same write, so a
    // null/missing stamp on an in-flight file can only be a pre-migration straggler - which would
    // otherwise stay claimed and unrescuable forever. Note what protects a straggler that is in fact
    // still running: NOT a producer-side claim - the sweep does not re-claim before enqueue, it sends
    // exactly what this filter selected. The mutual exclusion is the chunk worker's own
    // compare-and-set (fabFileChunk.ts), which the duplicate delivery loses, returning without
    // re-chunking.
    expect(matches({ ...base, isChunking: true, chunkClaimedAt: null }, filter)).toBe(true);
    expect(matches({ ...base, isChunking: true }, filter)).toBe(true);
  });
});

describe('buildStrandedVectorizeScanFilter', () => {
  // The state this rescues: chunks committed, `chunked: true`, zero vectors and a failed
  // vectorize hand-off. buildFabFileChunkScanFilter cannot see it (it requires chunkCount: 0).
  const cutoff = new Date('2026-01-01T00:00:00Z');
  const stale = new Date('2025-12-31T00:00:00Z');
  const fresh = new Date('2026-01-01T00:00:01Z');
  const filter = buildStrandedVectorizeScanFilter(cutoff);

  it('selects a chunked file whose vectorize enqueue failed past the grace period', () => {
    const doc = { chunked: true, chunkCount: 12, vectorizeEnqueueFailedAt: stale, isChunking: false, deletedAt: null };
    expect(matches(doc, filter)).toBe(true);
  });

  it('skips a file with no stamp - the ordinary case, so the sweep costs nothing', () => {
    const doc = { chunked: true, chunkCount: 12, isChunking: false, deletedAt: null };
    expect(matches(doc, filter)).toBe(false);
  });

  it('skips a file whose stamp is the schema default null ($lt is type-bracketed)', () => {
    const doc = { chunked: true, chunkCount: 12, vectorizeEnqueueFailedAt: null, isChunking: false, deletedAt: null };
    expect(matches(doc, filter)).toBe(false);
  });

  it('skips a stamp inside the grace period, so it cannot race the handler own SQS retries', () => {
    const doc = { chunked: true, vectorizeEnqueueFailedAt: fresh, isChunking: false, deletedAt: null };
    expect(matches(doc, filter)).toBe(false);
  });

  it('skips a file that is actively chunking', () => {
    const doc = { chunked: true, vectorizeEnqueueFailedAt: stale, isChunking: true, deletedAt: null };
    expect(matches(doc, filter)).toBe(false);
  });

  describe('stale-claim arm', () => {
    // resumeVectorizeEnqueue holds the claim across real work (a vectorless-chunk read plus N
    // sends), so a hard-killed worker leaves isChunking:true with no finally to clear it. Every
    // other automatic door is shut on that file - hence the same three arms the un-chunked sweep
    // carries, with the same chunkClaimedAt cutoff.
    const claimCutoff = new Date('2026-01-01T00:00:00Z');
    const withStale = buildStrandedVectorizeScanFilter(cutoff, claimCutoff);
    const base = { chunked: true, vectorizeEnqueueFailedAt: stale, deletedAt: null };

    it('still selects a file that is not claimed at all', () => {
      expect(matches({ ...base, isChunking: false }, withStale)).toBe(true);
    });

    it('selects a claim older than the stale cutoff', () => {
      expect(matches({ ...base, isChunking: true, chunkClaimedAt: stale }, withStale)).toBe(true);
    });

    it('selects an in-flight file with no claim stamp - the pre-chunkClaimedAt backfill', () => {
      expect(matches({ ...base, isChunking: true, chunkClaimedAt: null }, withStale)).toBe(true);
      expect(matches({ ...base, isChunking: true }, withStale)).toBe(true);
    });

    it('leaves a genuinely in-flight claim alone', () => {
      expect(matches({ ...base, isChunking: true, chunkClaimedAt: fresh }, withStale)).toBe(false);
    });

    it('uses the same claim cutoff the un-chunked sweep does', () => {
      const claimed = { isChunking: true, chunkClaimedAt: fresh };
      expect(matches({ ...base, ...claimed }, withStale)).toBe(
        matches(
          {
            status: 'complete',
            chunkCount: 0,
            createdAt: stale,
            deletedAt: null,
            mimeType: 'application/pdf',
            ...claimed,
          },
          buildFabFileChunkScanFilter(cutoff, claimCutoff, { excludeConvergencePaused: false })
        )
      );
    });
  });

  it('skips a deleted file', () => {
    const doc = { chunked: true, vectorizeEnqueueFailedAt: stale, isChunking: false, deletedAt: new Date() };
    expect(matches(doc, filter)).toBe(false);
  });

  it('skips a file that was re-chunked, whose reset cleared chunked and the stamp with it', () => {
    // resetChunkStateByIds clears vectorizeEnqueueFailedAt, so this shape should not occur - the
    // `chunked: true` clause is what makes the two sweeps' domains disjoint by construction rather
    // than by whichever writer cleared the marker. An un-chunked file is the other sweep's business.
    const doc = { chunked: false, chunkCount: 0, vectorizeEnqueueFailedAt: stale, isChunking: false, deletedAt: null };
    expect(matches(doc, filter)).toBe(false);
  });

  it('is disjoint from the un-chunked sweep: a stranded file matches only this filter', () => {
    const doc = {
      status: 'complete',
      chunked: true,
      chunkCount: 12,
      vectorizeEnqueueFailedAt: stale,
      isChunking: false,
      createdAt: stale,
      deletedAt: null,
      mimeType: 'application/pdf',
    };
    expect(matches(doc, buildFabFileChunkScanFilter(cutoff, undefined, { excludeConvergencePaused: false }))).toBe(
      false
    );
    expect(matches(doc, filter)).toBe(true);
  });
});

describe('production call sites pass the stale-claim cutoff', () => {
  // Source-shape guard, because the regression is silent: staleClaimBefore is optional (the arm is
  // opt-in), so dropping it type-checks, passes every other test, and just quietly turns the
  // recovery arm back off. The cron's call is covered behaviourally in dataLakeBatchReconcile.test.ts;
  // the self-host worker's call lives in chunkRescueSweep.ts (exported so it's independently
  // testable - see chunkRescueSweep.test.ts), so this is what watches its source shape.
  const sources = {
    'server/worker/chunkRescueSweep.ts': 'chunkRescueSweep.ts',
    'server/cron/dataLakeBatchReconcile.ts': '../cron/dataLakeBatchReconcile.ts',
  } as const;

  for (const [label, rel] of Object.entries(sources)) {
    it(`${label} calls buildStrandedVectorizeScanFilter with both cutoffs`, async () => {
      const src = await readFile(resolve(__dirname, rel), 'utf8');
      const call = src.match(/buildStrandedVectorizeScanFilter\(([^)]*)\)/);
      expect(call, 'call site vanished - move or delete this guard with it').not.toBeNull();
      expect(
        call![1]
          .split(',')
          .map(a => a.trim())
          .filter(Boolean)
      ).toHaveLength(2);
    });
  }
});
describe('buildChunkScanQueuePayload', () => {
  it('stamps convergence origin even when the file has no batch, so the kill switch can halt it', () => {
    // A paused file carries no batchId, and an un-stamped message reads as `user` work
    // (isConvergenceHalted fails soft) - which is how a paused file used to get re-chunked.
    expect(buildChunkScanQueuePayload({ fabFileId: 'ff1', userId: 'u1' })).toEqual({
      fabFileId: 'ff1',
      userId: 'u1',
      origin: 'convergence',
    });
  });

  it('sends no lakeId: a global sweep is halted by the platform switch, not a per-lake pause', () => {
    expect(buildChunkScanQueuePayload({ fabFileId: 'ff1', userId: 'u1' })).not.toHaveProperty('lakeId');
  });

  it('is halted by the shape the chunk handler actually parses, not just by carrying an origin key', () => {
    // Binds the stamp to the vocabulary the switch actually decides on, rather than to the string
    // 'convergence': a value outside WORK_ORIGINS parses to undefined, defaults to 'user' and stops
    // being haltable. The consumer's own suite (fabFileChunk.test.ts) covers the handler's half of
    // the contract; this covers the producer's.
    const parsed = z
      .object(provenancePayloadShape)
      .parse(buildChunkScanQueuePayload({ fabFileId: 'ff1', userId: 'u1' }));
    expect(shouldHaltConvergence(parsed.origin ?? 'user', true)).toBe(true);
  });
});
