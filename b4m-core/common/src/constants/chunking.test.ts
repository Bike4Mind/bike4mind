import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHUNK_STALL_NOTICES,
  CHUNK_STALL_REASONS,
  NO_EXTRACTABLE_TEXT_NOTICE,
  describePipelineStall,
  isChunkStalled,
} from './chunking';

describe('isChunkStalled', () => {
  it('accepts every stall reason and nothing else', () => {
    for (const reason of CHUNK_STALL_REASONS) expect(isChunkStalled(reason)).toBe(true);
    for (const other of [null, undefined, '', 'paused', 'vectorized']) expect(isChunkStalled(other)).toBe(false);
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
  it('inlines both stall notices and the zero-chunk notice verbatim', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/scripts/migrate/migrations');
    const name = readdirSync(dir).find(f => f.endsWith('_split-chunk-stall-markers-off-notes.ts'));
    expect(name).toBeDefined();

    // Joined across the source's own line-wrapping concatenations, so a reflow is not a failure.
    const source = readFileSync(join(dir, name as string), 'utf8').replace(/' \+\s*\n\s*'/g, '');
    for (const reason of CHUNK_STALL_REASONS) {
      // The source escapes the em dash, so compare against the same escaped form.
      expect(source).toContain(CHUNK_STALL_NOTICES[reason].replace(/\u2014/g, '\\u2014'));
    }
    // The zero-chunk notice is matched by the migration's `$unset` arm byte-for-byte, so it needs the
    // same guard: a reword here that did not land there would strand the prose in `notes` forever.
    expect(source).toContain(NO_EXTRACTABLE_TEXT_NOTICE);
  });
});
