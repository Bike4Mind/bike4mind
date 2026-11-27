import { describe, expect, it } from 'vitest';
import { StudioTimelineSchema, type StudioTimeline } from '@bike4mind/common';
import { ReorderError, reorderTrackClips } from './reorderClips';

const FILE = 'a'.repeat(24);

function timeline(): StudioTimeline {
  return StudioTimelineSchema.parse({
    version: 1,
    durationMs: 20_000,
    fps: 30,
    outputs: [{ id: 'o1', aspectRatio: '16:9', width: 1920, height: 1080 }],
    tracks: [
      {
        id: 'v1',
        kind: 'video',
        clips: [
          { id: 'a', startMs: 1_000, durationMs: 3_000, fileId: FILE, trimStartMs: 500 },
          { id: 'b', startMs: 5_000, durationMs: 2_000, fileId: FILE },
          { id: 'c', startMs: 8_000, durationMs: 4_000, fileId: FILE },
        ],
      },
      { id: 'vo', kind: 'voice', clips: [{ id: 'x', startMs: 1_000, durationMs: 2_000, fileId: FILE }] },
    ],
  });
}

const starts = (result: StudioTimeline, trackId = 'v1') =>
  result.tracks.find(track => track.id === trackId)?.clips.map(clip => [clip.id, clip.startMs]);

describe('reorderTrackClips', () => {
  it('lays the clips back to back in the new order from the earliest start', () => {
    const result = reorderTrackClips(timeline(), 'v1', ['c', 'a', 'b']);
    expect(starts(result)).toEqual([
      ['c', 1_000],
      ['a', 5_000],
      ['b', 8_000],
    ]);
  });

  it('keeps every other clip field and leaves other tracks alone', () => {
    const before = timeline();
    const result = reorderTrackClips(before, 'v1', ['b', 'a', 'c']);
    const a = result.tracks[0].clips.find(clip => clip.id === 'a');
    expect(a).toMatchObject({ durationMs: 3_000, trimStartMs: 500, fileId: FILE });
    expect(result.tracks[1]).toEqual(before.tracks[1]);
  });

  it('produces a timeline the server schema still accepts, ending no later than before', () => {
    const result = reorderTrackClips(timeline(), 'v1', ['c', 'b', 'a']);
    expect(StudioTimelineSchema.safeParse(result).success).toBe(true);
    const end = Math.max(...result.tracks[0].clips.map(clip => clip.startMs + clip.durationMs));
    expect(end).toBeLessThanOrEqual(12_000);
  });

  it('refuses an order that is not exactly the track clips (the timeline changed)', () => {
    expect(() => reorderTrackClips(timeline(), 'v1', ['a', 'b'])).toThrow(ReorderError);
    expect(() => reorderTrackClips(timeline(), 'v1', ['a', 'b', 'b'])).toThrow(ReorderError);
    expect(() => reorderTrackClips(timeline(), 'v1', ['a', 'b', 'z'])).toThrow(ReorderError);
  });

  it('refuses a missing or non-video track', () => {
    expect(() => reorderTrackClips(timeline(), 'nope', ['a'])).toThrow(ReorderError);
    expect(() => reorderTrackClips(timeline(), 'vo', ['x'])).toThrow(/Only video tracks/);
  });
});
