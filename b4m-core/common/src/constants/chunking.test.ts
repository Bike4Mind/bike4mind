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
