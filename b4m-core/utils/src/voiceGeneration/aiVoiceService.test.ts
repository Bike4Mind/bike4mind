import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { Logger } from '@bike4mind/observability';
import { aiVoiceService, OpenAIVoiceService, ElevenLabsVoiceService } from './index';
import { CONTENT_TYPE_BY_FORMAT } from './AIVoiceService';

const speechCreate = vi.fn();
vi.mock('openai', () => ({
  default: class {
    audio = { speech: { create: (...args: unknown[]) => speechCreate(...args) } };
  },
}));

vi.mock('axios');
const mockedPost = vi.mocked(axios.post);

const logger = new Logger();

describe('aiVoiceService factory', () => {
  it('returns the OpenAI implementation for the openai vendor', () => {
    expect(aiVoiceService('openai', 'key', logger)).toBeInstanceOf(OpenAIVoiceService);
  });

  it('returns the ElevenLabs implementation for the elevenlabs vendor', () => {
    expect(aiVoiceService('elevenlabs', 'key', logger)).toBeInstanceOf(ElevenLabsVoiceService);
  });

  it('throws on an unknown vendor', () => {
    // deliberately bypass the type to exercise the runtime guard
    expect(() => aiVoiceService('nope' as 'openai', 'key', logger)).toThrow(/Unknown AI voice vendor/);
  });
});

describe('OpenAIVoiceService', () => {
  beforeEach(() => speechCreate.mockReset());

  it('synthesizes with defaults (tts-1, alloy, mp3) and returns audio/mpeg bytes', async () => {
    speechCreate.mockResolvedValue({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });

    const result = await aiVoiceService('openai', 'key', logger).synthesize('hello');

    expect(speechCreate).toHaveBeenCalledWith({
      model: 'tts-1',
      voice: 'alloy',
      input: 'hello',
      response_format: 'mp3',
    });
    expect(result.contentType).toBe('audio/mpeg');
    expect(result.format).toBe('mp3');
    expect(result.audio).toEqual(Buffer.from([1, 2, 3]));
  });

  it('rejects input longer than the OpenAI 4096-char limit before calling the API', async () => {
    await expect(aiVoiceService('openai', 'key', logger).synthesize('a'.repeat(4097))).rejects.toThrow(
      /exceeds 4096 characters/
    );
    expect(speechCreate).not.toHaveBeenCalled();
  });

  it('passes through requested voice, model and format', async () => {
    speechCreate.mockResolvedValue({ arrayBuffer: async () => new Uint8Array([9]).buffer });

    const result = await aiVoiceService('openai', 'key', logger).synthesize('hi', {
      voice: 'nova',
      model: 'tts-1-hd',
      format: 'wav',
    });

    expect(speechCreate).toHaveBeenCalledWith(
      expect.objectContaining({ voice: 'nova', model: 'tts-1-hd', response_format: 'wav' })
    );
    expect(result.contentType).toBe(CONTENT_TYPE_BY_FORMAT.wav);
  });
});

describe('ElevenLabsVoiceService', () => {
  beforeEach(() => mockedPost.mockReset());

  it('requires a voice id', async () => {
    await expect(aiVoiceService('elevenlabs', 'key', logger).synthesize('hi')).rejects.toThrow(/requires a voice id/);
  });

  it('rejects input longer than the ElevenLabs 10000-char limit before posting', async () => {
    await expect(
      aiVoiceService('elevenlabs', 'key', logger).synthesize('a'.repeat(10001), { voice: 'v1' })
    ).rejects.toThrow(/exceeds 10000 characters/);
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('rejects an output format ElevenLabs cannot produce', async () => {
    await expect(
      aiVoiceService('elevenlabs', 'key', logger).synthesize('hi', { voice: 'v1', format: 'flac' })
    ).rejects.toThrow(/does not support the 'flac' output format/);
  });

  it('posts to the voice endpoint with the mapped output_format and voice_settings', async () => {
    mockedPost.mockResolvedValue({ data: new Uint8Array([4, 5, 6]).buffer });

    const result = await aiVoiceService('elevenlabs', 'xi-key', logger).synthesize('hello', {
      voice: 'voice-123',
      stability: 0,
      similarityBoost: 0,
    });

    expect(mockedPost).toHaveBeenCalledWith(
      'https://api.elevenlabs.io/v1/text-to-speech/voice-123',
      { text: 'hello', voice_settings: { stability: 0, similarity_boost: 0 } },
      expect.objectContaining({
        headers: expect.objectContaining({ 'xi-api-key': 'xi-key' }),
        params: { output_format: 'mp3_44100_128' },
        responseType: 'arraybuffer',
      })
    );
    expect(result.contentType).toBe('audio/mpeg');
    expect(result.audio).toEqual(Buffer.from([4, 5, 6]));
  });

  it('omits voice_settings when neither stability nor similarityBoost is given', async () => {
    mockedPost.mockResolvedValue({ data: new Uint8Array([7]).buffer });

    await aiVoiceService('elevenlabs', 'xi-key', logger).synthesize('hello', { voice: 'voice-123' });

    expect(mockedPost).toHaveBeenCalledWith(expect.any(String), { text: 'hello' }, expect.any(Object));
  });
});
