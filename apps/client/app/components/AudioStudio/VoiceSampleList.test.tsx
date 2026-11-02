import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { VoiceSampleList } from './VoiceSampleList';

const { useElevenLabsTtsVoicesMock, toastErrorMock } = vi.hoisted(() => ({
  useElevenLabsTtsVoicesMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));
vi.mock('@client/app/hooks/data/ttsVoices', () => ({ useElevenLabsTtsVoices: useElevenLabsTtsVoicesMock }));
vi.mock('sonner', () => ({ toast: { error: toastErrorMock } }));

class FakeAudio {
  static instances: FakeAudio[] = [];
  static playResult: () => Promise<void> = () => Promise.resolve();
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn(() => FakeAudio.playResult());
  pause = vi.fn();
  constructor(public src: string) {
    FakeAudio.instances.push(this);
  }
}

const appTheme = extendTheme({ ...getThemeConfig() });

const renderList = (provider: 'openai' | 'elevenlabs', onChange = vi.fn()) => {
  render(
    <CssVarsProvider theme={appTheme}>
      <VoiceSampleList provider={provider} value="" onChange={onChange} />
    </CssVarsProvider>
  );
  return onChange;
};

const clickPlay = (voice: string) =>
  act(async () => fireEvent.click(screen.getByTestId(`voice-sample-play-${voice}-btn`)));

beforeEach(() => {
  FakeAudio.instances = [];
  FakeAudio.playResult = () => Promise.resolve();
  vi.stubGlobal('Audio', FakeAudio);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('VoiceSampleList (OpenAI)', () => {
  it("plays the voice's pre-recorded sample, and a second click stops it", async () => {
    renderList('openai');

    await clickPlay('alloy');
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0].src).toBe('/audio/voice-samples/openai/alloy.mp3');
    expect(screen.getByRole('button', { name: 'Stop Alloy sample' })).toBeTruthy();

    await clickPlay('alloy');
    expect(FakeAudio.instances[0].pause).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Play Alloy sample' })).toBeTruthy();
  });

  it('stops the playing sample when another voice is played, and ignores the stale one ending', async () => {
    renderList('openai');

    await clickPlay('alloy');
    await clickPlay('echo');
    expect(FakeAudio.instances[0].pause).toHaveBeenCalled();
    expect(FakeAudio.instances[1].src).toBe('/audio/voice-samples/openai/echo.mp3');

    act(() => FakeAudio.instances[0].onended?.());
    expect(screen.getByRole('button', { name: 'Stop Echo sample' })).toBeTruthy();
  });

  it('says so when the browser blocks playback', async () => {
    FakeAudio.playResult = () => Promise.reject(new DOMException('blocked', 'NotAllowedError'));
    renderList('openai');

    await clickPlay('alloy');

    expect(toastErrorMock).toHaveBeenCalledWith('Your browser blocked audio playback');
    expect(screen.getByRole('button', { name: 'Play Alloy sample' })).toBeTruthy();
  });

  it('offers the preferred-voice row without a sample', () => {
    const onChange = renderList('openai');

    expect(screen.queryByTestId('voice-sample-play-default-btn')).toBeNull();
    fireEvent.click(screen.getByTestId('voice-sample-select-default-btn'));
    expect(onChange).toHaveBeenCalledWith('');
  });
});

describe('VoiceSampleList (ElevenLabs)', () => {
  it('lists the account voices and plays their hosted preview clip', async () => {
    useElevenLabsTtsVoicesMock.mockReturnValue({
      data: [
        { id: 'v1', name: 'Rachel', labels: { gender: 'female', accent: 'american' }, previewUrl: 'https://x/v1.mp3' },
        { id: 'v2', name: 'Silent', labels: {} },
      ],
      isLoading: false,
      isError: false,
    });
    const onChange = renderList('elevenlabs');

    expect(screen.getByText('female, american')).toBeTruthy();
    expect(screen.queryByTestId('voice-sample-play-v2-btn')).toBeNull();

    await clickPlay('v1');
    expect(FakeAudio.instances[0].src).toBe('https://x/v1.mp3');

    fireEvent.click(screen.getByTestId('voice-sample-select-v1-btn'));
    expect(onChange).toHaveBeenCalledWith('v1');
  });

  it('falls back to the account voice note when no voices are available', () => {
    useElevenLabsTtsVoicesMock.mockReturnValue({ data: [], isLoading: false, isError: false });
    renderList('elevenlabs');

    expect(screen.getByText('ElevenLabs uses the voice configured in your account settings.')).toBeTruthy();
    expect(screen.queryByTestId('voice-sample-list')).toBeNull();
  });
});
