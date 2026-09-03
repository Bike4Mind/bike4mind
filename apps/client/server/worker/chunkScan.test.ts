import { describe, expect, it } from 'vitest';
import { buildConvergencePauseExclusion, buildFabFileChunkScanFilter } from './chunkScan';
import { CHUNK_STALL_NOTICES, CHUNK_STALL_REASONS, LEGACY_CHUNK_STALL_NOTES } from '@bike4mind/common';

// Minimal evaluator for the subset of Mongo operators the scan filter uses, so we can assert
// which documents the filter would (not) select without a live Mongo.
type Doc = Record<string, unknown>;
const MODELLED_OPERATORS = new Set(['$ne', '$lt', '$not', '$in', '$nin']);
const matches = (doc: Doc, filter: Record<string, unknown>): boolean =>
  Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return (cond as Record<string, unknown>[]).some(sub => matches(doc, sub));
    if (key === '$and') return (cond as Record<string, unknown>[]).every(sub => matches(doc, sub));
    // The pause exclusion is a top-level `$nor` (#2157) and nests a second one for the running-lake
    // exemption, so this has to recurse rather than negate a single level.
    if (key === '$nor') return !(cond as Record<string, unknown>[]).some(sub => matches(doc, sub));
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
  const filter = buildFabFileChunkScanFilter(cutoff, undefined, {
    convergencePause: { platformPaused: false, paused: [], running: [] },
  });

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
    // Known one-way door, documented on buildChunkRescueMessage: a media file reaches this filter
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

describe('buildFabFileChunkScanFilter - convergence-paused exclusion (#2120/#2157)', () => {
  const cutoff = new Date('2026-01-01T00:00:00Z');
  const old = new Date('2025-12-31T00:00:00Z');
  const stalled = (reason: string, extra: Record<string, unknown> = {}) => ({
    status: 'complete',
    chunkCount: 0,
    isChunking: false,
    createdAt: old,
    deletedAt: null,
    noExtractableTextAt: null,
    chunkStallReason: reason,
    ...extra,
  });

  // Stand-in membership predicates. The REAL ones come from buildDataLakeMembershipFilter and use a
  // dotted `tags.name` path plus a `$regex`, neither of which this evaluator models - so their
  // composition with the clause below is pinned against a live server in chunkScan.e2e.test.ts, and
  // what these cases pin is which SIDE of the override set gates the exclusion.
  const inLake = (id: string) => ({ lakeMarker: id });

  describe('while the platform switch is ON', () => {
    const filter = (running: Record<string, unknown>[] = []) =>
      buildFabFileChunkScanFilter(cutoff, undefined, {
        convergencePause: { platformPaused: true, paused: [], running },
      });

    it.each([
      ['the chunk-handler reason', 'rechunkPaused'],
      ['the vectorize reason', 'vectorizePaused'],
    ])('skips a stalled file - %s', (_label, reason) => {
      // A stalled file matches every OTHER clause (the reset zeroed chunkCount, the pause writes no
      // error), so without the exclusion it is re-selected every pass and consumes the rescue cap,
      // starving genuine lost-webhook candidates while the sweep still reports a healthy count.
      expect(matches(stalled(reason), filter())).toBe(false);
    });

    it('still selects a file with no stall reason at all', () => {
      const { chunkStallReason, ...noReason } = stalled('rechunkPaused');
      expect(matches(noReason, filter())).toBe(true);
    });

    it('still selects a file whose stall reason is explicitly null', () => {
      // `$in` does not match a null/missing field, so the $nor lets it through. Pinned because
      // getting this wrong would silently drop every un-stalled file from the sweep - the opposite,
      // and far worse, failure than the churn this exclusion fixes.
      expect(matches(stalled('rechunkPaused', { chunkStallReason: null }), filter())).toBe(true);
    });

    it('still excludes a PRE-MIGRATION row carrying the reason as prose in notes', () => {
      // #2016's migration and this code do not deploy atomically; the legacy arm is what covers the
      // window. Dropping it would re-admit every not-yet-migrated paused file to the sweep.
      const legacy = { ...stalled('rechunkPaused'), chunkStallReason: null, notes: CHUNK_STALL_NOTICES.rechunkPaused };
      expect(matches(legacy, filter())).toBe(false);
    });

    it('EXEMPTS a stalled file whose lake overrides the platform pause back OFF (#2157)', () => {
      // The scoped direction the platform-only exclusion could not express: an operator paused
      // everything but told this one lake to keep running, so its files must keep sweeping.
      expect(matches(stalled('rechunkPaused', inLake('l1')), filter([inLake('l1')]))).toBe(true);
    });

    it('does not exempt a stalled file belonging to a DIFFERENT running lake', () => {
      expect(matches(stalled('rechunkPaused', inLake('l2')), filter([inLake('l1')]))).toBe(false);
    });
  });

  describe('while the platform switch is OFF', () => {
    const filter = (pausedLakes: Record<string, unknown>[] = []) =>
      buildFabFileChunkScanFilter(cutoff, undefined, {
        convergencePause: { platformPaused: false, paused: pausedLakes, running: [] },
      });

    it.each([
      ['the chunk-handler reason', 'rechunkPaused'],
      ['the vectorize reason', 'vectorizePaused'],
    ])('SELECTS a stalled file so it is rebuilt - %s', (_label, reason) => {
      // The regression this conditionality prevents. This sweep is the only AUTOMATIC exit a stalled
      // file has - every other recovery path needs a human to start it: the two lake-scoped ones
      // (findConvergencePausedFilesByScope, and convergence's own paused-member arm) plus the
      // per-file POST /api/files/reprocess, which is NOT lake-scoped and does reach a file outside
      // every lake. None of them fires on its own, which is the property that matters here.
      // Excluding unconditionally would break the stall notice's user-visible promise that passages
      // are "rebuilt when convergence resumes".
      expect(matches(stalled(reason), filter())).toBe(true);
    });

    it('EXCLUDES a stalled file whose own lake is paused by a scoped override (#2157)', () => {
      // The leak this ticket is about, from the selection side: with the platform switch off, a
      // per-lake pause used to be invisible here, so that lake's stalled files were swept back in and
      // spent the rescue cap on every pass.
      expect(matches(stalled('rechunkPaused', inLake('l1')), filter([inLake('l1')]))).toBe(false);
    });

    it('leaves a stalled file in an UNRELATED lake selectable', () => {
      expect(matches(stalled('rechunkPaused', inLake('l2')), filter([inLake('l1')]))).toBe(true);
    });

    it('leaves an un-stalled file in a paused lake selectable, so the handler can mark it', () => {
      // Only STALLED files are excluded. An un-stalled file in a paused lake still has to reach the
      // handler, which is what writes the stall reason - excluding it here would leave the state
      // invisible, the exact failure the marker exists to prevent. This is also what the $and (rather
      // than a spread) protects: a clobbered stall test would exclude every member of a paused lake.
      const { chunkStallReason, ...unstalled } = stalled('rechunkPaused', inLake('l1'));
      expect(matches(unstalled, filter([inLake('l1')]))).toBe(true);
    });
  });
});

describe('buildFabFileChunkScanFilter - stale-claim recovery arm', () => {
  const cutoff = new Date('2026-01-01T00:00:00Z');
  const staleClaimBefore = new Date('2026-01-01T00:00:00Z'); // a claim older than this is stranded
  const old = new Date('2025-12-31T00:00:00Z'); // before both cutoffs
  const filter = buildFabFileChunkScanFilter(cutoff, staleClaimBefore, {
    convergencePause: { platformPaused: false, paused: [], running: [] },
  });
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

describe('buildConvergencePauseExclusion (the four platform x override shapes)', () => {
  // From the shared constants, never a hand-written pair: the point of CHUNK_STALL_REASONS is that
  // this query and `isChunkStalled` cannot drift, and re-listing them here would let the test agree
  // with a stale copy.
  const STALLED = {
    $or: [{ chunkStallReason: { $in: [...CHUNK_STALL_REASONS] } }, { notes: { $in: [...LEGACY_CHUNK_STALL_NOTES] } }],
  };
  const lakeA = { 'tags.name': 'datalake:a' };

  it('platform OFF + no override: NOTHING is excluded, so no clause is emitted', () => {
    // Emitting the stall test here would be the pre-#2120 regression in reverse: it would strand
    // every paused file with no automatic rebuild.
    expect(buildConvergencePauseExclusion({ platformPaused: false, paused: [], running: [] })).toBeUndefined();
  });

  it('platform ON + no override: every stalled file is excluded, the #2120 shape', () => {
    expect(buildConvergencePauseExclusion({ platformPaused: true, paused: [], running: [] })).toEqual(STALLED);
  });

  it("platform OFF + a paused lake: only that lake's stalled members are excluded", () => {
    // ANDed, not spread: STALLED already owns a top-level `$or`, and so does the lake arm - as
    // siblings the second would silently win and the stall test would vanish entirely.
    expect(buildConvergencePauseExclusion({ platformPaused: false, paused: [lakeA], running: [] })).toEqual({
      $and: [STALLED, { $or: [lakeA] }],
    });
  });

  it("platform ON + a running lake: stalled files are excluded EXCEPT that lake's members", () => {
    expect(buildConvergencePauseExclusion({ platformPaused: true, paused: [], running: [lakeA] })).toEqual({
      $and: [STALLED, { $nor: [lakeA] }],
    });
  });

  it('ignores the arm the platform direction does not use', () => {
    // Deliberate, and why the two arms are separate fields: with the switch ON, a lake that merely
    // agrees it is paused adds nothing (it is already covered), and enumerating every such lake would
    // put an unbounded `$or` in the query. Only the DISAGREEING side is ever material.
    expect(buildConvergencePauseExclusion({ platformPaused: true, paused: [lakeA], running: [] })).toEqual(STALLED);
    expect(buildConvergencePauseExclusion({ platformPaused: false, paused: [], running: [lakeA] })).toBeUndefined();
  });
});
