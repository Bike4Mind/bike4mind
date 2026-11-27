import type { StudioTimeline } from '@bike4mind/common';

export class ReorderError extends Error {}

/**
 * Put one track's clips in `clipIds` order, back to back from where the earliest clip started.
 * Durations, trims and every other field are kept; gaps between clips close up. Since clips on a
 * track never overlap, the packed track ends no later than the original did, so it still fits the
 * timeline's duration. Other tracks are left where they are.
 *
 * Throws when `clipIds` is not exactly the track's clips: the timeline changed since the caller
 * read it, and guessing at the order would overwrite someone's edit.
 */
export function reorderTrackClips(
  timeline: StudioTimeline,
  trackId: string,
  clipIds: readonly string[]
): StudioTimeline {
  const track = timeline.tracks.find(candidate => candidate.id === trackId);
  if (!track) throw new ReorderError('That track is no longer in this production. Reload it and try again.');
  if (track.kind !== 'video') throw new ReorderError('Only video tracks can be reordered here.');

  const byId = new Map(track.clips.map(clip => [clip.id, clip]));
  const sameSet =
    clipIds.length === byId.size && new Set(clipIds).size === clipIds.length && clipIds.every(id => byId.has(id));
  if (!sameSet) throw new ReorderError('This production changed since it was opened. Reload it and try again.');
  if (track.clips.length === 0) return timeline;

  let cursor = Math.min(...track.clips.map(clip => clip.startMs));
  const clips = clipIds.map(id => {
    const clip = byId.get(id);
    if (!clip) throw new ReorderError('This production changed since it was opened.');
    const placed = { ...clip, startMs: cursor };
    cursor += clip.durationMs;
    return placed;
  });
  return {
    ...timeline,
    tracks: timeline.tracks.map(candidate => (candidate.id === trackId ? { ...track, clips } : candidate)),
  };
}
