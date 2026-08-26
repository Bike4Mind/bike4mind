import { describe, expect, it } from 'vitest';
import { buildFabFileChunkScanFilter, NO_EXTRACTABLE_TEXT_NOTE_PREFIX } from './chunkScan';
import { CONVERGENCE_PAUSED_NOTE, CONVERGENCE_PAUSED_CHUNK_NOTE } from '@bike4mind/common';

// Minimal evaluator for the subset of Mongo operators the scan filter uses, so we can assert
// which documents the filter would (not) select without a live Mongo.
type Doc = Record<string, unknown>;
const matches = (doc: Doc, filter: Record<string, unknown>): boolean =>
  Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return (cond as Record<string, unknown>[]).some(sub => matches(doc, sub));
    if (key === '$and') return (cond as Record<string, unknown>[]).every(sub => matches(doc, sub));
    const value = doc[key];
    if (cond === null) return value === null || value === undefined;
    if (cond instanceof RegExp) return typeof value === 'string' && cond.test(value);
    if (cond && typeof cond === 'object') {
      // EVERY operator in the condition, not just the first one found: `notes` carries both a
      // `$not` and a `$nin`, and a first-match-wins evaluator would silently ignore one of them -
      // passing the tests while the real query behaved differently.
      const ops = cond as Record<string, unknown>;
      const checks: boolean[] = [];
      if ('$ne' in ops) {
        const ne = ops.$ne;
        // Mongo treats a MISSING field as null, so `{$ne: null}` does not match one - which is the
        // whole reason the stamped-file arm below can be written as `$ne: null` without matching every
        // legacy row. Other `$ne` values (e.g. `isChunking: {$ne: true}`) do match a missing field.
        checks.push(ne === null ? value !== null && value !== undefined : value !== ne);
      }
      if ('$lt' in ops) checks.push((value as Date) < (ops.$lt as Date));
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
      if (checks.length > 0) return checks.every(Boolean);
    }
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

describe('buildFabFileChunkScanFilter - convergence-paused exclusion (#2120)', () => {
  const cutoff = new Date('2026-01-01T00:00:00Z');
  const old = new Date('2025-12-31T00:00:00Z');
  // chunkRebuildRequestedAt is left UNSET rather than null: only the chunk-handler path clears it,
  // the vectorize path (fabFileVectorize.ts) writes its marker without touching it, so a fixture
  // that pins it to null would only reproduce one of the two marker paths.
  const paused = (note: string) => ({
    status: 'complete',
    chunkCount: 0,
    isChunking: false,
    createdAt: old,
    deletedAt: null,
    notes: note,
  });

  describe('while the kill switch is ON', () => {
    const filter = buildFabFileChunkScanFilter(cutoff, undefined, { excludeConvergencePaused: true });

    it.each([
      ['the chunk-handler marker', CONVERGENCE_PAUSED_CHUNK_NOTE],
      ['the vectorize marker', CONVERGENCE_PAUSED_NOTE],
    ])('skips a paused file - %s', (_label, note) => {
      // A paused file matches every OTHER clause (the reset zeroed chunkCount, the pause writes no
      // error), so without the exclusion it is re-selected every pass and consumes the rescue cap,
      // starving genuine lost-webhook candidates while the sweep still reports a healthy count.
      expect(matches(paused(note), filter)).toBe(false);
    });

    it('still selects an ordinary un-chunked file, so the exclusion is not over-broad', () => {
      expect(matches({ ...paused('quarterly report for the board deck') }, filter)).toBe(true);
    });

    it('still selects a file with no notes at all', () => {
      const { notes, ...noNotes } = paused('x');
      expect(matches(noNotes, filter)).toBe(true);
    });

    it('still selects a file whose notes are explicitly null', () => {
      // $nin matches a null/missing field (null is not in a list of note strings). Pinned because
      // getting this wrong would silently drop every un-noted file from the sweep - the opposite,
      // and far worse, failure than the churn this exclusion fixes.
      expect(matches({ ...paused('x'), notes: null }, filter)).toBe(true);
    });
  });

  describe('while the kill switch is OFF', () => {
    const filter = buildFabFileChunkScanFilter(cutoff, undefined, { excludeConvergencePaused: false });

    it.each([
      ['the chunk-handler marker', CONVERGENCE_PAUSED_CHUNK_NOTE],
      ['the vectorize marker', CONVERGENCE_PAUSED_NOTE],
    ])('SELECTS a paused file so it is rebuilt - %s', (_label, note) => {
      // The regression this conditionality prevents. This sweep is the only AUTOMATIC exit a paused
      // file has: the other two recovery paths are human-driven and lake-scoped, so neither reaches a
      // file outside every lake - exactly what the sweep exists to catch. And the re-enqueue really
      // does rebuild it: a batchId-less file is sent without an `origin`, and isConvergenceHalted
      // defaults a missing origin to 'user' and returns false, so it is genuinely re-chunked rather
      // than bounced. Excluding it unconditionally would break the marker's user-visible promise
      // that passages are "rebuilt when convergence resumes".
      expect(matches(paused(note), filter)).toBe(true);
    });

    it('still excludes the no-extractable-text note, which is terminal either way', () => {
      expect(matches(paused(`${NO_EXTRACTABLE_TEXT_NOTE_PREFIX}: scanned image`), filter)).toBe(false);
    });
  });

  it('defaults to NOT excluding when no options are passed', () => {
    // The safer default: a caller that forgets the flag keeps the pre-existing rescue behaviour
    // rather than silently stranding paused files.
    const filter = buildFabFileChunkScanFilter(cutoff);
    expect(matches(paused(CONVERGENCE_PAUSED_CHUNK_NOTE), filter)).toBe(true);
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
