import { useEffect, useRef, useState } from 'react';
import { styled } from '@mui/system';
import { Button, Chip, Input, Slider, Stack, Typography } from '@mui/joy';
import { toast } from 'sonner';
import {
  STUDIO_COMPOSITION_LIMITS,
  STUDIO_OUTPUT_ASPECT_RATIOS,
  studioFileMediaKind,
  type IFabFileDocument,
  type StudioCompositionResponse,
  type StudioTimeline,
} from '@bike4mind/common';
import EmbeddedFileBrowser, { type EmbeddedFileBrowserHandle } from '@client/app/components/Files/EmbeddedFileBrowser';
import { compositionErrorMessage, useUpdateStudioComposition } from '@client/app/hooks/data/studioCompositions';
import StudioChip from '../design/StudioChip';
import { StudioPanel, StudioSectionLabel } from '../design/StudioPanel';
import StudioSegmentedControl from '../design/StudioSegmentedControl';
import { studioColor } from '../design/studioTokens';
import ClipInspector from './ClipInspector';
import { probeMediaDurationMs } from './probeMediaDuration';
import SecondsField from './SecondsField';
import { formatTimecode } from './timelinePlayback';
import {
  DEFAULT_IMAGE_CLIP_MS,
  addCaptionClip,
  addMediaClip,
  setTimelineDuration,
  toggleOutput,
  type StudioMediaTrackKind,
} from './timelineEdits';
import TimelinePreview from './TimelinePreview';
import TimelineTracks, { type AddClipRequest } from './TimelineTracks';
import { usePlaybackClock } from './usePlaybackClock';
import { useTimelineAutosave, type TimelineEditorIssue, type TimelineSaveStatus } from './useTimelineAutosave';
import { useTimelineFiles } from './useTimelineFiles';

// Used when the browser cannot read a picked file's length; the clip can be trimmed to fit afterwards.
const FALLBACK_MEDIA_CLIP_MS = 5_000;
const NEW_CAPTION_TEXT = 'New caption';

type PickRequest = Exclude<AddClipRequest['kind'], 'captions'>;

const PICKER_FILTER: Record<PickRequest, 'video' | 'image' | 'audio'> = {
  video: 'video',
  image: 'image',
  voice: 'audio',
  sfx: 'audio',
  music: 'audio',
};

const Workspace = styled('div')({
  display: 'grid',
  gap: '20px',
  gridTemplateColumns: 'minmax(0, 1fr)',
  '@media (min-width: 1100px)': { gridTemplateColumns: 'minmax(0, 1fr) 320px' },
});

const Toolbar = styled('div')({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-end',
  gap: '12px 20px',
});

const IssueList = styled('ul')({
  margin: 0,
  paddingLeft: '18px',
  color: studioColor('danger'),
  fontSize: '13px',
});

const STATUS_LABEL: Record<TimelineSaveStatus['kind'], string> = {
  saved: 'Saved',
  pending: 'Unsaved changes',
  saving: 'Saving...',
  invalid: 'Fix the issues below to save',
  error: 'Not saved',
};

const STATUS_COLOR = {
  saved: 'success',
  pending: 'neutral',
  saving: 'neutral',
  invalid: 'warning',
  error: 'danger',
} as const;

/** The clip ids an issue path (`tracks.<i>.clips.<j>...`) points at, so the timeline can outline them. */
const invalidClipIdsOf = (timeline: StudioTimeline, issues: TimelineEditorIssue[]): Set<string> => {
  const ids = new Set<string>();
  for (const { path } of issues) {
    const [root, trackIndex, clips, clipIndex] = path;
    if (root !== 'tracks' || clips !== 'clips' || typeof trackIndex !== 'number' || typeof clipIndex !== 'number')
      continue;
    const clip = timeline.tracks[trackIndex]?.clips[clipIndex];
    if (clip) ids.add(clip.id);
  }
  return ids;
};

/**
 * The timeline editor for one production: its title, length and output shapes; the live preview with transport
 * and output switch; the tracks; and the selected clip's inspector. Edits stay in a local draft that autosaves.
 */
const ProductionEditor = ({ composition }: { composition: StudioCompositionResponse }) => {
  const [timeline, setTimeline] = useState(composition.timeline);
  const timelineRef = useRef(timeline);
  useEffect(() => {
    timelineRef.current = timeline;
  }, [timeline]);
  const { files, context, reportDuration } = useTimelineFiles(timeline);
  const { status } = useTimelineAutosave(composition.id, timeline, composition.timeline, context);
  const clock = usePlaybackClock(timeline.durationMs);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [outputId, setOutputId] = useState(timeline.outputs[0].id);
  const output = timeline.outputs.find(candidate => candidate.id === outputId) ?? timeline.outputs[0];
  const pickerRef = useRef<EmbeddedFileBrowserHandle>(null);
  const [pickRequest, setPickRequest] = useState<PickRequest>('video');
  const statusIssues = status.kind === 'invalid' || status.kind === 'error' ? status.issues : [];
  // statusIssues covers the server's 422 issues too (a file the user cannot read), so those clips are outlined.
  const invalidClipIds = invalidClipIdsOf(timeline, statusIssues);

  const onAdd = ({ kind }: AddClipRequest) => {
    if (kind === 'captions') {
      try {
        const added = addCaptionClip(timeline, NEW_CAPTION_TEXT);
        setTimeline(added.timeline);
        setSelectedClipId(added.clipId);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    setPickRequest(kind);
    pickerRef.current?.handleOpen();
  };

  const clipLengthFor = async (file: IFabFileDocument): Promise<number> => {
    if (studioFileMediaKind(file.mimeType) === 'image') return DEFAULT_IMAGE_CLIP_MS;
    const url = file.presignedUrl ?? file.fileUrl;
    const probed = url ? await probeMediaDurationMs(url) : undefined;
    if (probed !== undefined) reportDuration(file.id, probed);
    return probed ?? FALLBACK_MEDIA_CLIP_MS;
  };

  const onFilesPicked = async (picked: IFabFileDocument[]) => {
    const trackKind: StudioMediaTrackKind = pickRequest === 'image' ? 'video' : pickRequest;
    const lengths = await Promise.all(picked.map(clipLengthFor));
    // Applied to the latest draft, not the one from when the picker opened: probing takes a moment.
    let next = timelineRef.current;
    let lastClipId: string | null = null;
    try {
      picked.forEach((file, index) => {
        const added = addMediaClip(next, trackKind, { fileId: file.id, durationMs: lengths[index] });
        next = added.timeline;
        lastClipId = added.clipId;
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
    setTimeline(next);
    if (lastClipId) setSelectedClipId(lastClipId);
  };

  return (
    <Stack spacing={2.5} data-testid="production-editor">
      <Toolbar>
        <TitleField compositionId={composition.id} initialTitle={composition.title} />
        <SecondsField
          label="Length"
          valueMs={timeline.durationMs}
          testId="production-length-input"
          onCommit={durationMs => setTimeline(current => setTimelineDuration(current, durationMs))}
        />
        <Stack spacing={0.5}>
          <StudioSectionLabel>Output sizes</StudioSectionLabel>
          <Stack direction="row" spacing={0.75}>
            {STUDIO_OUTPUT_ASPECT_RATIOS.map(aspectRatio => (
              <StudioChip
                key={aspectRatio}
                selected={timeline.outputs.some(candidate => candidate.aspectRatio === aspectRatio)}
                onClick={() => setTimeline(current => toggleOutput(current, aspectRatio))}
                testId={`production-output-toggle-${aspectRatio.replace(':', 'x')}`}
              >
                {aspectRatio}
              </StudioChip>
            ))}
          </Stack>
        </Stack>
        <Chip
          variant="soft"
          color={STATUS_COLOR[status.kind]}
          data-testid="production-save-status"
          data-status={status.kind}
          sx={{ marginLeft: 'auto' }}
        >
          {status.kind === 'error' ? `${STATUS_LABEL.error}: ${status.message}` : STATUS_LABEL[status.kind]}
        </Chip>
      </Toolbar>

      <Workspace>
        <Stack spacing={1.5}>
          <TimelinePreview
            timeline={timeline}
            output={output}
            files={files}
            timeMs={clock.timeMs}
            isPlaying={clock.isPlaying}
            onSourceDuration={reportDuration}
          />
          <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
            <Button size="sm" data-testid="production-play-btn" onClick={clock.isPlaying ? clock.pause : clock.play}>
              {clock.isPlaying ? 'Pause' : 'Play'}
            </Button>
            <Typography level="body-sm" data-testid="production-timecode" sx={{ fontVariantNumeric: 'tabular-nums' }}>
              {formatTimecode(clock.timeMs)} / {formatTimecode(timeline.durationMs)}
            </Typography>
            <Slider
              size="sm"
              aria-label="Seek"
              min={0}
              max={timeline.durationMs}
              step={10}
              value={clock.timeMs}
              onChange={(_, value) => typeof value === 'number' && clock.seek(value)}
              sx={{ flex: 1, minWidth: '160px' }}
              slotProps={{ input: { 'aria-label': 'Playhead', 'data-testid': 'production-seek-slider' } }}
            />
            <StudioSegmentedControl
              aria-label="Preview size"
              value={output.id}
              onChange={setOutputId}
              testId="production-preview-size"
              options={timeline.outputs.map(candidate => ({
                value: candidate.id,
                label: candidate.aspectRatio,
                testId: `production-preview-size-${candidate.aspectRatio.replace(':', 'x')}`,
              }))}
            />
          </Stack>
        </Stack>
        <ClipInspector
          timeline={timeline}
          clipId={selectedClipId}
          files={files}
          onChange={setTimeline}
          onDeselect={() => setSelectedClipId(null)}
        />
      </Workspace>

      <StudioPanel testId="production-timeline-panel">
        <TimelineTracks
          timeline={timeline}
          files={files}
          timeMs={clock.timeMs}
          selectedClipId={selectedClipId}
          invalidClipIds={invalidClipIds}
          onSelect={setSelectedClipId}
          onChange={setTimeline}
          onSeek={clock.seek}
          onAdd={onAdd}
        />
      </StudioPanel>

      {statusIssues.length > 0 && (
        <IssueList data-testid="production-issues">
          {statusIssues.map((issue, index) => (
            <li key={`${issue.code}-${index}`}>{issue.message}</li>
          ))}
        </IssueList>
      )}

      <EmbeddedFileBrowser
        ref={pickerRef}
        lockedFilters={{ type: PICKER_FILTER[pickRequest] }}
        addButtonLabelKey="file_browser.add_files_to_production"
        onAdd={picked => void onFilesPicked(picked)}
      />
    </Stack>
  );
};

/** The production's name, saved when the field loses focus or on Enter. */
const TitleField = ({ compositionId, initialTitle }: { compositionId: string; initialTitle: string }) => {
  const [title, setTitle] = useState(initialTitle);
  const [savedTitle, setSavedTitle] = useState(initialTitle);
  const update = useUpdateStudioComposition(compositionId);

  const commit = () => {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      setTitle(savedTitle);
      return;
    }
    if (trimmed === savedTitle) return;
    update.mutate(
      { title: trimmed },
      {
        onSuccess: composition => setSavedTitle(composition.title),
        onError: error => toast.error(compositionErrorMessage(error)),
      }
    );
  };

  return (
    <Stack spacing={0.5} sx={{ minWidth: '220px', flex: '1 1 220px', maxWidth: '420px' }}>
      <StudioSectionLabel>Title</StudioSectionLabel>
      <Input
        size="sm"
        value={title}
        onChange={event => setTitle(event.target.value)}
        onBlur={commit}
        onKeyDown={event => event.key === 'Enter' && event.currentTarget.blur()}
        slotProps={{
          input: {
            maxLength: STUDIO_COMPOSITION_LIMITS.titleMaxLength,
            'aria-label': 'Production title',
            'data-testid': 'production-title-input',
          },
        }}
      />
    </Stack>
  );
};

export default ProductionEditor;
