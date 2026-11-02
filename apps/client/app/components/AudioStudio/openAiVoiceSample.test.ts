import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearOpenAiVoiceSamples,
  getOpenAiVoiceSample,
  VOICE_SAMPLE_TEXT,
  VoiceSampleUnavailableError,
} from './openAiVoiceSample';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: postMock } }));

const urlResponse = (url: string) => ({ data: { delivery: 'url', url } });

beforeEach(() => clearOpenAiVoiceSamples());
afterEach(() => vi.clearAllMocks());

describe('getOpenAiVoiceSample', () => {
  it('requests an unsaved OpenAI preview of the sample text for the voice', async () => {
    postMock.mockResolvedValue(urlResponse('https://signed/alloy.mp3'));

    await expect(getOpenAiVoiceSample('alloy')).resolves.toBe('https://signed/alloy.mp3');
    expect(postMock).toHaveBeenCalledWith(
      '/api/ai/tts',
      { text: VOICE_SAMPLE_TEXT, provider: 'openai', voice: 'alloy', preview: true, encoding: 'base64' },
      expect.objectContaining({ skipAuthRefresh: true })
    );
  });

  it('synthesizes each voice once, sharing the request across concurrent callers', async () => {
    postMock.mockResolvedValue(urlResponse('https://signed/echo.mp3'));

    await Promise.all([getOpenAiVoiceSample('echo'), getOpenAiVoiceSample('echo')]);
    await getOpenAiVoiceSample('echo');

    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a fallback vendor voice, and retries on the next call', async () => {
    postMock.mockResolvedValueOnce({ data: { ...urlResponse('x').data, fallbackFrom: 'openai' } });
    await expect(getOpenAiVoiceSample('marin')).rejects.toBeInstanceOf(VoiceSampleUnavailableError);

    postMock.mockResolvedValueOnce(urlResponse('https://signed/marin.mp3'));
    await expect(getOpenAiVoiceSample('marin')).resolves.toBe('https://signed/marin.mp3');
    expect(postMock).toHaveBeenCalledTimes(2);
  });
});
