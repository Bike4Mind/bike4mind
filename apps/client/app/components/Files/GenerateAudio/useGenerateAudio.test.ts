import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AxiosError, AxiosHeaders } from 'axios';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    post: vi.fn(),
    toastInfo: vi.fn(),
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
    getState: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: {
    info: (...a: unknown[]) => mocks.toastInfo(...a),
    error: (...a: unknown[]) => mocks.toastError(...a),
    success: (...a: unknown[]) => mocks.toastSuccess(...a),
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { post: (...a: unknown[]) => mocks.post(...a) },
}));

vi.mock('@client/app/stores/useAudioGenSettings', () => ({
  useAudioGenSettings: { getState: () => mocks.getState() },
}));

import { useGenerateAudio } from './useGenerateAudio';

// A 4xx from the route arrives as an axios error carrying the JSON error body.
const axiosFailure = (status: number, data: unknown) =>
  new AxiosError('Request failed', 'ERR_BAD_REQUEST', undefined, null, {
    status,
    statusText: '',
    data,
    headers: {},
    config: { headers: new AxiosHeaders() },
  });

const generate = async (text = 'hello') => {
  const { result } = renderHook(() => useGenerateAudio());
  await act(async () => {
    await result.current.generate(text);
  });
  return result;
};

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.getState.mockReturnValue({ mode: 'tts', ttsProvider: 'openai', voice: '', format: 'mp3' });
  URL.createObjectURL = vi.fn(() => 'blob:audio');
  URL.revokeObjectURL = vi.fn();
});

describe('useGenerateAudio provider substitution', () => {
  it('tells the user which provider stood in, since the voice will not be the one selected', async () => {
    mocks.post.mockResolvedValue({
      data: { audio: 'AAA=', format: 'mp3', contentType: 'audio/mpeg', provider: 'elevenlabs', fallbackFrom: 'openai' },
    });

    await generate();

    expect(mocks.toastInfo).toHaveBeenCalledWith(
      'OpenAI was unavailable, so this audio was generated with ElevenLabs.'
    );
  });

  it('stays quiet about providers when the requested one was used', async () => {
    mocks.post.mockResolvedValue({ data: { audio: 'AAA=', format: 'mp3', contentType: 'audio/mpeg' } });

    await generate();

    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Audio generated.');
  });

  it('advises switching provider when a configured key was rejected and nothing could cover for it', async () => {
    mocks.post.mockRejectedValue(
      axiosFailure(401, {
        error: 'TTS request rejected by the openai provider',
        provider: 'openai',
        errorCode: 'provider_rejected',
      })
    );

    await generate();

    expect(mocks.toastError).toHaveBeenCalledWith(
      'TTS request rejected by the openai provider. Try a different provider in the audio settings.'
    );
  });

  it('keeps the ask-your-admin message when no provider is configured at all', async () => {
    mocks.post.mockRejectedValue(
      axiosFailure(401, { error: 'OpenAI API key not configured', errorCode: 'provider_not_configured' })
    );

    await generate();

    expect(mocks.toastError).toHaveBeenCalledWith(
      'No provider API key is configured. Ask your administrator to set one up.'
    );
  });
});
