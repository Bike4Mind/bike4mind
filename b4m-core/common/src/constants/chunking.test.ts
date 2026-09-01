import { describe, expect, it } from 'vitest';
import {
  CONVERGENCE_PAUSED_CHUNK_NOTE,
  CONVERGENCE_PAUSED_CHUNK_NOTES,
  CONVERGENCE_PAUSED_NOTE,
  CONVERGENCE_PAUSED_NOTES,
  CONVERGENCE_PAUSED_UNCHUNKED_NOTE,
  isConvergenceChunkPausedNote,
  isConvergencePausedNote,
} from './chunking';

// These strings are a datastore key: they are stored verbatim in FabFile.notes and matched by exact
// $in queries. Every OTHER test imports the constant on both sides of its comparison, so a reword
// moves both and nothing goes red - while every row already written is orphaned. These assertions
// are deliberately written against literal phrases for that reason.
describe('convergence paused markers', () => {
  it('says "removed" only on the marker that means passages were removed', () => {
    expect(CONVERGENCE_PAUSED_CHUNK_NOTE).toContain('were removed');
    // The reported bug: a rescue sweep never removes anything, so telling its files their passages
    // were removed is a false statement shown to the file's owner.
    expect(CONVERGENCE_PAUSED_UNCHUNKED_NOTE).not.toContain('were removed');
    expect(CONVERGENCE_PAUSED_UNCHUNKED_NOTE).toContain('no passages yet');
  });

  it('keeps the three markers distinct - two that collide would silently merge two states', () => {
    expect(new Set(CONVERGENCE_PAUSED_NOTES).size).toBe(3);
  });

  describe('which predicate answers which question', () => {
    it('the chunk arm is about having NO PASSAGES, so it excludes the vectorize marker', () => {
      expect(isConvergenceChunkPausedNote(CONVERGENCE_PAUSED_CHUNK_NOTE)).toBe(true);
      expect(isConvergenceChunkPausedNote(CONVERGENCE_PAUSED_UNCHUNKED_NOTE)).toBe(true);
      // A vectorize-paused file still has its chunks, so grading it as chunkless would be wrong.
      expect(isConvergenceChunkPausedNote(CONVERGENCE_PAUSED_NOTE)).toBe(false);
    });

    it('the wide predicate is about being STALLED AT ALL, so it admits every marker', () => {
      for (const note of CONVERGENCE_PAUSED_NOTES) expect(isConvergencePausedNote(note)).toBe(true);
    });

    it('neither matches an ordinary user note or an absent one', () => {
      expect(isConvergencePausedNote('quarterly report for the board deck')).toBe(false);
      expect(isConvergencePausedNote(null)).toBe(false);
      expect(isConvergencePausedNote(undefined)).toBe(false);
      expect(isConvergenceChunkPausedNote('quarterly report for the board deck')).toBe(false);
      expect(isConvergenceChunkPausedNote(null)).toBe(false);
    });
  });

  it('keeps every chunk-arm marker inside the wide set, so a chunk-arm file is never invisible', () => {
    for (const note of CONVERGENCE_PAUSED_CHUNK_NOTES) expect(isConvergencePausedNote(note)).toBe(true);
  });
});
