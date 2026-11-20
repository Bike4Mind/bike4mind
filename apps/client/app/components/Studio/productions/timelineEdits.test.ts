import { describe, expect, it } from 'vitest';
import { defaultStudioTimeline, validateStudioTimeline, type StudioTimeline } from '@bike4mind/common';
import {
  MIN_CLIP_MS,
  addCaptionClip,
  addMediaClip,
  findClip,
  moveClip,
  removeClip,
  setClipCrop,
  toggleOutput,
  trimClipEnd,
  trimClipStart,
  updateClip,
} from './timelineEdits';

const FILE_A = 'a'.repeat(24);
const FILE_B = 'b'.repeat(24);

// Starts with no tracks, so each edit's lane is the only one.
const empty = (): StudioTimeline => ({ ...defaultStudioTimeline('ad_campaign'), tracks: [] });

describe('addMediaClip', () => {
  it('creates the track on first use and appends later clips after the last one', () => {
    const first = addMediaClip(empty(), 'music', { fileId: FILE_A, durationMs: 4_000 });
    const second = addMediaClip(first.timeline, 'music', { fileId: FILE_B, durationMs: 3_000 });

    const tracks = second.timeline.tracks.filter(track => track.kind === 'music');
    expect(tracks).toHaveLength(1);
    expect(tracks[0].clips.map(clip => [clip.startMs, clip.durationMs])).toEqual([
      [0, 4_000],
      [4_000, 3_000],
    ]);
    expect(validateStudioTimeline(second.timeline)).toEqual([]);
  });

  it('gives a video clip a fit and an audio clip none', () => {
    const video = addMediaClip(empty(), 'video', { fileId: FILE_A, durationMs: 1_000 });
    const voice = addMediaClip(video.timeline, 'voice', { fileId: FILE_A, durationMs: 1_000 });
    expect(findClip(voice.timeline, video.clipId)?.clip).toMatchObject({ fit: 'cover' });
    expect(findClip(voice.timeline, voice.clipId)?.clip).not.toHaveProperty('fit');
  });

  it('shortens a clip to the room left and refuses a full track', () => {
    const long = addMediaClip(empty(), 'sfx', { fileId: FILE_A, durationMs: 60_000 });
    expect(findClip(long.timeline, long.clipId)?.clip.durationMs).toBe(15_000);
    expect(() => addMediaClip(long.timeline, 'sfx', { fileId: FILE_B, durationMs: 1_000 })).toThrow(/full/);
  });

  it('mints ids the spec accepts', () => {
    const { timeline, clipId } = addMediaClip(empty(), 'video', { fileId: FILE_A, durationMs: 1_000 });
    expect(clipId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(timeline.tracks[0].id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe('clip edits', () => {
  const withVideo = () => addMediaClip(empty(), 'video', { fileId: FILE_A, durationMs: 4_000 });

  it('moves a clip and keeps it inside the timeline', () => {
    const { timeline, clipId } = withVideo();
    expect(findClip(moveClip(timeline, clipId, 2_000), clipId)?.clip.startMs).toBe(2_000);
    expect(findClip(moveClip(timeline, clipId, 99_000), clipId)?.clip.startMs).toBe(11_000);
    expect(findClip(moveClip(timeline, clipId, -50), clipId)?.clip.startMs).toBe(0);
  });

  it('trims the start without sliding the frames under the clip', () => {
    const { timeline, clipId } = withVideo();
    const moved = moveClip(timeline, clipId, 1_000);
    const trimmed = findClip(trimClipStart(moved, clipId, 1_500), clipId)?.clip;
    expect(trimmed).toMatchObject({ startMs: 1_500, durationMs: 3_500, trimStartMs: 500 });
    // Cannot reach before the source's first frame.
    expect(findClip(trimClipStart(moved, clipId, 0), clipId)?.clip).toMatchObject({ startMs: 1_000, trimStartMs: 0 });
  });

  it('trims the end and keeps a minimum length', () => {
    const { timeline, clipId } = withVideo();
    expect(findClip(trimClipEnd(timeline, clipId, 2_500), clipId)?.clip.durationMs).toBe(2_500);
    expect(findClip(trimClipEnd(timeline, clipId, 0), clipId)?.clip.durationMs).toBe(MIN_CLIP_MS);
  });

  it('updates only the fields the clip kind has', () => {
    const { timeline, clipId } = withVideo();
    const updated = findClip(updateClip(timeline, clipId, { volume: 0.5, text: 'ignored' }), clipId)?.clip;
    expect(updated).toMatchObject({ volume: 0.5 });
    expect(updated).not.toHaveProperty('text');
  });

  it('removes a clip and leaves the track', () => {
    const { timeline, clipId } = withVideo();
    const removed = removeClip(timeline, clipId);
    expect(findClip(removed, clipId)).toBeUndefined();
    expect(removed.tracks).toHaveLength(1);
  });

  it('adds a caption with the spec defaults', () => {
    const { timeline, clipId } = addCaptionClip(empty(), 'Hello');
    expect(findClip(timeline, clipId)?.clip).toMatchObject({ text: 'Hello', startMs: 0, durationMs: 3_000 });
    expect(validateStudioTimeline(timeline)).toEqual([]);
  });

  it('lets an overlap through for the validator to flag', () => {
    const first = addMediaClip(empty(), 'video', { fileId: FILE_A, durationMs: 4_000 });
    const second = addMediaClip(first.timeline, 'video', { fileId: FILE_B, durationMs: 4_000 });
    const overlapped = moveClip(second.timeline, second.clipId, 2_000);
    expect(validateStudioTimeline(overlapped).map(issue => issue.code)).toContain('clip_overlap');
  });
});

describe('toggleOutput', () => {
  it('adds a shape at its default size and removes it again, never the last one', () => {
    const added = toggleOutput(empty(), '4:5');
    expect(added.outputs.at(-1)).toMatchObject({ aspectRatio: '4:5', width: 1080, height: 1350 });
    expect(validateStudioTimeline(added)).toEqual([]);
    expect(toggleOutput(added, '4:5').outputs.map(output => output.aspectRatio)).toEqual(['16:9', '9:16', '1:1']);

    const single = defaultStudioTimeline('blank');
    expect(toggleOutput(single, '16:9')).toBe(single);
  });
});

describe('setClipCrop', () => {
  const rect = { x: 0.1, y: 0, width: 0.316406, height: 1 };
  const withVideo = () => addMediaClip(empty(), 'video', { fileId: FILE_A, durationMs: 4_000 });

  it('sets the rect for one aspect ratio and keeps the others', () => {
    const { timeline, clipId } = withVideo();
    const square = { x: 0.4, y: 0, width: 0.5625, height: 1 };
    const next = setClipCrop(setClipCrop(timeline, clipId, '9:16', rect), clipId, '1:1', square);
    expect(findClip(next, clipId)?.clip).toMatchObject({ crop: { '9:16': rect, '1:1': square } });
  });

  it('drops the crop field once the last rect is cleared', () => {
    const { timeline, clipId } = withVideo();
    const cleared = setClipCrop(setClipCrop(timeline, clipId, '9:16', rect), clipId, '9:16', undefined);
    expect(findClip(cleared, clipId)?.clip).not.toHaveProperty('crop');
  });

  it('ignores a clip that is not on a video track', () => {
    const { timeline, clipId } = addMediaClip(empty(), 'music', { fileId: FILE_A, durationMs: 4_000 });
    expect(setClipCrop(timeline, clipId, '9:16', rect)).toBe(timeline);
  });
});
