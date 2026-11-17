import { useRef, type Dispatch, type KeyboardEvent, type PointerEvent, type SetStateAction } from 'react';
import { styled } from '@mui/system';
import { Button } from '@mui/joy';
import {
  STUDIO_TIMELINE_TRACK_KINDS,
  type StudioTimeline,
  type StudioTimelineClip,
  type StudioTimelineTrack,
  type StudioTimelineTrackKind,
} from '@bike4mind/common';
import { STUDIO_MICRO_LABEL, studioColor, studioRadius } from '../design/studioTokens';
import { moveClip, removeClip, trimClipEnd, trimClipStart } from './timelineEdits';
import { formatTimecode } from './timelinePlayback';
import { usePlaybackTime, type PlaybackClock } from './usePlaybackClock';
import type { TimelineFile } from './useTimelineFiles';

export type AddClipRequest = { kind: 'video' | 'image' | 'voice' | 'sfx' | 'music' | 'captions' };

const TRACK_LABELS: Record<StudioTimelineTrackKind, string> = {
  video: 'Video',
  voice: 'Voice',
  sfx: 'SFX',
  music: 'Music',
  captions: 'Captions',
};

const TRACK_TINTS: Record<StudioTimelineTrackKind, string> = {
  video: studioColor('accent-soft'),
  voice: studioColor('success-soft'),
  sfx: studioColor('warning-soft'),
  music: studioColor('raised'),
  captions: studioColor('selected'),
};

const ADD_ACTIONS: Record<StudioTimelineTrackKind, { request: AddClipRequest['kind']; label: string }[]> = {
  video: [
    { request: 'video', label: '+ Video' },
    { request: 'image', label: '+ Image' },
  ],
  voice: [{ request: 'voice', label: '+ Voice' }],
  sfx: [{ request: 'sfx', label: '+ SFX' }],
  music: [{ request: 'music', label: '+ Music' }],
  captions: [{ request: 'captions', label: '+ Caption' }],
};

const KEYBOARD_NUDGE_MS = 100;
const RULER_STEP_CANDIDATES_MS = [500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000];
const MAX_RULER_MARKS = 16;

const Grid = styled('div')({
  display: 'grid',
  gridTemplateColumns: '132px minmax(0, 1fr)',
  rowGap: '6px',
  columnGap: '12px',
  alignItems: 'stretch',
  userSelect: 'none',
});

const LaneHead = styled('div')({
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  gap: '4px',
  minHeight: '44px',
});

const LaneLabel = styled('span')({ ...STUDIO_MICRO_LABEL, color: studioColor('text-secondary') });

const Lane = styled('div')({
  position: 'relative',
  minHeight: '44px',
  borderRadius: studioRadius('sm'),
  background: studioColor('sunken'),
  border: `1px solid ${studioColor('hairline')}`,
  // A clip left past the end after the timeline is shortened stays inside its lane.
  overflow: 'hidden',
});

const Ruler = styled('div')({
  position: 'relative',
  height: '24px',
  cursor: 'pointer',
  borderBottom: `1px solid ${studioColor('hairline')}`,
});

const RulerMark = styled('span')({
  position: 'absolute',
  top: 0,
  fontSize: '11px',
  color: studioColor('text-muted'),
  transform: 'translateX(-50%)',
  whiteSpace: 'nowrap',
});

const ClipBox = styled('div')({
  position: 'absolute',
  top: '4px',
  bottom: '4px',
  display: 'flex',
  alignItems: 'center',
  borderRadius: studioRadius('xs'),
  border: `1px solid ${studioColor('border')}`,
  color: studioColor('text-strong'),
  fontSize: '12px',
  overflow: 'hidden',
  cursor: 'grab',
  touchAction: 'none',
  '&[data-selected="true"]': { outline: `2px solid ${studioColor('accent')}`, outlineOffset: '1px' },
  '&[data-invalid="true"]': { borderColor: studioColor('danger'), borderWidth: '2px' },
  '&:focus-visible': { outline: `2px solid ${studioColor('focus-ring')}` },
});

const ClipLabel = styled('span')({
  flex: 1,
  minWidth: 0,
  padding: '0 10px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
});

const Handle = styled('span')({
  width: '8px',
  alignSelf: 'stretch',
  cursor: 'ew-resize',
  background: studioColor('border-strong'),
  flexShrink: 0,
});

const Playhead = styled('div')({
  position: 'absolute',
  top: 0,
  bottom: 0,
  width: '2px',
  marginLeft: '-1px',
  background: studioColor('accent-bright'),
  pointerEvents: 'none',
});

type DragMode = 'move' | 'trim-start' | 'trim-end';

type TimelineTracksProps = {
  timeline: StudioTimeline;
  files: ReadonlyMap<string, TimelineFile>;
  clock: PlaybackClock;
  selectedClipId: string | null;
  invalidClipIds: ReadonlySet<string>;
  onSelect: (clipId: string | null) => void;
  onChange: Dispatch<SetStateAction<StudioTimeline>>;
  onSeek: (ms: number) => void;
  onAdd: (request: AddClipRequest) => void;
};

/** One row per track (an empty row for a kind with no track yet), grouped in the spec's kind order. */
type LaneSpec = { kind: StudioTimelineTrackKind; track: StudioTimelineTrack | null; isFirstOfKind: boolean };

const laneRows = (timeline: StudioTimeline): LaneSpec[] =>
  STUDIO_TIMELINE_TRACK_KINDS.flatMap((kind): LaneSpec[] => {
    const tracks = timeline.tracks.filter(track => track.kind === kind);
    return tracks.length > 0
      ? tracks.map((track, index) => ({ kind, track, isFirstOfKind: index === 0 }))
      : [{ kind, track: null, isFirstOfKind: true }];
  });

// Widens a track's clip array off the per-kind union so array methods type-check.
const clipsOf = (track: StudioTimelineTrack): readonly StudioTimelineClip[] => track.clips;

const rulerStepMs = (durationMs: number) =>
  RULER_STEP_CANDIDATES_MS.find(step => durationMs / step <= MAX_RULER_MARKS) ?? 60_000;

const percent = (ms: number, durationMs: number) => `${(ms / durationMs) * 100}%`;

// The only part of the timeline that re-renders on every clock tick.
const ClockPlayhead = ({ clock, durationMs }: { clock: PlaybackClock; durationMs: number }) => {
  const timeMs = usePlaybackTime(clock);
  return <Playhead style={{ left: percent(timeMs, durationMs) }} />;
};

const clipLabel = (clip: StudioTimelineClip, files: ReadonlyMap<string, TimelineFile>) =>
  'text' in clip ? clip.text : (files.get(clip.fileId)?.fileName ?? 'Loading...');

/**
 * The timeline: a ruler to seek, then a lane per track with its clips placed by time. Drag a clip to move it, drag
 * its edges to trim. A focused clip opens in the inspector on Enter or Space, arrow keys nudge it and Delete
 * removes it. Edits go straight to `onChange`, and
 * the shared validator flags any overlap they cause (outlined in red) rather than the drag refusing it.
 */
const TimelineTracks = ({
  timeline,
  files,
  clock,
  selectedClipId,
  invalidClipIds,
  onSelect,
  onChange,
  onSeek,
  onAdd,
}: TimelineTracksProps) => {
  const dragRef = useRef<{
    mode: DragMode;
    clipId: string;
    originX: number;
    originStartMs: number;
    originEndMs: number;
    laneWidth: number;
  } | null>(null);
  const { durationMs } = timeline;
  const step = rulerStepMs(durationMs);
  const marks = Array.from({ length: Math.floor(durationMs / step) + 1 }, (_, index) => index * step);

  const seekFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    onSeek(((event.clientX - box.left) / box.width) * durationMs);
  };

  const startDrag = (event: PointerEvent<HTMLElement>, clip: StudioTimelineClip, mode: DragMode) => {
    event.stopPropagation();
    const lane = event.currentTarget.closest('[data-lane]');
    const laneWidth = lane?.getBoundingClientRect().width ?? 0;
    onSelect(clip.id);
    if (laneWidth === 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      mode,
      clipId: clip.id,
      originX: event.clientX,
      originStartMs: clip.startMs,
      originEndMs: clip.startMs + clip.durationMs,
      laneWidth,
    };
  };

  const continueDrag = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const deltaMs = ((event.clientX - drag.originX) / drag.laneWidth) * durationMs;
    const { clipId, originStartMs, originEndMs } = drag;
    // Applied to the live timeline, not a pointer-down snapshot, so a clip added mid-drag (a slow probe) survives.
    if (drag.mode === 'move') onChange(current => moveClip(current, clipId, originStartMs + deltaMs));
    if (drag.mode === 'trim-start') onChange(current => trimClipStart(current, clipId, originStartMs + deltaMs));
    if (drag.mode === 'trim-end') onChange(current => trimClipEnd(current, clipId, originEndMs + deltaMs));
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const onClipKeyDown = (event: KeyboardEvent<HTMLDivElement>, clip: StudioTimelineClip) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(clip.id);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      onChange(removeClip(timeline, clip.id));
      onSelect(null);
      return;
    }
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    onChange(moveClip(timeline, clip.id, clip.startMs + direction * KEYBOARD_NUDGE_MS));
  };

  const renderClip = (track: StudioTimelineTrack, clip: StudioTimelineClip) => (
    <ClipBox
      key={clip.id}
      role="button"
      tabIndex={0}
      aria-label={`${TRACK_LABELS[track.kind]} clip ${clipLabel(clip, files)}, ${formatTimecode(clip.startMs)} to ${formatTimecode(clip.startMs + clip.durationMs)}`}
      aria-pressed={clip.id === selectedClipId}
      data-testid={`production-clip-${clip.id}`}
      data-selected={clip.id === selectedClipId}
      data-invalid={invalidClipIds.has(clip.id)}
      style={{
        left: percent(clip.startMs, durationMs),
        width: percent(clip.durationMs, durationMs),
        background: TRACK_TINTS[track.kind],
        opacity: track.enabled ? 1 : 0.4,
      }}
      onPointerDown={event => startDrag(event, clip, 'move')}
      onPointerMove={continueDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={event => onClipKeyDown(event, clip)}
    >
      <Handle
        data-testid={`production-clip-${clip.id}-trim-start`}
        onPointerDown={event => startDrag(event, clip, 'trim-start')}
      />
      <ClipLabel>{clipLabel(clip, files)}</ClipLabel>
      <Handle
        data-testid={`production-clip-${clip.id}-trim-end`}
        onPointerDown={event => startDrag(event, clip, 'trim-end')}
      />
    </ClipBox>
  );

  return (
    <Grid data-testid="production-timeline">
      <div />
      <Ruler
        data-testid="production-timeline-ruler"
        onPointerDown={seekFromPointer}
        onPointerMove={event => event.buttons === 1 && seekFromPointer(event)}
      >
        {marks.map(mark => (
          <RulerMark key={mark} style={{ left: percent(mark, durationMs) }}>
            {formatTimecode(mark)}
          </RulerMark>
        ))}
        <ClockPlayhead clock={clock} durationMs={durationMs} />
      </Ruler>
      {laneRows(timeline).map(({ kind, track, isFirstOfKind }) => (
        <LaneRow key={track?.id ?? `empty-${kind}`}>
          <LaneHead>
            <LaneLabel>{TRACK_LABELS[kind]}</LaneLabel>
            {isFirstOfKind && (
              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                {ADD_ACTIONS[kind].map(action => (
                  <Button
                    key={action.request}
                    size="sm"
                    variant="soft"
                    data-testid={`production-add-${action.request}-btn`}
                    onClick={() => onAdd({ kind: action.request })}
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            )}
          </LaneHead>
          <Lane data-lane={kind} data-testid={`production-lane-${kind}`} onPointerDown={() => onSelect(null)}>
            {track && clipsOf(track).map(clip => renderClip(track, clip))}
            <ClockPlayhead clock={clock} durationMs={durationMs} />
          </Lane>
        </LaneRow>
      ))}
    </Grid>
  );
};

// A lane's head and body are two grid cells; `display: contents` keeps them a pair in the DOM.
const LaneRow = styled('div')({ display: 'contents' });

export default TimelineTracks;
