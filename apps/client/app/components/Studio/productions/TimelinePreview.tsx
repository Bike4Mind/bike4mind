import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { styled } from '@mui/system';
import type {
  StudioAudioClip,
  StudioCaptionClip,
  StudioTimeline,
  StudioTimelineOutput,
  StudioVideoClip,
} from '@bike4mind/common';
import { studioColor, studioRadius } from '../design/studioTokens';
import {
  activeCaptionsAt,
  clipFadeGain,
  clipSourceSeconds,
  enabledTracks,
  isClipActiveAt,
  previewVolume,
} from './timelinePlayback';
import type { TimelineFile } from './useTimelineFiles';
import { usePlaybackTime, type PlaybackClock } from './usePlaybackClock';

// An element further than this from the clock is re-seeked; closer, it plays on so playback stays smooth.
const DRIFT_TOLERANCE_S = 0.25;
const PAUSED_SEEK_TOLERANCE_S = 0.04;

const Viewport = styled('div')({
  width: '100%',
  height: 'min(56vh, 540px)',
  minHeight: '220px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: studioColor('sunken'),
  borderRadius: studioRadius('lg'),
  overflow: 'hidden',
});

// `container-type: size` lets captions size in `cqh`, a percentage of the output height, as the spec defines it.
const Stage = styled('div')({
  position: 'relative',
  overflow: 'hidden',
  containerType: 'size',
  boxShadow: `0 0 0 1px ${studioColor('hairline')}`,
});

const Layer = styled('div')({ position: 'absolute', inset: 0 });

type PreviewProps = {
  timeline: StudioTimeline;
  output: StudioTimelineOutput;
  files: ReadonlyMap<string, TimelineFile>;
  clock: PlaybackClock;
  onSourceDuration: (fileId: string, durationMs: number) => void;
};

/**
 * Plays the timeline spec as-is in the browser at one output's shape: video tracks composite bottom to top over the
 * background, audio tracks mix through their own elements, captions draw on top. Every media element is mounted
 * up front (so it is loaded before its clip starts) and synced to the shared clock each tick.
 */
const TimelinePreview = ({ timeline, output, files, clock, onSourceDuration }: PreviewProps) => {
  const timeMs = usePlaybackTime(clock);
  const { isPlaying } = clock;
  const viewportRef = useRef<HTMLDivElement>(null);
  const size = useFittedSize(viewportRef, output.width / output.height);
  const tracks = enabledTracks(timeline);

  return (
    <Viewport ref={viewportRef} data-testid="production-preview">
      <Stage
        data-testid="production-preview-stage"
        data-aspect-ratio={output.aspectRatio}
        style={{ width: size.width, height: size.height, background: timeline.backgroundColor }}
      >
        {tracks.map(track =>
          track.kind === 'video'
            ? track.clips.map(clip => (
                <VisualClip
                  key={clip.id}
                  clip={clip}
                  file={files.get(clip.fileId)}
                  timeMs={timeMs}
                  isPlaying={isPlaying}
                  onSourceDuration={onSourceDuration}
                />
              ))
            : track.kind === 'captions'
              ? null
              : track.clips.map(clip => (
                  <AudioClip
                    key={clip.id}
                    clip={clip}
                    file={files.get(clip.fileId)}
                    timeMs={timeMs}
                    isPlaying={isPlaying}
                    onSourceDuration={onSourceDuration}
                  />
                ))
        )}
        {activeCaptionsAt(timeline, timeMs).map(clip => (
          <Caption key={clip.id} clip={clip} />
        ))}
      </Stage>
    </Viewport>
  );
};

/** The largest box of `ratio` that fits the viewport. */
function useFittedSize(viewportRef: RefObject<HTMLDivElement | null>, ratio: number) {
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => setBox({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [viewportRef]);
  const width = Math.min(box.width, box.height * ratio);
  return { width: Math.floor(width), height: Math.floor(width / ratio) };
}

type MediaClipProps<Clip> = {
  clip: Clip;
  file: TimelineFile | undefined;
  timeMs: number;
  isPlaying: boolean;
  onSourceDuration: (fileId: string, durationMs: number) => void;
};

/** Keeps one media element on its clip: playing and in sync while the clip is active, paused otherwise. */
function useSyncedMedia(
  mediaRef: RefObject<HTMLMediaElement | null>,
  clip: StudioVideoClip | StudioAudioClip,
  timeMs: number,
  isPlaying: boolean
) {
  useEffect(() => {
    const element = mediaRef.current;
    if (!element) return;
    if (!isClipActiveAt(clip, timeMs)) {
      if (!element.paused) element.pause();
      return;
    }
    const target = clipSourceSeconds(clip, timeMs);
    element.volume = previewVolume(clip, timeMs);
    if (!isPlaying) {
      if (!element.paused) element.pause();
      if (Math.abs(element.currentTime - target) > PAUSED_SEEK_TOLERANCE_S) element.currentTime = target;
      return;
    }
    if (Math.abs(element.currentTime - target) > DRIFT_TOLERANCE_S) element.currentTime = target;
    if (element.paused) {
      // A pause() racing this play() rejects it with AbortError; that is the clock moving on, not a failure.
      element.play().catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        // Blocked autoplay or an unplayable source: this element stays silent and the clock keeps the others going.
        console.warn('Production preview could not play a clip', error);
      });
    }
  }, [mediaRef, clip, timeMs, isPlaying]);
}

const reportDuration =
  (fileId: string, onSourceDuration: (fileId: string, durationMs: number) => void) =>
  (event: { currentTarget: HTMLMediaElement }) =>
    onSourceDuration(fileId, event.currentTarget.duration * 1000);

const fill = (fit: StudioVideoClip['fit']): CSSProperties => ({
  width: '100%',
  height: '100%',
  objectFit: fit,
  display: 'block',
});

const VisualClip = ({ clip, file, timeMs, isPlaying, onSourceDuration }: MediaClipProps<StudioVideoClip>) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  useSyncedMedia(videoRef, clip, timeMs, isPlaying);
  const isActive = isClipActiveAt(clip, timeMs);
  const style: CSSProperties = {
    opacity: isActive ? clipFadeGain(clip, timeMs) : 0,
    visibility: isActive ? 'visible' : 'hidden',
  };
  if (!file?.url) return null;
  return (
    <Layer style={style} data-testid={`production-preview-clip-${clip.id}`} data-active={isActive}>
      {file.mediaKind === 'image' ? (
        <img src={file.url} alt="" style={fill(clip.fit)} />
      ) : (
        <video
          ref={videoRef}
          src={file.url}
          preload="auto"
          playsInline
          style={fill(clip.fit)}
          onLoadedMetadata={reportDuration(clip.fileId, onSourceDuration)}
        />
      )}
    </Layer>
  );
};

const AudioClip = ({ clip, file, timeMs, isPlaying, onSourceDuration }: MediaClipProps<StudioAudioClip>) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  useSyncedMedia(audioRef, clip, timeMs, isPlaying);
  if (!file?.url) return null;
  // A video file on an audio track contributes only its audio; an <audio> element plays a video's soundtrack.
  return (
    <audio
      ref={audioRef}
      src={file.url}
      preload="auto"
      data-testid={`production-preview-clip-${clip.id}`}
      onLoadedMetadata={reportDuration(clip.fileId, onSourceDuration)}
    />
  );
};

const CAPTION_INSET_PCT = 6;
const CAPTION_JUSTIFY = { top: 'flex-start', center: 'center', bottom: 'flex-end' } as const;
const CAPTION_ALIGN_ITEMS = { left: 'flex-start', center: 'center', right: 'flex-end' } as const;

const Caption = ({ clip }: { clip: StudioCaptionClip }) => {
  const { style } = clip;
  return (
    <Layer
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: CAPTION_JUSTIFY[style.position],
        alignItems: CAPTION_ALIGN_ITEMS[style.align],
        // Vertical inset only: the spec wraps at `maxWidthPct` of the full output width, so no side padding.
        padding: `${CAPTION_INSET_PCT}cqh 0`,
        pointerEvents: 'none',
      }}
    >
      <span
        data-testid={`production-preview-caption-${clip.id}`}
        style={{
          maxWidth: `${style.maxWidthPct}cqw`,
          fontSize: `${style.fontSizePct}cqh`,
          fontFamily: style.fontFamily,
          color: style.color,
          background: style.backgroundColor,
          padding: style.backgroundColor ? '0.15em 0.4em' : undefined,
          textAlign: style.align,
          lineHeight: 1.25,
          fontWeight: 700,
          whiteSpace: 'pre-wrap',
          textShadow: style.backgroundColor ? undefined : '0 0.05em 0.2em rgba(0, 0, 0, 0.6)',
        }}
      >
        {clip.text}
      </span>
    </Layer>
  );
};

export default TimelinePreview;
