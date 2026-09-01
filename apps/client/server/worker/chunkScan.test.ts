import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CONVERGENCE_PAUSED_CHUNK_NOTE, CONVERGENCE_PAUSED_CHUNK_NOTES } from '@bike4mind/common';
import { provenancePayloadShape, shouldHaltConvergence } from '@server/queueHandlers/convergenceProvenance';
import { buildChunkScanQueuePayload, buildFabFileChunkScanFilter, NO_EXTRACTABLE_TEXT_NOTE_PREFIX } from './chunkScan';

// Minimal evaluator for the subset of Mongo operators the scan filter uses, so we can assert
// which documents the filter would (not) select without a live Mongo.
type Doc = Record<string, unknown>;
const matches = (doc: Doc, filter: Record<string, unknown>): boolean =>
  Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return (cond as Record<string, unknown>[]).some(sub => matches(doc, sub));
    if (key === '$and') return (cond as Record<string, unknown>[]).every(sub => matches(doc, sub));
    const value = doc[key];
    if (cond === null) return value === null || value === undefined;
    if (cond && typeof cond === 'object' && '$ne' in cond) {
      const ne = (cond as { $ne: unknown }).$ne;
      // Mongo treats a MISSING field as null, so `{$ne: null}` does not match one - which is the
      // whole reason the stamped-file arm below can be written as `$ne: null` without matching every
      // legacy row. Other `$ne` values (e.g. `isChunking: {$ne: true}`) do match a missing field.
      if (ne === null) return value !== null && value !== undefined;
      return value !== ne;
    }
    if (cond && typeof cond === 'object' && '$lt' in cond) return (value as Date) < (cond as { $lt: Date }).$lt;
    if (cond instanceof RegExp) return typeof value === 'string' && cond.test(value);
    if (cond && typeof cond === 'object' && '$not' in cond)
      return !matches({ [key]: value }, { [key]: (cond as { $not: unknown }).$not });
    // Mongo $in with null also matches a missing field.
    if (cond && typeof cond === 'object' && '$in' in cond)
      return (cond as { $in: unknown[] }).$in.some(v =>
        v === null ? value === null || value === undefined : value === v
      );
    return value === cond;
  });

describe('buildFabFileChunkScanFilter', () => {
  const cutoff = new Date('2026-01-01T00:00:00Z');
  const old = new Date('2025-12-31T00:00:00Z'); // before cutoff
  const filter = buildFabFileChunkScanFilter(cutoff);

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
      notes: `${NO_EXTRACTABLE_TEXT_NOTE_PREFIX} - re-process or re-upload (e.g. image-only or unsupported content).`,
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

  // The exact document the halt branch leaves behind: markConvergencePaused writes the marker and
  // nulls chunkRebuildRequestedAt in one statement, and nothing else about the file changes.
  const halted = (notes: string, mimeType = 'application/pdf') => ({
    status: 'complete',
    chunkCount: 0,
    isChunking: false,
    createdAt: old,
    deletedAt: null,
    error: null,
    mimeType,
    chunkRebuildRequestedAt: null,
    notes,
  });

  it.each(CONVERGENCE_PAUSED_CHUNK_NOTES)(
    'still selects a file the kill switch paused - re-selection is the only way it ever resumes (%s)',
    note => {
      // Neither paused marker is excluded here, deliberately: nothing else re-drives a paused file,
      // so adding them to the notes exclusion (tempting, to stop the re-sweep churn) strands every
      // paused file permanently. Any change that does exclude them has to bring a resume path.
      expect(matches(halted(note), filter)).toBe(true);
    }
  );

  it('KNOWN STRAND: does NOT re-select a paused MEDIA file - the halt write destroyed its only selection door', () => {
    // Known one-way door, documented on buildChunkScanQueuePayload: a media file reaches this filter
    // only through chunkRebuildRequestedAt, and the halt write nulls it in the same statement as the
    // marker. Asserted rather than left implicit so the strand is visible to whoever closes it.
    expect(matches(halted(CONVERGENCE_PAUSED_CHUNK_NOTE, 'audio/mpeg'), filter)).toBe(false);
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
    expect(matches({ ...stamped, notes: `${NO_EXTRACTABLE_TEXT_NOTE_PREFIX}: scanned image` }, filter)).toBe(false);
  });
});

describe('buildFabFileChunkScanFilter - stale-claim recovery arm', () => {
  const cutoff = new Date('2026-01-01T00:00:00Z');
  const staleClaimBefore = new Date('2026-01-01T00:00:00Z'); // a claim older than this is stranded
  const old = new Date('2025-12-31T00:00:00Z'); // before both cutoffs
  const filter = buildFabFileChunkScanFilter(cutoff, staleClaimBefore);
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
    // otherwise stay claimed and unrescuable forever. The sweep re-claims it via a CAS before
    // enqueue, so a still-running (not crashed) file isn't double-processed.
    expect(matches({ ...base, isChunking: true, chunkClaimedAt: null }, filter)).toBe(true);
    expect(matches({ ...base, isChunking: true }, filter)).toBe(true);
  });
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
