import { useState } from 'react';
import { Button, Checkbox, FormControl, FormHelperText, FormLabel, Stack, Textarea, Typography } from '@mui/joy';
import {
  buildVoiceCaptionCues,
  replaceVoiceCaptions,
  voiceCaptionClips,
  type StudioAudioClip,
  type StudioTimeline,
  type VoiceCaptionTiming,
} from '@bike4mind/common';
import { useSpeechScript } from '@client/app/hooks/data/speechScript';
import { mintTimelineId } from './timelineEdits';

type VoiceCaptionsControlProps = {
  timeline: StudioTimeline;
  voiceClip: StudioAudioClip;
  /** The voice file's probed length, when the editor has measured it. */
  sourceDurationMs?: number;
  onChange: (timeline: StudioTimeline) => void;
};

type Outcome = { kind: 'done'; count: number; timing: VoiceCaptionTiming } | { kind: 'error'; message: string };

const TIMING_LABELS: Record<VoiceCaptionTiming, string> = {
  aligned: 'timed from the spoken words',
  estimated: 'spread over the clip (no word timing for this script)',
};

/**
 * "Generate captions from voiceover" for the selected voice clip: phrases of its script, timed from the speech
 * provider's word timing when it has one, laid under the clip on the captions track. Regenerating replaces the
 * captions synced to this clip; captions made by hand are never touched.
 */
const VoiceCaptionsControl = ({ timeline, voiceClip, sourceDurationMs, onChange }: VoiceCaptionsControlProps) => {
  const { data: script, isLoading, isError } = useSpeechScript(voiceClip.fileId);
  const [text, setText] = useState(script?.text ?? '');
  const [sync, setSync] = useState(true);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // Prefill once the script arrives. A different voice clip remounts this control (ClipInspector keys it by clip id).
  const [prefilledFrom, setPrefilledFrom] = useState(script);
  if (script !== prefilledFrom) {
    setPrefilledFrom(script);
    setText(script?.text ?? '');
    setOutcome(null);
  }

  const hasSyncedCaptions = timeline.tracks.some(
    track => track.kind === 'captions' && track.clips.some(clip => clip.syncedVoiceClipId === voiceClip.id)
  );

  const generate = () => {
    const audioDurationMs = script?.durationMs ?? sourceDurationMs ?? voiceClip.trimStartMs + voiceClip.durationMs;
    const { cues, timing } = buildVoiceCaptionCues({ script: text, wordTimings: script?.wordTimings, audioDurationMs });
    const captions = voiceCaptionClips({
      voiceClip,
      cues,
      timelineDurationMs: timeline.durationMs,
      mintId: () => mintTimelineId('clip'),
      sync,
    });
    if (captions.length === 0) {
      setOutcome({ kind: 'error', message: 'Nothing to caption: add the words this clip says.' });
      return;
    }
    try {
      onChange(replaceVoiceCaptions(timeline, voiceClip.id, captions, () => mintTimelineId('track')));
      setOutcome({ kind: 'done', count: captions.length, timing });
    } catch (error) {
      setOutcome({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <Stack spacing={1} data-testid="production-voice-captions">
      <FormControl size="sm">
        <FormLabel>Script</FormLabel>
        <Textarea
          size="sm"
          minRows={2}
          maxRows={6}
          value={text}
          placeholder={isLoading ? 'Loading the script...' : 'The words this clip says'}
          slotProps={{ textarea: { 'data-testid': 'production-voice-captions-script-input' } }}
          onChange={event => setText(event.target.value)}
        />
        {isError && (
          <FormHelperText data-testid="production-voice-captions-load-error">
            Could not load the script for this clip. Type the words it says to caption it.
          </FormHelperText>
        )}
        {script?.truncated && (
          <FormHelperText>Only the start of a long script was kept. Paste the rest before generating.</FormHelperText>
        )}
      </FormControl>
      <Checkbox
        size="sm"
        label="Keep captions in sync with this clip"
        checked={sync}
        onChange={event => setSync(event.target.checked)}
        slotProps={{ input: { 'data-testid': 'production-voice-captions-sync-checkbox' } }}
      />
      <Button
        size="sm"
        variant="soft"
        disabled={isLoading || text.trim().length === 0}
        data-testid="production-voice-captions-generate-btn"
        onClick={generate}
      >
        {hasSyncedCaptions ? 'Regenerate captions from voiceover' : 'Generate captions from voiceover'}
      </Button>
      {outcome?.kind === 'done' && (
        <Typography level="body-xs" data-testid="production-voice-captions-result">
          {outcome.count} captions, {TIMING_LABELS[outcome.timing]}.
        </Typography>
      )}
      {outcome?.kind === 'error' && (
        <Typography level="body-xs" color="danger" data-testid="production-voice-captions-error">
          {outcome.message}
        </Typography>
      )}
    </Stack>
  );
};

export default VoiceCaptionsControl;
