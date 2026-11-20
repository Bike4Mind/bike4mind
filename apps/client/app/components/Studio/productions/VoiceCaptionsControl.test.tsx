import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StudioTimelineSchema,
  type SpeechWordTiming,
  type StudioAudioClip,
  type StudioCaptionClip,
  type StudioTimeline,
} from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  script: undefined as
    undefined | null | { text: string; truncated: boolean; wordTimings?: SpeechWordTiming[]; durationMs?: number },
  isLoading: false,
  isError: false,
}));

vi.mock('@client/app/hooks/data/speechScript', () => ({
  useSpeechScript: () => ({ data: h.script, isLoading: h.isLoading, isError: h.isError }),
}));

import VoiceCaptionsControl from './VoiceCaptionsControl';

const appTheme = extendTheme({ ...getThemeConfig() });
const FILE_A = 'a'.repeat(24);

const baseTimeline = (captions: Partial<StudioCaptionClip>[] = []): StudioTimeline =>
  StudioTimelineSchema.parse({
    version: 1,
    durationMs: 20_000,
    fps: 30,
    outputs: [{ id: 'out-16x9', aspectRatio: '16:9', width: 1920, height: 1080 }],
    tracks: [
      { id: 'voice-1', kind: 'voice', clips: [{ id: 'vo1', fileId: FILE_A, startMs: 1000, durationMs: 5000 }] },
      ...(captions.length > 0 ? [{ id: 'captions-1', kind: 'captions', clips: captions }] : []),
    ],
  });

const voiceClipOf = (timeline: StudioTimeline) => timeline.tracks[0].clips[0] as StudioAudioClip;

const captionsOf = (timeline: StudioTimeline) =>
  timeline.tracks.flatMap(track => (track.kind === 'captions' ? track.clips : []));

const renderControl = (timeline = baseTimeline()) => {
  const onChange = vi.fn<(next: StudioTimeline) => void>();
  render(
    <CssVarsProvider theme={appTheme}>
      <VoiceCaptionsControl timeline={timeline} voiceClip={voiceClipOf(timeline)} onChange={onChange} />
    </CssVarsProvider>
  );
  return onChange;
};

const generate = () => fireEvent.click(screen.getByTestId('production-voice-captions-generate-btn'));

beforeEach(() => {
  h.script = undefined;
  h.isLoading = false;
  h.isError = false;
});

describe('VoiceCaptionsControl', () => {
  it('times captions from the word timing and places them under the voice clip', () => {
    h.script = {
      text: 'Ride further. Go!',
      truncated: false,
      durationMs: 2000,
      wordTimings: [
        { text: 'Ride', startMs: 100, endMs: 400 },
        { text: 'further.', startMs: 450, endMs: 900 },
        { text: 'Go!', startMs: 1200, endMs: 1500 },
      ],
    };
    const onChange = renderControl();

    expect(screen.getByTestId('production-voice-captions-script-input')).toHaveValue('Ride further. Go!');
    generate();

    const captions = captionsOf(onChange.mock.calls[0][0]);
    expect(
      captions.map(({ text, startMs, durationMs, syncedVoiceClipId }) => ({
        text,
        startMs,
        durationMs,
        syncedVoiceClipId,
      }))
    ).toEqual([
      { text: 'Ride further.', startMs: 1100, durationMs: 1100, syncedVoiceClipId: 'vo1' },
      { text: 'Go!', startMs: 2200, durationMs: 700, syncedVoiceClipId: 'vo1' },
    ]);
    expect(screen.getByTestId('production-voice-captions-result')).toHaveTextContent('timed from the spoken words');
  });

  it('spreads an edited script over the clip, unsynced when the box is cleared', () => {
    h.script = { text: 'Old words', truncated: false, durationMs: 2000 };
    const onChange = renderControl();

    fireEvent.change(screen.getByTestId('production-voice-captions-script-input'), {
      target: { value: 'New words here' },
    });
    fireEvent.click(screen.getByTestId('production-voice-captions-sync-checkbox'));
    generate();

    const captions = captionsOf(onChange.mock.calls[0][0]);
    expect(captions).toHaveLength(1);
    expect(captions[0]).toMatchObject({ text: 'New words here', startMs: 1000, durationMs: 2000 });
    expect(captions[0]).not.toHaveProperty('syncedVoiceClipId');
    expect(screen.getByTestId('production-voice-captions-result')).toHaveTextContent('spread over the clip');
  });

  it('lets a clip that is not generated speech be captioned from typed text', () => {
    h.script = null;
    const onChange = renderControl();

    expect(screen.getByTestId('production-voice-captions-generate-btn')).toBeDisabled();
    fireEvent.change(screen.getByTestId('production-voice-captions-script-input'), { target: { value: 'Hello' } });
    generate();

    // Without a measured length the clip's own length stands in.
    expect(captionsOf(onChange.mock.calls[0][0])[0]).toMatchObject({ startMs: 1000, durationMs: 5000 });
  });

  it('says when the script could not be loaded and still accepts typed text', () => {
    h.isError = true;
    const onChange = renderControl();

    expect(screen.getByTestId('production-voice-captions-load-error')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('production-voice-captions-script-input'), { target: { value: 'Hello' } });
    generate();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('reports a clash with a hand-made caption instead of changing the timeline', () => {
    h.script = { text: 'Hello there', truncated: false, durationMs: 2000 };
    const onChange = renderControl(baseTimeline([{ id: 'hand', text: 'Mine', startMs: 1500, durationMs: 500 }]));

    generate();

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('production-voice-captions-error')).toHaveTextContent(/overlap/);
  });

  it('offers to regenerate once the clip has synced captions', () => {
    h.script = { text: 'Hello', truncated: false };
    renderControl(
      baseTimeline([{ id: 'c1', text: 'Hello', startMs: 1000, durationMs: 500, syncedVoiceClipId: 'vo1' }])
    );
    expect(screen.getByTestId('production-voice-captions-generate-btn')).toHaveTextContent('Regenerate');
  });
});
