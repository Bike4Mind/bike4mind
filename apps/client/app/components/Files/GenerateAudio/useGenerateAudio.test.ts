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

describe('useGenerateAudio oversized audio', () => {
  it('plays a url-delivery response straight from its URL without building a blob', async () => {
    mocks.post.mockResolvedValue({
      data: {
        delivery: 'url',
        url: 'https://s3/audio.mp3',
        bytes: 5_000_000,
        format: 'mp3',
        contentType: 'audio/mpeg',
        saved: true,
        fabFileId: 'fab-1',
      },
    });

    const result = await generate();

    expect(result.current.result).toEqual({
      url: 'https://s3/audio.mp3',
      isObjectUrl: false,
      saved: true,
      fabFileId: 'fab-1',
      contentType: 'audio/mpeg',
    });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});

/**
 * TTS reports "out of credits" as a 422 tagged `insufficient_credits`, the same as
 * every other credit-metered route. This branch keys off the CLASSIFIER, not the
 * status, because a plain validation failure is also a 422 - so a status-only
 * check here would show "you are out of credits" for a malformed request.
 */
describe('useGenerateAudio credit exhaustion', () => {
  it('surfaces the credits message from a classified 422', async () => {
    mocks.post.mockRejectedValue(
      axiosFailure(422, {
        error: 'Insufficient credits for text-to-speech',
        provider: 'openai',
        errorCode: 'insufficient_credits',
      })
    );

    await generate();

    expect(mocks.toastError).toHaveBeenCalledWith('Insufficient credits for text-to-speech');
  });

  it('falls back to a generic line when the classified body carries no message', async () => {
    mocks.post.mockRejectedValue(axiosFailure(422, { errorCode: 'insufficient_credits' }));

    await generate();

    expect(mocks.toastError).toHaveBeenCalledWith('You do not have enough credits to generate this audio.');
  });

  // The trap this guards: an unclassified 422 is an ordinary bad request, and must
  // NOT be reported as a billing problem.
  it('does not claim a credit problem for an unclassified 422', async () => {
    mocks.post.mockRejectedValue(
      axiosFailure(422, { error: "The openai provider does not support the 'wav' output format" })
    );

    await generate();

    expect(mocks.toastError).toHaveBeenCalledWith("The openai provider does not support the 'wav' output format");
  });
});

describe('useGenerateAudio sound effects', () => {
  beforeEach(() => {
    mocks.getState.mockReturnValue({ mode: 'sound-effects', durationSeconds: 3, promptInfluence: 0.5 });
  });

  it('requests base64 JSON and plays the inline audio from a blob URL', async () => {
    mocks.post.mockResolvedValue({
      data: { audio: 'AAA=', contentType: 'audio/mpeg', saved: true, fabFileId: 'fab-2' },
    });

    const result = await generate();

    expect(mocks.post).toHaveBeenCalledWith(
      '/api/ai/sound-effects',
      { text: 'hello', durationSeconds: 3, promptInfluence: 0.5, encoding: 'base64' },
      expect.not.objectContaining({ responseType: expect.anything() })
    );
    expect(result.current.result).toEqual({
      url: 'blob:audio',
      isObjectUrl: true,
      saved: true,
      fabFileId: 'fab-2',
      contentType: 'audio/mpeg',
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Sound effect generated and saved to your Files.');
  });

  it('plays a url-delivery response without creating an object URL', async () => {
    mocks.post.mockResolvedValue({
      data: { delivery: 'url', url: 'https://s3/sfx.mp3', bytes: 9_000_000, contentType: 'audio/mpeg' },
    });

    const result = await generate();

    expect(result.current.result).toMatchObject({ url: 'https://s3/sfx.mp3', isObjectUrl: false, saved: false });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Sound effect generated.');
  });

  it('explains why a generated sound effect was not saved', async () => {
    mocks.post.mockResolvedValue({
      data: { audio: 'AAA=', contentType: 'audio/mpeg', saved: false, saveSkippedReason: 'storage_limit' },
    });

    await generate();

    expect(mocks.toastInfo).toHaveBeenCalledWith(
      'Sound effect generated, but your storage is full so it was not saved to Files.'
    );
  });

  it('shows the generic too-large message on a 413', async () => {
    mocks.post.mockRejectedValue(axiosFailure(413, { error: 'too big' }));

    await generate();

    expect(mocks.toastError).toHaveBeenCalledWith(
      'The generated audio was too large to return. Try again, or use shorter text.'
    );
  });
});

describe('useGenerateAudio tts save outcome', () => {
  it('names the save skip reason for audio', async () => {
    mocks.post.mockResolvedValue({
      data: { audio: 'AAA=', contentType: 'audio/mpeg', saved: false, saveSkippedReason: 'error' },
    });

    await generate();

    expect(mocks.toastInfo).toHaveBeenCalledWith('Audio generated, but saving to Files failed.');
  });
});
