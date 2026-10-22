// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { post: (...args: unknown[]) => mocks.post(...args), put: vi.fn() },
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'user-1', preferredVoice: 'echo' }, setCurrentUser: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: (...args: unknown[]) => mocks.toastError(...args) },
}));

import VoicePreferenceSection from './VoicePreferenceSection';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderSection = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <VoicePreferenceSection />
    </CssVarsProvider>
  );

beforeEach(() => {
  vi.clearAllMocks();
  URL.createObjectURL = vi.fn(() => 'blob:audio');
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal(
    'Audio',
    vi.fn(() => ({ play: vi.fn().mockResolvedValue(undefined), pause: vi.fn() }))
  );
});

describe('VoicePreferenceSection voice test', () => {
  it('auditions through /api/ai/tts as a base64 preview that is never saved', async () => {
    mocks.post.mockResolvedValue({ data: { audio: 'AAA=', contentType: 'audio/mpeg' } });
    renderSection();

    fireEvent.click(screen.getByTestId('voice-test-btn'));

    await waitFor(() => expect(mocks.post).toHaveBeenCalled());
    const [path, body] = mocks.post.mock.calls[0];
    expect(path).toBe('/api/ai/tts');
    expect(body).toMatchObject({ provider: 'openai', voice: 'echo', preview: true, encoding: 'base64' });
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
  });

  it('revokes the inline object URL when playback ends', async () => {
    const audio: { play: () => Promise<void>; pause: () => void; onended?: () => void } = {
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
    };
    vi.stubGlobal(
      'Audio',
      vi.fn(function () {
        return audio;
      })
    );
    mocks.post.mockResolvedValue({ data: { delivery: 'inline', audio: 'AAA=', contentType: 'audio/mpeg' } });
    renderSection();

    fireEvent.click(screen.getByTestId('voice-test-btn'));
    await waitFor(() => expect(audio.play).toHaveBeenCalled());
    audio.onended?.();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:audio');
  });

  it('plays an oversized url delivery directly and never revokes it', async () => {
    const audio: { play: () => Promise<void>; pause: () => void; onended?: () => void } = {
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
    };
    const AudioMock = vi.fn(function () {
      return audio;
    });
    vi.stubGlobal('Audio', AudioMock);
    mocks.post.mockResolvedValue({
      data: { delivery: 'url', url: 'https://example.com/a.mp3', bytes: 5, contentType: 'audio/mpeg' },
    });
    renderSection();

    fireEvent.click(screen.getByTestId('voice-test-btn'));
    await waitFor(() => expect(audio.play).toHaveBeenCalled());
    audio.onended?.();

    expect(AudioMock).toHaveBeenCalledWith('https://example.com/a.mp3');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('refuses to play a substituted provider voice as an OpenAI audition', async () => {
    mocks.post.mockResolvedValue({
      data: {
        delivery: 'inline',
        audio: 'AAA=',
        contentType: 'audio/mpeg',
        format: 'mp3',
        provider: 'elevenlabs',
        fallbackFrom: 'openai',
      },
    });
    renderSection();

    fireEvent.click(screen.getByTestId('voice-test-btn'));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        'OpenAI is unavailable, so this voice cannot be previewed. Please contact your administrator.'
      )
    );
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('maps the classified insufficient_credits 422 to a credits message', async () => {
    mocks.post.mockRejectedValue(
      Object.assign(new Error('fail'), {
        isAxiosError: true,
        response: { status: 422, data: { errorCode: 'insufficient_credits' } },
      })
    );
    renderSection();

    fireEvent.click(screen.getByTestId('voice-test-btn'));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('You do not have enough credits to test this voice.')
    );
  });
});
