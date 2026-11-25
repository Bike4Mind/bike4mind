import {
  Button,
  Checkbox,
  FormControl,
  FormLabel,
  Option,
  Select,
  Slider,
  Stack,
  Textarea,
  Typography,
} from '@mui/joy';
import {
  STUDIO_CAPTION_ALIGNMENTS,
  STUDIO_CAPTION_POSITIONS,
  STUDIO_TIMELINE_LIMITS,
  STUDIO_VIDEO_FIT_MODES,
  type StudioTimeline,
} from '@bike4mind/common';
import { StudioPanel, StudioSectionLabel } from '../design/StudioPanel';
import SecondsField from './SecondsField';
import { findClip, removeClip, updateClip, type StudioClipPatch } from './timelineEdits';
import type { TimelineFile } from './useTimelineFiles';
import VoiceCaptionsControl from './VoiceCaptionsControl';

const MAX_VOLUME = 2;

type ClipInspectorProps = {
  timeline: StudioTimeline;
  clipId: string | null;
  files: ReadonlyMap<string, TimelineFile>;
  /** Probed source lengths by file id, for timing captions from a voice clip. */
  sourceDurationsMs?: ReadonlyMap<string, number>;
  onChange: (timeline: StudioTimeline) => void;
  onDeselect: () => void;
};

/** Edits the selected clip's timing, its audio (volume and fades) or its caption text and placement. */
const ClipInspector = ({ timeline, clipId, files, sourceDurationsMs, onChange, onDeselect }: ClipInspectorProps) => {
  const located = clipId ? findClip(timeline, clipId) : undefined;
  if (!located) {
    return (
      <StudioPanel testId="production-inspector-empty">
        <Typography level="body-sm">Select a clip on the timeline to edit it.</Typography>
      </StudioPanel>
    );
  }
  const { clip, track } = located;
  const patch = (fields: StudioClipPatch) => onChange(updateClip(timeline, clip.id, fields));

  return (
    <StudioPanel testId="production-inspector">
      <Stack spacing={1.5}>
        <StudioSectionLabel>
          {'fileId' in clip ? (files.get(clip.fileId)?.fileName ?? 'Clip') : 'Caption'}
        </StudioSectionLabel>
        <Stack direction="row" spacing={1}>
          <SecondsField
            label="Start"
            valueMs={clip.startMs}
            testId="production-inspector-start-input"
            onCommit={startMs => patch({ startMs })}
          />
          <SecondsField
            label="Length"
            valueMs={clip.durationMs}
            testId="production-inspector-duration-input"
            onCommit={durationMs => patch({ durationMs })}
          />
        </Stack>

        {'fileId' in clip && (
          <>
            <SecondsField
              label="Source in-point"
              valueMs={clip.trimStartMs}
              testId="production-inspector-trim-input"
              onCommit={trimStartMs => patch({ trimStartMs })}
            />
            <FormControl size="sm">
              <FormLabel>Volume {Math.round(clip.volume * 100)}%</FormLabel>
              <Slider
                size="sm"
                min={0}
                max={MAX_VOLUME}
                step={0.05}
                value={clip.volume}
                onChange={(_, value) => typeof value === 'number' && patch({ volume: value })}
                slotProps={{ input: { 'aria-label': 'Volume', 'data-testid': 'production-inspector-volume-slider' } }}
              />
            </FormControl>
            <Stack direction="row" spacing={1}>
              <SecondsField
                label="Fade in"
                valueMs={clip.fadeInMs}
                testId="production-inspector-fade-in-input"
                onCommit={fadeInMs => patch({ fadeInMs })}
              />
              <SecondsField
                label="Fade out"
                valueMs={clip.fadeOutMs}
                testId="production-inspector-fade-out-input"
                onCommit={fadeOutMs => patch({ fadeOutMs })}
              />
            </Stack>
          </>
        )}

        {track.kind === 'voice' && 'fileId' in clip && (
          <VoiceCaptionsControl
            key={clip.id}
            timeline={timeline}
            voiceClip={clip}
            sourceDurationMs={sourceDurationsMs?.get(clip.fileId)}
            onChange={onChange}
          />
        )}

        {'fit' in clip && (
          <FormControl size="sm">
            <FormLabel>Fit</FormLabel>
            <Select
              size="sm"
              value={clip.fit}
              onChange={(_, value) => value && patch({ fit: value })}
              data-testid="production-inspector-fit-select"
            >
              {STUDIO_VIDEO_FIT_MODES.map(mode => (
                <Option key={mode} value={mode}>
                  {mode === 'cover' ? 'Fill (crop)' : 'Fit (letterbox)'}
                </Option>
              ))}
            </Select>
          </FormControl>
        )}

        {'text' in clip && (
          <>
            <FormControl size="sm">
              <FormLabel>Text</FormLabel>
              <Textarea
                size="sm"
                minRows={2}
                value={clip.text}
                slotProps={{
                  textarea: {
                    maxLength: STUDIO_TIMELINE_LIMITS.maxCaptionLength,
                    'data-testid': 'production-inspector-text-input',
                  },
                }}
                onChange={event => patch({ text: event.target.value })}
              />
            </FormControl>
            {clip.syncedVoiceClipId !== undefined && (
              <Checkbox
                size="sm"
                checked
                label="Moves with its voice clip"
                onChange={() => patch({ syncedVoiceClipId: undefined })}
                slotProps={{ input: { 'data-testid': 'production-inspector-caption-sync-checkbox' } }}
              />
            )}
            <Stack direction="row" spacing={1}>
              <FormControl size="sm" sx={{ flex: 1 }}>
                <FormLabel>Position</FormLabel>
                <Select
                  size="sm"
                  value={clip.style.position}
                  onChange={(_, position) => position && patch({ style: { ...clip.style, position } })}
                  data-testid="production-inspector-position-select"
                >
                  {STUDIO_CAPTION_POSITIONS.map(position => (
                    <Option key={position} value={position}>
                      {position}
                    </Option>
                  ))}
                </Select>
              </FormControl>
              <FormControl size="sm" sx={{ flex: 1 }}>
                <FormLabel>Align</FormLabel>
                <Select
                  size="sm"
                  value={clip.style.align}
                  onChange={(_, align) => align && patch({ style: { ...clip.style, align } })}
                  data-testid="production-inspector-align-select"
                >
                  {STUDIO_CAPTION_ALIGNMENTS.map(align => (
                    <Option key={align} value={align}>
                      {align}
                    </Option>
                  ))}
                </Select>
              </FormControl>
            </Stack>
          </>
        )}

        <Button
          size="sm"
          color="danger"
          variant="soft"
          data-testid="production-inspector-remove-btn"
          onClick={() => {
            onChange(removeClip(timeline, clip.id));
            onDeselect();
          }}
        >
          Remove clip
        </Button>
      </Stack>
    </StudioPanel>
  );
};

export default ClipInspector;
