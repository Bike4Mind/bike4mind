import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

const mocks = vi.hoisted(() => ({
  s3: vi.fn(),
  transcribe: vi.fn(),
  create: vi.fn(),
  warn: vi.fn(),
  options: vi.fn(),
}));
vi.mock('@bike4mind/utils', () => ({ BadRequestError: class extends Error {} }));
vi.mock('@aws-sdk/client-s3', async original => ({
  ...(await original<typeof import('@aws-sdk/client-s3')>()),
  S3Client: class {
    send = mocks.s3;
  },
}));
vi.mock('@aws-sdk/client-transcribe', async original => ({
  ...(await original<typeof import('@aws-sdk/client-transcribe')>()),
  TranscribeClient: class {
    send = mocks.transcribe;
  },
}));
vi.mock('openai', () => ({
  default: class {
    constructor(options: unknown) {
      mocks.options(options);
    }
    audio = { transcriptions: { create: mocks.create } };
  },
}));
vi.mock('@bike4mind/observability', () => ({ Logger: { globalInstance: { warn: mocks.warn } } }));

import { speechService } from './speechToTexService';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.s3.mockResolvedValue({ Body: Readable.from(['audio']) });
  mocks.create.mockResolvedValue({ text: 'finished' });
  mocks.transcribe.mockResolvedValue({ TranscriptionJob: { TranscriptionJobStatus: 'IN_PROGRESS' } });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('transcription cancellation', () => {
  it('interrupts AWS polling before the web deadline and stops making requests', async () => {
    const controller = new AbortController();
    mocks.transcribe.mockImplementation(async () => {
      if (mocks.transcribe.mock.calls.length === 2) controller.abort(new Error('deadline'));
      return { TranscriptionJob: { TranscriptionJobStatus: 'IN_PROGRESS' } };
    });
    const result = await new speechService('bucket')
      .transcribeAWSFromS3('audio.mp3', 'audio/mpeg', { abortSignal: controller.signal })
      .catch((error: unknown) => error);

    expect(result).toMatchObject({ name: 'AbortError' });
    expect(mocks.transcribe).toHaveBeenCalledTimes(2); // start + one IN_PROGRESS poll
    for (const [, options] of mocks.transcribe.mock.calls) expect(options.abortSignal).toBe(controller.signal);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining('remote job may still finish'),
      expect.objectContaining({ jobName: expect.any(String) })
    );
  });

  it('passes cancellation to the OpenAI request and disables SDK retries', async () => {
    const controller = new AbortController();
    let started: () => void = () => {};
    const requestStarted = new Promise<void>(resolve => {
      started = resolve;
    });
    mocks.create.mockImplementation(async (_body, options: { signal: AbortSignal }) => {
      started();
      return new Promise((_, reject) =>
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      );
    });
    const result = new speechService('bucket')
      .transcribeOpenAIFromS3('audio.mp3', 'audio/mpeg', { id: 'whisper-1', backend: 'openai' }, 'key', {
        abortSignal: controller.signal,
      })
      .catch((error: unknown) => error);
    await requestStarted;
    const failure = new Error('deadline');
    controller.abort(failure);
    expect(await result).toBe(failure);
    expect(mocks.options).toHaveBeenCalledWith({ apiKey: 'key', maxRetries: 0 });
    expect(mocks.s3.mock.calls[0][1].abortSignal).toBe(controller.signal);
  });

  it('destroys a stalled S3 audio body when aborted before the OpenAI upload', async () => {
    const controller = new AbortController();
    const body = new Readable({ read() {} });
    mocks.s3.mockResolvedValue({ Body: body });
    const result = new speechService('bucket')
      .transcribeOpenAIFromS3('audio.mp3', 'audio/mpeg', { id: 'whisper-1', backend: 'openai' }, 'key', {
        abortSignal: controller.signal,
      })
      .catch((error: unknown) => error);
    await Promise.resolve();
    controller.abort();
    expect(await result).toMatchObject({ name: 'AbortError' });
    expect(body.destroyed).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('returns completed OpenAI output without reclassifying it after a late abort', async () => {
    const controller = new AbortController();
    mocks.create.mockImplementation(async () => {
      controller.abort();
      return { text: 'finished' };
    });
    await expect(
      new speechService('bucket').transcribeOpenAIFromS3(
        'audio.mp3',
        'audio/mpeg',
        { id: 'whisper-1', backend: 'openai' },
        'key',
        { abortSignal: controller.signal }
      )
    ).resolves.toEqual({ text: 'finished' });
  });
});
