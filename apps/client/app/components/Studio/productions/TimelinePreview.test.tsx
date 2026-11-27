import { useState, type ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import {
  StudioTimelineSchema,
  type StudioCropRect,
  type StudioTimeline,
  type StudioTimelineInput,
} from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import TimelinePreview from './TimelinePreview';
import type { PlaybackClock } from './usePlaybackClock';
import type { TimelineFile } from './useTimelineFiles';
import { setClipCrop } from './timelineEdits';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const VIDEO = 'a'.repeat(24);
const FILES = new Map<string, TimelineFile>([
  [VIDEO, { id: VIDEO, fileName: 'wide.mp4', mediaKind: 'video', url: 'https://cdn.test/wide.mp4' }],
]);

const timelineWith = (clip: Partial<StudioTimelineInput['tracks'][number]['clips'][number]> = {}): StudioTimeline =>
  StudioTimelineSchema.parse({
    version: 1,
    durationMs: 4000,
    fps: 30,
    outputs: [
      { id: 'tall', aspectRatio: '9:16', width: 1080, height: 1920 },
      { id: 'wide', aspectRatio: '16:9', width: 1920, height: 1080 },
    ],
    tracks: [
      { id: 'v', kind: 'video', clips: [{ id: 'clip', fileId: VIDEO, startMs: 1000, durationMs: 2000, ...clip }] },
    ],
  });

const makeClock = (): PlaybackClock => ({
  isPlaying: false,
  play: vi.fn(),
  pause: vi.fn(),
  seek: vi.fn(),
  getTimeMs: () => 0,
  subscribe: () => () => undefined,
});

/** The editor's state loop, so crop edits round-trip into the timeline the preview renders. */
const Harness = ({
  initial,
  clock,
  outputIndex = 0,
}: {
  initial: StudioTimeline;
  clock: PlaybackClock;
  outputIndex?: number;
}) => {
  const [timeline, setTimeline] = useState(initial);
  const output = timeline.outputs[outputIndex];
  return (
    <>
      <TimelinePreview
        timeline={timeline}
        output={output}
        files={FILES}
        clock={clock}
        onSourceDuration={() => undefined}
        selectedClipId="clip"
        onCropChange={(clipId, rect) => setTimeline(current => setClipCrop(current, clipId, output.aspectRatio, rect))}
      />
      <output data-testid="crop-state">{JSON.stringify(timeline.tracks[0].clips[0])}</output>
    </>
  );
};

const loadLandscapeSource = () => {
  const video = screen.getByTestId('production-preview-clip-clip').querySelector('video');
  if (!video) throw new Error('no video element');
  Object.defineProperty(video, 'videoWidth', { value: 1920 });
  Object.defineProperty(video, 'videoHeight', { value: 1080 });
  Object.defineProperty(video, 'duration', { value: 10 });
  fireEvent.loadedMetadata(video);
  return video;
};

const storedCrop = (): StudioCropRect | undefined =>
  (JSON.parse(screen.getByTestId('crop-state').textContent ?? '{}') as { crop?: Record<string, StudioCropRect> })
    .crop?.['9:16'];

describe('TimelinePreview reframing', () => {
  it('offers a reframe only once the source size is known', () => {
    render(<Harness initial={timelineWith()} clock={makeClock()} />, { wrapper: Wrapper });
    expect(screen.queryByTestId('production-preview-reframe-toggle')).toBeNull();
    loadLandscapeSource();
    expect(screen.getByTestId('production-preview-reframe-toggle')).toBeTruthy();
  });

  it('offers no reframe when the shapes match', () => {
    render(<Harness initial={timelineWith()} clock={makeClock()} outputIndex={1} />, { wrapper: Wrapper });
    loadLandscapeSource();
    expect(screen.queryByTestId('production-preview-reframe-toggle')).toBeNull();
  });

  it('still lets a stored rect be cleared when the clip cannot be reframed', () => {
    const rect = { x: 0, y: 0, width: 0.31640625, height: 1 };
    render(<Harness initial={timelineWith({ crop: { '9:16': rect } })} clock={makeClock()} />, { wrapper: Wrapper });
    // Source size never reported, so the clip is not reframable yet.
    fireEvent.click(screen.getByTestId('production-preview-reframe-reset'));
    expect(storedCrop()).toBeUndefined();
  });

  it('offers no reframe on a contained clip', () => {
    render(<Harness initial={timelineWith({ fit: 'contain' })} clock={makeClock()} />, { wrapper: Wrapper });
    loadLandscapeSource();
    expect(screen.queryByTestId('production-preview-reframe-toggle')).toBeNull();
  });

  it('opens the crop box on the centre crop, seeking into the clip, and nudges it with the keyboard', () => {
    const clock = makeClock();
    render(<Harness initial={timelineWith()} clock={clock} />, { wrapper: Wrapper });
    loadLandscapeSource();

    fireEvent.click(screen.getByTestId('production-preview-reframe-toggle'));
    expect(clock.pause).toHaveBeenCalled();
    expect(clock.seek).toHaveBeenCalledWith(1000);
    const box = screen.getByTestId('production-crop-box');
    // 9:16 out of 16:9 is 31.640625% of the width, centred.
    expect(box.style.width).toBe('31.640625%');
    expect(parseFloat(box.style.left)).toBeCloseTo(34.1796875);
    expect(storedCrop()).toBeUndefined();

    fireEvent.keyDown(box, { key: 'ArrowLeft', shiftKey: true });
    expect(storedCrop()?.x).toBeCloseTo(0.341796875 - 0.1);
    expect(storedCrop()?.width).toBeCloseTo(0.31640625);
  });

  it('pans the box by dragging and restores the centre crop on reset', () => {
    render(<Harness initial={timelineWith()} clock={makeClock()} />, { wrapper: Wrapper });
    loadLandscapeSource();
    fireEvent.click(screen.getByTestId('production-preview-reframe-toggle'));
    const editor = screen.getByTestId('production-crop-editor');
    vi.spyOn(editor, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ width: 800, height: 450 }));

    fireEvent.pointerDown(screen.getByTestId('production-crop-box'), { clientX: 400, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(editor, { clientX: 0, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(editor, { pointerId: 1 });
    expect(storedCrop()?.x).toBe(0);

    fireEvent.click(screen.getByTestId('production-preview-reframe-reset'));
    expect(storedCrop()).toBeUndefined();
  });

  it('zooms with a corner handle, keeping the 9:16 shape', () => {
    render(<Harness initial={timelineWith()} clock={makeClock()} />, { wrapper: Wrapper });
    loadLandscapeSource();
    fireEvent.click(screen.getByTestId('production-preview-reframe-toggle'));
    const editor = screen.getByTestId('production-crop-editor');
    vi.spyOn(editor, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ width: 800, height: 450 }));

    fireEvent.pointerDown(screen.getByTestId('production-crop-handle-se'), {
      clientX: 400,
      clientY: 450,
      pointerId: 1,
    });
    fireEvent.pointerMove(editor, { clientX: 400, clientY: 225, pointerId: 1 });
    const crop = storedCrop();
    expect(crop?.height).toBeCloseTo(0.5);
    expect(((crop?.width ?? 0) * 1920) / ((crop?.height ?? 1) * 1080)).toBeCloseTo(9 / 16);
  });

  it('frames the clip on its stored rect outside reframe mode', () => {
    const rect = { x: 0, y: 0, width: 0.31640625, height: 1 };
    render(<Harness initial={timelineWith({ crop: { '9:16': rect } })} clock={makeClock()} />, { wrapper: Wrapper });
    const video = loadLandscapeSource();
    expect(video.style.width).toBe(`${100 / rect.width}%`);
    expect(video.style.left).toBe('0%');
  });
});
