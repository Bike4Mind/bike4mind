import {
  STUDIO_OUTPUT_DEFAULT_SIZES,
  type StudioAudioClip,
  type StudioCropRect,
  type StudioCaptionClip,
  type StudioOutputAspectRatio,
  type StudioTimeline,
  type StudioTimelineClip,
  type StudioTimelineTrack,
  type StudioTimelineTrackKind,
  type StudioVideoClip,
  randomUuid,
} from '@bike4mind/common';

/**
 * Pure edits on a timeline spec. Each returns a new timeline and never validates: the editor runs the shared
 * validateStudioTimeline over the result, so an edit that produces an overlap is shown as an issue, not refused.
 */

export type StudioMediaTrackKind = Exclude<StudioTimelineTrackKind, 'captions'>;

/** A clip of a known track, found by id, with where it sits. */
export type LocatedClip = { track: StudioTimelineTrack; clip: StudioTimelineClip };

export const DEFAULT_IMAGE_CLIP_MS = 3_000;
export const DEFAULT_CAPTION_CLIP_MS = 3_000;
export const MIN_CLIP_MS = 100;

/** Ids match the spec's `^[A-Za-z0-9_-]{1,64}$`; a UUID is 36 characters, so the prefix keeps it under 64. */
export const mintTimelineId = (prefix: 'track' | 'clip' | 'out'): string => `${prefix}-${randomUuid()}`;

const replaceTrack = (timeline: StudioTimeline, track: StudioTimelineTrack): StudioTimeline => ({
  ...timeline,
  tracks: timeline.tracks.map(existing => (existing.id === track.id ? track : existing)),
});

/** The first track of `kind`, adding an empty one when the timeline has none yet. */
const ensureTrack = (
  timeline: StudioTimeline,
  kind: StudioTimelineTrackKind
): { timeline: StudioTimeline; track: StudioTimelineTrack } => {
  const existing = timeline.tracks.find(track => track.kind === kind);
  if (existing) return { timeline, track: existing };
  const track = { id: mintTimelineId('track'), kind, enabled: true, clips: [] } as StudioTimelineTrack;
  return { timeline: { ...timeline, tracks: [...timeline.tracks, track] }, track };
};

const trackEndMs = (track: StudioTimelineTrack): number =>
  track.clips.reduce((end, clip) => Math.max(end, clip.startMs + clip.durationMs), 0);

/** Where a new clip lands on a track: after its last clip, sized to fit what is left of the timeline. */
const nextSlot = (timeline: StudioTimeline, track: StudioTimelineTrack, wantedMs: number) => {
  const startMs = trackEndMs(track);
  const durationMs = Math.min(Math.round(wantedMs), timeline.durationMs - startMs);
  if (durationMs < MIN_CLIP_MS) {
    throw new Error('This track is full. Make the production longer or shorten a clip first.');
  }
  return { startMs, durationMs };
};

export type NewMediaClip = { fileId: string; durationMs: number };

/** Appends a file to the first track of `kind`, after its last clip. Throws when the track has no room left. */
export const addMediaClip = (
  timeline: StudioTimeline,
  kind: StudioMediaTrackKind,
  { fileId, durationMs }: NewMediaClip
): { timeline: StudioTimeline; clipId: string } => {
  const ensured = ensureTrack(timeline, kind);
  const slot = nextSlot(ensured.timeline, ensured.track, durationMs);
  const audio: StudioAudioClip = {
    id: mintTimelineId('clip'),
    fileId,
    trimStartMs: 0,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    ...slot,
  };
  const clip: StudioVideoClip | StudioAudioClip = kind === 'video' ? { ...audio, fit: 'cover' } : audio;
  const track = { ...ensured.track, clips: [...ensured.track.clips, clip] } as StudioTimelineTrack;
  return { timeline: replaceTrack(ensured.timeline, track), clipId: clip.id };
};

export const addCaptionClip = (
  timeline: StudioTimeline,
  text: string
): { timeline: StudioTimeline; clipId: string } => {
  const ensured = ensureTrack(timeline, 'captions');
  const clip: StudioCaptionClip = {
    id: mintTimelineId('clip'),
    text,
    style: { position: 'bottom', align: 'center', fontSizePct: 5, maxWidthPct: 90, color: '#FFFFFF' },
    ...nextSlot(ensured.timeline, ensured.track, DEFAULT_CAPTION_CLIP_MS),
  };
  const track = { ...ensured.track, clips: [...ensured.track.clips, clip] } as StudioTimelineTrack;
  return { timeline: replaceTrack(ensured.timeline, track), clipId: clip.id };
};

export const findClip = (timeline: StudioTimeline, clipId: string): LocatedClip | undefined => {
  for (const track of timeline.tracks) {
    const clip = track.clips.find(candidate => candidate.id === clipId);
    if (clip) return { track, clip };
  }
  return undefined;
};

/** Every field a clip of any kind may carry, so one patch type serves the inspector and the drag handles. */
export type StudioClipPatch = Partial<Omit<StudioVideoClip, 'id' | 'fileId'> & Omit<StudioCaptionClip, 'id'>>;

/** Merges `patch` into a clip, ignoring fields the clip's kind does not have. A missing clip is a no-op. */
export const updateClip = (timeline: StudioTimeline, clipId: string, patch: StudioClipPatch): StudioTimeline => {
  const located = findClip(timeline, clipId);
  if (!located) return timeline;
  const allowed = Object.fromEntries(Object.entries(patch).filter(([key]) => key in located.clip));
  const clips = located.track.clips.map(clip => (clip.id === clipId ? { ...clip, ...allowed } : clip));
  return replaceTrack(timeline, { ...located.track, clips } as StudioTimelineTrack);
};

/** Sets (or, with no rect, clears back to the centre crop) a video clip's framing for one output aspect ratio. */
export const setClipCrop = (
  timeline: StudioTimeline,
  clipId: string,
  aspectRatio: StudioOutputAspectRatio,
  rect: StudioCropRect | undefined
): StudioTimeline => {
  const located = findClip(timeline, clipId);
  if (located?.track.kind !== 'video') return timeline;
  const clips = located.track.clips.map(clip => {
    if (clip.id !== clipId) return clip;
    const { [aspectRatio]: _previous, ...others } = clip.crop ?? {};
    const crop = rect ? { ...others, [aspectRatio]: rect } : others;
    const { crop: _old, ...rest } = clip;
    return Object.keys(crop).length > 0 ? { ...rest, crop } : rest;
  });
  return replaceTrack(timeline, { ...located.track, clips });
};

export const removeClip = (timeline: StudioTimeline, clipId: string): StudioTimeline => {
  const located = findClip(timeline, clipId);
  if (!located) return timeline;
  const clips = located.track.clips.filter(clip => clip.id !== clipId);
  return replaceTrack(timeline, { ...located.track, clips } as StudioTimelineTrack);
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** Moves a clip to `startMs`, kept inside the timeline. */
export const moveClip = (timeline: StudioTimeline, clipId: string, startMs: number): StudioTimeline => {
  const located = findClip(timeline, clipId);
  if (!located) return timeline;
  const latestStart = Math.max(0, timeline.durationMs - located.clip.durationMs);
  return updateClip(timeline, clipId, { startMs: clamp(Math.round(startMs), 0, latestStart) });
};

/**
 * Moves a clip's in-point to `startMs` while its out-point stays put. A media clip's source in-point moves with it,
 * so the frames under the clip do not slide; it cannot trim before the source's start.
 */
export const trimClipStart = (timeline: StudioTimeline, clipId: string, startMs: number): StudioTimeline => {
  const located = findClip(timeline, clipId);
  if (!located) return timeline;
  const { clip } = located;
  const endMs = clip.startMs + clip.durationMs;
  const trimStartMs = 'trimStartMs' in clip ? clip.trimStartMs : undefined;
  const earliest = trimStartMs === undefined ? 0 : Math.max(0, clip.startMs - trimStartMs);
  const nextStart = clamp(Math.round(startMs), earliest, endMs - MIN_CLIP_MS);
  const delta = nextStart - clip.startMs;
  return updateClip(timeline, clipId, {
    startMs: nextStart,
    durationMs: endMs - nextStart,
    ...(trimStartMs === undefined ? {} : { trimStartMs: trimStartMs + delta }),
  });
};

/** Moves a clip's out-point to `endMs`, kept inside the timeline. */
export const trimClipEnd = (timeline: StudioTimeline, clipId: string, endMs: number): StudioTimeline => {
  const located = findClip(timeline, clipId);
  if (!located) return timeline;
  const { clip } = located;
  const nextEnd = clamp(Math.round(endMs), clip.startMs + MIN_CLIP_MS, timeline.durationMs);
  return updateClip(timeline, clipId, { durationMs: nextEnd - clip.startMs });
};

/** Adds or removes an output shape at its default size. The last output cannot be removed. */
export const toggleOutput = (timeline: StudioTimeline, aspectRatio: StudioOutputAspectRatio): StudioTimeline => {
  const has = timeline.outputs.some(output => output.aspectRatio === aspectRatio);
  if (has) {
    if (timeline.outputs.length === 1) return timeline;
    return { ...timeline, outputs: timeline.outputs.filter(output => output.aspectRatio !== aspectRatio) };
  }
  const output = {
    id: `out-${aspectRatio.replace(':', 'x')}`,
    aspectRatio,
    ...STUDIO_OUTPUT_DEFAULT_SIZES[aspectRatio],
  };
  const taken = new Set(timeline.outputs.map(existing => existing.id));
  return {
    ...timeline,
    outputs: [...timeline.outputs, taken.has(output.id) ? { ...output, id: mintTimelineId('out') } : output],
  };
};

export const setTimelineDuration = (timeline: StudioTimeline, durationMs: number): StudioTimeline => ({
  ...timeline,
  durationMs: Math.max(MIN_CLIP_MS, Math.round(durationMs)),
});
