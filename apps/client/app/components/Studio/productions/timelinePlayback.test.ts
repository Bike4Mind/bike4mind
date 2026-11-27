import { describe, expect, it } from 'vitest';
import { defaultStudioTimeline, type StudioAudioClip } from '@bike4mind/common';
import {
  activeCaptionsAt,
  clipFadeGain,
  clipSourceSeconds,
  formatTimecode,
  isClipActiveAt,
  previewVolume,
} from './timelinePlayback';
import { addCaptionClip } from './timelineEdits';

const clip: StudioAudioClip = {
  id: 'clip-1',
  fileId: 'a'.repeat(24),
  startMs: 1_000,
  durationMs: 2_000,
  fadeInMs: 500,
  fadeOutMs: 1_000,
  trimStartMs: 250,
  volume: 1.5,
};

describe('timeline playback', () => {
  it('treats a clip as the half-open interval [start, end)', () => {
    expect(isClipActiveAt(clip, 999)).toBe(false);
    expect(isClipActiveAt(clip, 1_000)).toBe(true);
    expect(isClipActiveAt(clip, 2_999)).toBe(true);
    expect(isClipActiveAt(clip, 3_000)).toBe(false);
  });

  it('ramps the fade in and out linearly', () => {
    expect(clipFadeGain(clip, 1_000)).toBe(0);
    expect(clipFadeGain(clip, 1_250)).toBe(0.5);
    expect(clipFadeGain(clip, 1_750)).toBe(1);
    expect(clipFadeGain(clip, 2_500)).toBe(0.5);
  });

  it('maps timeline time onto the source from the trim in-point', () => {
    expect(clipSourceSeconds(clip, 1_000)).toBe(0.25);
    expect(clipSourceSeconds(clip, 2_000)).toBe(1.25);
  });

  it('caps a boost at the media element maximum', () => {
    expect(previewVolume(clip, 1_750)).toBe(1);
    expect(previewVolume({ ...clip, volume: 0.5 }, 1_750)).toBe(0.5);
  });

  it('shows captions only from enabled tracks while they are active', () => {
    const { timeline } = addCaptionClip(defaultStudioTimeline('blank'), 'Hi');
    expect(activeCaptionsAt(timeline, 1_000).map(caption => caption.text)).toEqual(['Hi']);
    expect(activeCaptionsAt(timeline, 3_000)).toEqual([]);
    const disabled = { ...timeline, tracks: timeline.tracks.map(track => ({ ...track, enabled: false })) };
    expect(activeCaptionsAt(disabled, 1_000)).toEqual([]);
  });

  it('formats a timecode as m:ss.t', () => {
    expect(formatTimecode(0)).toBe('0:00.0');
    expect(formatTimecode(75_450)).toBe('1:15.4');
  });
});
