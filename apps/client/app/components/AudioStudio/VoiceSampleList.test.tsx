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
  act(async () => fireEvent.click(screen.getByTestId(`voice-sample-play-btn-${voice}`)));

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

  it('ignores an error from a superseded sample', async () => {
    renderList('openai');

    await clickPlay('alloy');
    await clickPlay('echo');
    act(() => FakeAudio.instances[0].onerror?.());

    expect(screen.getByRole('button', { name: 'Stop Echo sample' })).toBeTruthy();
    expect(toastErrorMock).not.toHaveBeenCalled();
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

    expect(screen.queryByTestId('voice-sample-play-btn-default')).toBeNull();
    fireEvent.click(screen.getByTestId('voice-sample-select-btn-default'));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('is one tab stop and moves the selection with arrow keys', () => {
    const onChange = renderList('openai');
    const radios = screen.getAllByRole('radio');

    expect(radios.map(radio => radio.tabIndex)).toEqual([0, ...radios.slice(1).map(() => -1)]);
    fireEvent.keyDown(radios[0], { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith('alloy');
    expect(document.activeElement).toBe(radios[1]);
    fireEvent.keyDown(radios[0], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(radios[radios.length - 1]);
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
    expect(screen.queryByTestId('voice-sample-play-btn-v2')).toBeNull();

    await clickPlay('v1');
    expect(FakeAudio.instances[0].src).toBe('https://x/v1.mp3');

    fireEvent.click(screen.getByTestId('voice-sample-select-btn-v1'));
    expect(onChange).toHaveBeenCalledWith('v1');
  });

  it('falls back to the account voice note when no voices are available', () => {
    useElevenLabsTtsVoicesMock.mockReturnValue({ data: [], isLoading: false, isError: false });
    renderList('elevenlabs');

    expect(screen.getByText('ElevenLabs uses the voice configured in your account settings.')).toBeTruthy();
    expect(screen.queryByTestId('voice-sample-list')).toBeNull();
  });

  it('says the list failed to load instead of showing the no-key note', () => {
    useElevenLabsTtsVoicesMock.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    renderList('elevenlabs');

    expect(screen.getByTestId('voice-sample-list-error')).toBeTruthy();
    expect(screen.queryByText('ElevenLabs uses the voice configured in your account settings.')).toBeNull();
  });
});
