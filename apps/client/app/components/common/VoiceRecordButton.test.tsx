import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, createRef } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { VoiceRecordButton, type VoiceRecordButtonRef } from './VoiceRecordButton';

const post = vi.hoisted(() => vi.fn());
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post } }));
vi.mock('@client/app/hooks/useAudioAnalyzer', () => ({
  useAudioAnalyzer: () => ({ frequencyBars: [], isActive: false }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });

class FakeRecorder {
  state = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.onstop?.();
  }
}

const dictate = async (text: string) => {
  post.mockImplementation(async (url: string) => {
    if (url === '/api/ai/transcribe/init') {
      return { data: { url: 'https://upload.test', fields: {}, fileKey: 'k' } };
    }
    return { data: { text } };
  });
  const onRecordingEnd = vi.fn();
  const onRecordingError = vi.fn();
  const ref = createRef<VoiceRecordButtonRef>();
  render(
    <CssVarsProvider theme={appTheme}>
      <VoiceRecordButton
        ref={ref}
        onRecordingStart={vi.fn()}
        onRecordingEnd={onRecordingEnd}
        onRecordingError={onRecordingError}
      />
    </CssVarsProvider>
  );
  fireEvent.click(screen.getByTestId('voice-record-btn'));
  await screen.findByTestId('voice-record-strip');
  act(() => ref.current?.confirmRecording());
  await waitFor(() => expect(onRecordingEnd.mock.calls.length + onRecordingError.mock.calls.length).toBe(1));
  return { onRecordingEnd, onRecordingError };
};

describe('VoiceRecordButton transcription result', () => {
  beforeEach(() => {
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    post.mockReset();
  });

  it('reports an error when the transcript is empty, so the parent leaves recording state', async () => {
    const { onRecordingEnd, onRecordingError } = await dictate('');
    expect(onRecordingError).toHaveBeenCalledTimes(1);
    expect(onRecordingEnd).not.toHaveBeenCalled();
  });

  it('reports an error when the transcript is only whitespace', async () => {
    const { onRecordingEnd, onRecordingError } = await dictate('   ');
    expect(onRecordingError).toHaveBeenCalledTimes(1);
    expect(onRecordingEnd).not.toHaveBeenCalled();
  });

  it('hands a transcript to the parent', async () => {
    const { onRecordingEnd, onRecordingError } = await dictate(' hello ');
    expect(onRecordingEnd).toHaveBeenCalledWith('hello');
    expect(onRecordingError).not.toHaveBeenCalled();
  });
});
