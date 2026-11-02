import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { AxiosError, type AxiosResponse } from 'axios';
import { getThemeConfig } from '@client/app/utils/themes';
import { VoiceSampleList } from './VoiceSampleList';
import { VoiceSampleUnavailableError } from './openAiVoiceSample';

const { useElevenLabsVoicesMock, getOpenAiVoiceSampleMock, toastErrorMock } = vi.hoisted(() => ({
  useElevenLabsVoicesMock: vi.fn(),
  getOpenAiVoiceSampleMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));
vi.mock('@client/app/hooks/data/elevenLabsVoices', () => ({ useElevenLabsVoices: useElevenLabsVoicesMock }));
vi.mock('./openAiVoiceSample', async importOriginal => ({
  ...(await importOriginal<typeof import('./openAiVoiceSample')>()),
  getOpenAiVoiceSample: getOpenAiVoiceSampleMock,
}));
vi.mock('sonner', () => ({ toast: { error: toastErrorMock } }));

class FakeAudio {
  static instances: FakeAudio[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn(() => Promise.resolve());
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

beforeEach(() => {
  FakeAudio.instances = [];
  vi.stubGlobal('Audio', FakeAudio);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('VoiceSampleList (OpenAI)', () => {
  it('plays the generated sample for the voice, and a second click stops it', async () => {
    getOpenAiVoiceSampleMock.mockResolvedValue('blob:alloy');
    renderList('openai');

    fireEvent.click(screen.getByTestId('voice-sample-play-alloy-btn'));
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    expect(getOpenAiVoiceSampleMock).toHaveBeenCalledWith('alloy');
    expect(FakeAudio.instances[0].src).toBe('blob:alloy');
    expect(screen.getByRole('button', { name: 'Stop Alloy sample' })).toBeTruthy();

    fireEvent.click(screen.getByTestId('voice-sample-play-alloy-btn'));
    expect(FakeAudio.instances[0].pause).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Play Alloy sample' })).toBeTruthy();
  });

  it('stops the playing sample when another voice is played', async () => {
    getOpenAiVoiceSampleMock.mockImplementation((voice: string) => Promise.resolve(`blob:${voice}`));
    renderList('openai');

    fireEvent.click(screen.getByTestId('voice-sample-play-alloy-btn'));
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    fireEvent.click(screen.getByTestId('voice-sample-play-echo-btn'));
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(2));

    expect(FakeAudio.instances[0].pause).toHaveBeenCalled();
    expect(FakeAudio.instances[1].src).toBe('blob:echo');
  });

  it('never plays a sample whose voice was abandoned while it loaded', async () => {
    let resolveAlloy: (url: string) => void = () => {};
    getOpenAiVoiceSampleMock.mockReturnValueOnce(new Promise<string>(resolve => (resolveAlloy = resolve)));
    renderList('openai');

    fireEvent.click(screen.getByTestId('voice-sample-play-alloy-btn'));
    fireEvent.click(screen.getByTestId('voice-sample-play-alloy-btn'));
    await act(async () => resolveAlloy('blob:alloy'));

    expect(FakeAudio.instances).toHaveLength(0);
  });

  it('surfaces why a sample is unavailable', async () => {
    getOpenAiVoiceSampleMock.mockRejectedValue(new VoiceSampleUnavailableError('OpenAI is unavailable'));
    renderList('openai');

    fireEvent.click(screen.getByTestId('voice-sample-play-alloy-btn'));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith('OpenAI is unavailable'));
    expect(screen.getByRole('button', { name: 'Play Alloy sample' })).toBeTruthy();
  });

  it("shows the server's reason when the sample request is refused", async () => {
    getOpenAiVoiceSampleMock.mockRejectedValue(
      new AxiosError('Request failed', '422', undefined, undefined, {
        status: 422,
        data: { error: 'You do not have enough credits for text-to-speech.', errorCode: 'insufficient_credits' },
      } as AxiosResponse)
    );
    renderList('openai');

    fireEvent.click(screen.getByTestId('voice-sample-play-alloy-btn'));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith('You do not have enough credits for text-to-speech.')
    );
  });

  it('offers the preferred-voice row without a sample', () => {
    const onChange = renderList('openai');

    expect(screen.queryByTestId('voice-sample-play-default-btn')).toBeNull();
    fireEvent.click(screen.getByTestId('voice-sample-select-default-btn'));
    expect(onChange).toHaveBeenCalledWith('');
  });
});

describe('VoiceSampleList (ElevenLabs)', () => {
  it('lists workspace voices and plays their hosted preview clip', async () => {
    useElevenLabsVoicesMock.mockReturnValue({
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

    fireEvent.click(screen.getByTestId('voice-sample-play-v1-btn'));
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    expect(FakeAudio.instances[0].src).toBe('https://x/v1.mp3');

    fireEvent.click(screen.getByTestId('voice-sample-select-v1-btn'));
    expect(onChange).toHaveBeenCalledWith('v1');
  });

  it('falls back to the account voice note when the catalog is unavailable', () => {
    useElevenLabsVoicesMock.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    renderList('elevenlabs');

    expect(screen.getByText('ElevenLabs uses the voice configured in your account settings.')).toBeTruthy();
    expect(screen.queryByTestId('voice-sample-list')).toBeNull();
  });
});
