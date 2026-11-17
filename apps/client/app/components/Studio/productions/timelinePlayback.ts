import type { StudioCaptionClip, StudioTimeline, StudioTimelineClip, StudioTimelineTrack } from '@bike4mind/common';

/**
 * How the browser preview reads the timeline spec at a moment `ms`. These follow the render rules in the spec's
 * header (b4m-core/common/src/studioComposition/timeline.ts) so the later ffmpeg export and the preview agree.
 */

/** A clip plays over the half-open interval [startMs, startMs + durationMs). */
export const isClipActiveAt = (clip: StudioTimelineClip, ms: number): boolean =>
  ms >= clip.startMs && ms < clip.startMs + clip.durationMs;

/** Linear fade envelope, 0..1: ramps up over fadeInMs and down over the last fadeOutMs. */
export const clipFadeGain = (
  clip: { startMs: number; durationMs: number; fadeInMs: number; fadeOutMs: number },
  ms: number
) => {
  const offset = ms - clip.startMs;
  const remaining = clip.startMs + clip.durationMs - ms;
  const fadeIn = clip.fadeInMs > 0 ? Math.min(1, offset / clip.fadeInMs) : 1;
  const fadeOut = clip.fadeOutMs > 0 ? Math.min(1, remaining / clip.fadeOutMs) : 1;
  return Math.max(0, Math.min(fadeIn, fadeOut));
};

/** The source position (seconds) a media clip shows at timeline time `ms`. */
export const clipSourceSeconds = (clip: { startMs: number; trimStartMs: number }, ms: number): number =>
  (clip.trimStartMs + (ms - clip.startMs)) / 1000;

/**
 * The element volume for a clip. The spec allows gain up to 2; an HTML media element caps at 1, so the preview
 * plays a boost at unity (the export applies it).
 */
export const previewVolume = (
  clip: { volume: number; startMs: number; durationMs: number; fadeInMs: number; fadeOutMs: number },
  ms: number
) => Math.min(1, clip.volume * clipFadeGain(clip, ms));

export const enabledTracks = (timeline: StudioTimeline): StudioTimelineTrack[] =>
  timeline.tracks.filter(track => track.enabled);

/** Captions showing at `ms`, bottom track first, so a later track draws on top. */
export const activeCaptionsAt = (timeline: StudioTimeline, ms: number): StudioCaptionClip[] =>
  enabledTracks(timeline).flatMap(track =>
    track.kind === 'captions' ? track.clips.filter(clip => isClipActiveAt(clip, ms)) : []
  );

export const formatTimecode = (ms: number): string => {
  const totalTenths = Math.floor(Math.max(0, ms) / 100);
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths}`;
};
