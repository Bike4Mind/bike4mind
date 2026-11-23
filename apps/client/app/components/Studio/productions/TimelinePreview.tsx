import { useCallback, useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { Button, Stack } from '@mui/joy';
import { styled } from '@mui/system';
import {
  STUDIO_FULL_FRAME_CROP,
  studioClipCropFor,
  studioCropShownRect,
  type StudioAudioClip,
  type StudioCaptionClip,
  type StudioCropRect,
  type StudioPixelSize,
  type StudioTimeline,
  type StudioTimelineOutput,
  type StudioVideoClip,
} from '@bike4mind/common';
import { studioColor, studioRadius } from '../design/studioTokens';
import CropEditor from './CropEditor';
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

// Shapes closer than this (relative) need no reframing: the centre crop already shows the whole source.
const SAME_SHAPE_TOLERANCE = 0.01;

const Viewport = styled('div')({
  position: 'relative',
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

const ReframeControls = styled(Stack)({ position: 'absolute', top: 8, right: 8, zIndex: 1 });

type PreviewProps = {
  timeline: StudioTimeline;
  output: StudioTimelineOutput;
  files: ReadonlyMap<string, TimelineFile>;
  clock: PlaybackClock;
  onSourceDuration: (fileId: string, durationMs: number) => void;
  /** The editor's selected clip; a video clip on a cover fit can be reframed for the output shown. */
  selectedClipId?: string | null;
  /** Sets the selected clip's crop for this output's aspect ratio; undefined restores the centre crop. */
  onCropChange?: (clipId: string, rect: StudioCropRect | undefined) => void;
};

const aspectOf = (size: StudioPixelSize): number => size.width / size.height;

const isSameShape = (a: StudioPixelSize, b: StudioPixelSize): boolean =>
  Math.abs(aspectOf(a) / aspectOf(b) - 1) < SAME_SHAPE_TOLERANCE;

const findVideoClip = (timeline: StudioTimeline, clipId: string | null | undefined): StudioVideoClip | undefined => {
  if (!clipId) return undefined;
  for (const track of timeline.tracks) {
    if (track.kind !== 'video') continue;
    const clip = track.clips.find(candidate => candidate.id === clipId);
    if (clip) return clip;
  }
  return undefined;
};

/** Each source's decoded pixel size, as the media elements report it; the crop math needs it. */
function useSourceSizes() {
  const [sizes, setSizes] = useState<ReadonlyMap<string, StudioPixelSize>>(new Map());
  const report = useCallback((fileId: string, size: StudioPixelSize) => {
    if (size.width <= 0 || size.height <= 0) return;
    setSizes(current => {
      const known = current.get(fileId);
      if (known?.width === size.width && known.height === size.height) return current;
      return new Map(current).set(fileId, size);
    });
  }, []);
  return { sizes, report };
}

/**
 * Plays the timeline spec as-is in the browser at one output's shape: video tracks composite bottom to top over the
 * background, audio tracks mix through their own elements, captions draw on top. Every media element is mounted
 * up front (so it is loaded before its clip starts) and synced to the shared clock each tick.
 */
const TimelinePreview = ({
  timeline,
  output,
  files,
  clock,
  onSourceDuration,
  selectedClipId,
  onCropChange,
}: PreviewProps) => {
  const timeMs = usePlaybackTime(clock);
  const { isPlaying } = clock;
  const viewportRef = useRef<HTMLDivElement>(null);
  const sourceSizes = useSourceSizes();
  const [reframeClipId, setReframeClipId] = useState<string | null>(null);

  const selectedClip = findVideoClip(timeline, selectedClipId);
  const selectedSize = selectedClip && sourceSizes.sizes.get(selectedClip.fileId);
  const reframable =
    onCropChange && selectedClip?.fit === 'cover' && selectedSize && !isSameShape(selectedSize, output)
      ? { clip: selectedClip, sourceSize: selectedSize, onCropChange }
      : undefined;
  const reframing = reframable && reframeClipId === reframable.clip.id ? reframable : undefined;
  // Offered even when the clip cannot be reframed (say, a stored rect on a same-shape source), so it can be cleared.
  const resettable =
    onCropChange && selectedClip && studioClipCropFor(selectedClip, output.aspectRatio)
      ? () => onCropChange(selectedClip.id, undefined)
      : undefined;

  const size = useFittedSize(viewportRef, aspectOf(reframing ? reframing.sourceSize : output));
  const tracks = enabledTracks(timeline);

  const startReframe = (clip: StudioVideoClip) => {
    clock.pause();
    if (!isClipActiveAt(clip, clock.getTimeMs())) clock.seek(clip.startMs);
    setReframeClipId(clip.id);
  };

  return (
    <Viewport ref={viewportRef} data-testid="production-preview">
      {(reframable || resettable) && (
        <ReframeControls direction="row" spacing={1}>
          {resettable && (
            <Button
              size="sm"
              variant="soft"
              color="neutral"
              data-testid="production-preview-reframe-reset"
              onClick={resettable}
            >
              Centre
            </Button>
          )}
          {reframable && (
            <Button
              size="sm"
              variant={reframing ? 'solid' : 'soft'}
              color={reframing ? 'primary' : 'neutral'}
              data-testid="production-preview-reframe-toggle"
              aria-pressed={Boolean(reframing)}
              onClick={() => (reframing ? setReframeClipId(null) : startReframe(reframable.clip))}
            >
              {reframing ? 'Done' : `Reframe ${output.aspectRatio}`}
            </Button>
          )}
        </ReframeControls>
      )}
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
                  output={output}
                  sourceSize={sourceSizes.sizes.get(clip.fileId)}
                  onSourceSize={sourceSizes.report}
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
        {reframing && (
          <ReframeLayer
            clip={reframing.clip}
            file={files.get(reframing.clip.fileId)}
            timeMs={timeMs}
            isPlaying={isPlaying}
            onSourceDuration={onSourceDuration}
            output={output}
            sourceSize={reframing.sourceSize}
            onCropChange={reframing.onCropChange}
          />
        )}
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

const fill = (fit: StudioVideoClip['fit'] | 'fill'): CSSProperties => ({
  width: '100%',
  height: '100%',
  objectFit: fit,
  display: 'block',
});

/**
 * Sizes the media so the shown region (normalized to the source) fills its layer: the layer is the output frame,
 * so the media box is the frame scaled up by 1 / shown size and shifted to put the region's corner at the origin.
 */
const croppedFill = (shown: StudioCropRect): CSSProperties => ({
  position: 'absolute',
  width: `${100 / shown.width}%`,
  height: `${100 / shown.height}%`,
  left: `${(-shown.x / shown.width) * 100}%`,
  top: `${(-shown.y / shown.height) * 100}%`,
  maxWidth: 'none',
  objectFit: 'fill',
  display: 'block',
});

type VisualClipProps = MediaClipProps<StudioVideoClip> & {
  output: StudioTimelineOutput;
  sourceSize: StudioPixelSize | undefined;
  onSourceSize: (fileId: string, size: StudioPixelSize) => void;
};

const VisualClip = ({
  clip,
  file,
  timeMs,
  isPlaying,
  onSourceDuration,
  output,
  sourceSize,
  onSourceSize,
}: VisualClipProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  useSyncedMedia(videoRef, clip, timeMs, isPlaying);
  const isActive = isClipActiveAt(clip, timeMs);
  const style: CSSProperties = {
    opacity: isActive ? clipFadeGain(clip, timeMs) : 0,
    visibility: isActive ? 'visible' : 'hidden',
  };
  if (!file?.url) return null;
  const crop = studioClipCropFor(clip, output.aspectRatio);
  // Until the source reports its size, a cropped clip shows the centre crop rather than nothing.
  const mediaStyle = crop && sourceSize ? croppedFill(studioCropShownRect(crop, sourceSize, output)) : fill(clip.fit);
  return (
    <Layer style={style} data-testid={`production-preview-clip-${clip.id}`} data-active={isActive}>
      {file.mediaKind === 'image' ? (
        <img
          src={file.url}
          alt=""
          style={mediaStyle}
          onLoad={event =>
            onSourceSize(clip.fileId, {
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
        />
      ) : (
        <video
          ref={videoRef}
          src={file.url}
          preload="auto"
          playsInline
          style={mediaStyle}
          onLoadedMetadata={event => {
            reportDuration(clip.fileId, onSourceDuration)(event);
            onSourceSize(clip.fileId, {
              width: event.currentTarget.videoWidth,
              height: event.currentTarget.videoHeight,
            });
          }}
        />
      )}
    </Layer>
  );
};

type ReframeLayerProps = MediaClipProps<StudioVideoClip> & {
  output: StudioTimelineOutput;
  sourceSize: StudioPixelSize;
  onCropChange: (clipId: string, rect: StudioCropRect | undefined) => void;
};

/**
 * The whole source of the clip being reframed (the stage takes the source's shape meanwhile), with the box the
 * output shows over it. Its own muted element, so the clip's audio still comes from VisualClip alone.
 */
const ReframeLayer = ({
  clip,
  file,
  timeMs,
  isPlaying,
  onSourceDuration,
  output,
  sourceSize,
  onCropChange,
}: ReframeLayerProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  useSyncedMedia(videoRef, clip, timeMs, isPlaying);
  if (!file?.url) return null;
  const shown = studioCropShownRect(clip.crop?.[output.aspectRatio] ?? STUDIO_FULL_FRAME_CROP, sourceSize, output);
  return (
    <Layer data-testid="production-reframe-source" style={{ background: '#000' }}>
      {file.mediaKind === 'image' ? (
        <img src={file.url} alt="" style={fill('fill')} />
      ) : (
        <video
          ref={videoRef}
          src={file.url}
          preload="auto"
          playsInline
          muted
          style={fill('fill')}
          onLoadedMetadata={reportDuration(clip.fileId, onSourceDuration)}
        />
      )}
      <CropEditor
        rect={shown}
        heightPerWidth={aspectOf(sourceSize) / aspectOf(output)}
        label={`Framing for ${output.aspectRatio}`}
        onChange={rect => onCropChange(clip.id, rect)}
      />
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
