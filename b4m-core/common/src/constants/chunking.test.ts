import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHUNK_STALL_NOTICES,
  CHUNK_STALL_REASONS,
  CHUNKLESS_STALL_REASONS,
  LEGACY_CHUNK_STALL_NOTES,
  NO_EXTRACTABLE_TEXT_NOTICE,
  describePipelineStall,
  isChunkStalled,
  isChunklessStall,
} from './chunking';

// The reasons the #2016 migration backfilled from prose in `notes`, and therefore the only ones whose
// wording it is allowed to match. Any reason added after that migration ran was never stored in
// `notes` by anything, so no row carries its prose and its wording is free to change.
const MIGRATED_STALL_REASONS = ['vectorizePaused', 'rechunkPaused'] as const;

describe('isChunkStalled', () => {
  it('accepts every stall reason and nothing else', () => {
    for (const reason of CHUNK_STALL_REASONS) expect(isChunkStalled(reason)).toBe(true);
    for (const other of [null, undefined, '', 'paused', 'vectorized']) expect(isChunkStalled(other)).toBe(false);
  });
});

describe('isChunklessStall', () => {
  it('accepts both chunk-arm reasons and rejects the vectorize arm, which keeps its passages', () => {
    for (const reason of ['rechunkPaused', 'unchunkedPaused'] as const) {
      expect(isChunklessStall(reason)).toBe(true);
    }
    // The distinction the subset exists for: folding the arms together would grade a file that still
    // HAS its chunks as chunkless, in a Mongo `$in` that fails silently by selecting the wrong set.
    expect(isChunklessStall('vectorizePaused')).toBe(false);
    for (const other of [null, undefined, '', 'paused']) expect(isChunklessStall(other)).toBe(false);
  });

  it('is a subset of the full set, so every member is also a stall', () => {
    for (const reason of CHUNKLESS_STALL_REASONS) expect(isChunkStalled(reason)).toBe(true);
    expect(CHUNKLESS_STALL_REASONS.length).toBeLessThan(CHUNK_STALL_REASONS.length);
  });
});

describe('LEGACY_CHUNK_STALL_NOTES', () => {
  // Pinned to the migrated prose rather than every notice. A reason that postdates the migration has
  // no rows carrying its text, so admitting it here would only ever match an owner who happened to
  // type that sentence into `notes` - and read them as stalled.
  it('carries only the prose the migration actually backfilled', () => {
    expect([...LEGACY_CHUNK_STALL_NOTES].sort()).toEqual(
      MIGRATED_STALL_REASONS.map(reason => CHUNK_STALL_NOTICES[reason]).sort()
    );
  });
});

describe('describePipelineStall', () => {
  it('words each stall reason from the single source of prose', () => {
    for (const reason of CHUNK_STALL_REASONS) {
      expect(describePipelineStall({ chunkStallReason: reason })).toBe(CHUNK_STALL_NOTICES[reason]);
    }
  });

  it('falls back to the zero-chunk notice, and the stall reason wins when a file carries both', () => {
    expect(describePipelineStall({ noExtractableTextAt: new Date() })).toBe(NO_EXTRACTABLE_TEXT_NOTICE);
    expect(describePipelineStall({ chunkStallReason: 'rechunkPaused', noExtractableTextAt: new Date() })).toBe(
      CHUNK_STALL_NOTICES.rechunkPaused
    );
  });

  it('says nothing for a file the pipeline has not marked', () => {
    expect(describePipelineStall({})).toBeNull();
    expect(describePipelineStall({ chunkStallReason: null, noExtractableTextAt: null })).toBeNull();
    // An unknown reason is not a stall: a reader must never invent prose for a value it does not know.
    expect(describePipelineStall({ chunkStallReason: 'somethingElse' })).toBeNull();
  });
});

// The migration that backfilled these fields inlines the marker prose on purpose - a migration's
// predicate is a historical fact and must not move when someone rewords the owner-facing copy. That
// only stays safe while the constants below still SAY what the migration matched, so a reword has to
// land here first and be a deliberate act. Reading the migration source is the only thing that
// notices; a fixture would carry its own copy and drift green.
describe('the backfill migration still matches the current prose', () => {
  it('inlines the two migrated stall notices and the zero-chunk notice verbatim', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/scripts/migrate/migrations');
    const name = readdirSync(dir).find(f => f.endsWith('_split-chunk-stall-markers-off-notes.ts'));
    expect(name).toBeDefined();

    // Joined across the source's own line-wrapping concatenations, so a reflow is not a failure.
    const source = readFileSync(join(dir, name as string), 'utf8').replace(/' \+\s*\n\s*'/g, '');
    // MIGRATED_STALL_REASONS, not CHUNK_STALL_REASONS: the migration hardcodes exactly the two
    // literals it derived and must NOT gain a third, since no row ever carried a later reason's prose
    // in `notes`.
    for (const reason of MIGRATED_STALL_REASONS) {
      // The source escapes the em dash, so compare against the same escaped form.
      expect(source).toContain(CHUNK_STALL_NOTICES[reason].replace(/\u2014/g, '\\u2014'));
    }
    // The zero-chunk notice is matched by the migration's `$unset` arm byte-for-byte, so it needs the
    // same guard: a reword here that did not land there would strand the prose in `notes` forever.
    expect(source).toContain(NO_EXTRACTABLE_TEXT_NOTICE);
  });
});
