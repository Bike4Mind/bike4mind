import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getQuestErrorCode,
  MODEL_REQUIRES_SUBSCRIPTION_ERROR_CODE,
  type IGenerationJobDocument,
} from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/utils';
import type { ToolContext } from '../../base/types';
import { AUDIO_JOB_INLINE_TIMEOUT_MS, audioGenerationTool, type AudioToolConfig, type AudioToolJobs } from './index';

const AUDIO_BYTES = Buffer.from('fake-mp3');

function job(overrides: Record<string, unknown> = {}, payload: Record<string, unknown> = {}): IGenerationJobDocument {
  return {
    id: 'job-1',
    kind: 'speech',
    state: 'succeeded',
    payload: {
      output: { location: 'files', s3Key: 'files/clip.mp3', contentType: 'audio/mpeg', bytes: 8 },
      ...payload,
    },
    ...overrides,
  } as unknown as IGenerationJobDocument;
}

function createJobs() {
  const created = { ok: true as const, created: true, job: job({ state: 'pending' }) };
  return {
    createSpeechJob: vi.fn().mockResolvedValue(created),
    createSoundEffectJob: vi
      .fn()
      .mockResolvedValue({ ...created, job: job({ kind: 'sound_effect', state: 'pending' }) }),
    runInline: vi.fn().mockResolvedValue(job()),
    readOutput: vi.fn().mockResolvedValue(AUDIO_BYTES),
  } satisfies AudioToolJobs;
}

function createFakeContext() {
  return {
    userId: 'u1',
    organizationId: 'org-1',
    apiKeyId: 'key-1',
    questId: 'q1',
    sessionId: 's1',
    getEntitlements: async () => [],
    user: { isAdmin: false, preferredVoice: 'nova' } as ToolContext['user'],
    logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() } as unknown as ToolContext['logger'],
    db: {} as ToolContext['db'],
    storage: {} as ToolContext['storage'],
    imageGenerateStorage: {
      upload: vi.fn().mockResolvedValue('stored-key.mp3'),
      getSignedUrl: vi.fn(),
      getPublicUrl: vi.fn(),
    },
    statusUpdate: vi.fn().mockResolvedValue(undefined),
    onStart: vi.fn().mockResolvedValue(undefined),
    onFinish: vi.fn().mockResolvedValue(undefined),
    llm: {} as ToolContext['llm'],
  };
}

type FakeContext = ReturnType<typeof createFakeContext>;

function run(context: FakeContext, args: Record<string, unknown>, config?: AudioToolConfig) {
  return audioGenerationTool.implementation(context as unknown as ToolContext, config).toolFn(args);
}

describe('audio_generation tool', () => {
  let jobs: ReturnType<typeof createJobs>;
  let context: FakeContext;

  beforeEach(() => {
    jobs = createJobs();
    context = createFakeContext();
  });

  it('answers unavailable, without generating, when the host wired no jobs', async () => {
    await expect(run(context, { kind: 'speech', text: 'hello' }, { ttsProvider: 'openai' })).resolves.toBe(
      'Error: Audio generation is currently unavailable. Please try again later.'
    );
    await expect(run(context, { kind: 'speech', text: 'hello' })).resolves.toMatch(/unavailable/);
    expect(context.imageGenerateStorage.upload).not.toHaveBeenCalled();
  });

  it('rejects empty text and malformed arguments before creating a job', async () => {
    await expect(run(context, { kind: 'speech', text: '  ' }, { jobs })).resolves.toBe(
      'Error: audio_generation requires non-empty text.'
    );
    await expect(run(context, { kind: 'speech', text: 42 }, { jobs })).resolves.toBe(
      'Error: audio_generation received invalid arguments.'
    );
    expect(jobs.createSpeechJob).not.toHaveBeenCalled();
  });

  it('creates a speech job from the saved settings, runs it inline and pushes the clip for inline playback', async () => {
    const result = await run(
      context,
      { kind: 'speech', text: 'hello world' },
      { jobs, ttsProvider: 'elevenlabs', voice: 'Rachel', format: 'pcm', languageCode: 'en' }
    );

    expect(result).toBe('Successfully generated speech');
    expect(jobs.createSpeechJob).toHaveBeenCalledWith({
      user: { id: 'u1', organizationId: 'org-1', adminRoleWithheld: true },
      request: {
        text: 'hello world',
        provider: 'elevenlabs',
        voice: 'Rachel',
        // Raw PCM has no container the inline player can decode.
        format: 'mp3',
        languageCode: 'en',
      },
      source: 'agent',
      apiKeyId: 'key-1',
      saveToFiles: true,
      sessionId: 's1',
      questId: 'q1',
      idempotencyKey: expect.stringMatching(/^agent:u1:q1:/),
      preferredVoice: 'nova',
    });
    expect(jobs.runInline).toHaveBeenCalledWith('job-1', AUDIO_JOB_INLINE_TIMEOUT_MS);
    expect(jobs.readOutput).toHaveBeenCalledWith(expect.objectContaining({ s3Key: 'files/clip.mp3' }));
    expect(context.imageGenerateStorage.upload).toHaveBeenCalledWith(AUDIO_BYTES, expect.stringMatching(/\.mp3$/), {
      ContentType: 'audio/mpeg',
    });
    expect(context.statusUpdate).toHaveBeenLastCalledWith({ images: ['stored-key.mp3'] });
  });

  it('bills only through the job: onStart carries no cost data and onFinish never fires', async () => {
    await run(context, { kind: 'speech', text: 'hello world' }, { jobs });
    expect(context.onStart).toHaveBeenCalledWith('audio_generation', { kind: 'speech' });
    expect(context.onFinish).not.toHaveBeenCalled();
  });

  it('defaults to OpenAI speech when kind and settings are omitted, sending no languageCode', async () => {
    await run(context, { text: 'hello' }, { jobs, languageCode: 'en' });
    const request = jobs.createSpeechJob.mock.calls[0][0].request;
    expect(request).toMatchObject({ text: 'hello', provider: 'openai' });
    expect(request).not.toHaveProperty('languageCode');
  });

  it('creates a sound-effect job; the model-supplied duration wins over the saved one', async () => {
    jobs.runInline.mockResolvedValue(job({ kind: 'sound_effect' }));
    const result = await run(
      context,
      { kind: 'sound_effect', text: 'a dog barking', durationSeconds: 4 },
      { jobs, durationSeconds: 10, promptInfluence: 0.7 }
    );

    expect(result).toBe('Successfully generated sound effect');
    expect(jobs.createSoundEffectJob).toHaveBeenCalledWith(
      expect.objectContaining({
        request: { provider: 'elevenlabs', text: 'a dog barking', durationSeconds: 4, promptInfluence: 0.7 },
        saveToFiles: true,
        source: 'agent',
      })
    );
    expect(jobs.createSpeechJob).not.toHaveBeenCalled();
    expect(context.statusUpdate).toHaveBeenLastCalledWith({ images: ['stored-key.mp3'] });
  });

  it('rejects over-length input and an out-of-range duration before creating a job', async () => {
    await expect(run(context, { kind: 'sound_effect', text: 'x'.repeat(451) }, { jobs })).resolves.toMatch(
      /description too long \(max 450/
    );
    await expect(run(context, { kind: 'speech', text: 'x'.repeat(4097) }, { jobs })).resolves.toMatch(
      /text too long for openai speech/
    );
    await expect(run(context, { kind: 'sound_effect', text: 'boom', durationSeconds: 31 }, { jobs })).resolves.toBe(
      'Error: audio_generation received invalid arguments.'
    );
    expect(jobs.createSpeechJob).not.toHaveBeenCalled();
    expect(jobs.createSoundEffectJob).not.toHaveBeenCalled();
  });

  it('throws an insufficient_credits error so the turn ends with the add-credits notice', async () => {
    jobs.createSpeechJob.mockResolvedValue({
      ok: false,
      status: 402,
      code: 'insufficient_credits',
      message: 'You do not have enough credits',
    });
    const error = await run(context, { kind: 'speech', text: 'hello' }, { jobs }).catch((caught: unknown) => caught);
    expect(getQuestErrorCode(error)).toBe('insufficient_credits');
    expect(jobs.runInline).not.toHaveBeenCalled();
  });

  it('maps a missing provider to the speech-unavailable or the ElevenLabs-key message', async () => {
    const unavailable = { ok: false, status: 422, code: 'model_unavailable', message: 'none' } as const;
    jobs.createSpeechJob.mockResolvedValue(unavailable);
    jobs.createSoundEffectJob.mockResolvedValue(unavailable);
    await expect(run(context, { kind: 'speech', text: 'hello' }, { jobs })).resolves.toMatch(/currently unavailable/);
    await expect(run(context, { kind: 'sound_effect', text: 'boom' }, { jobs })).resolves.toBe(
      'Error: sound effects require an ElevenLabs API key; speech (kind="speech") is available.'
    );
  });

  it('returns any other refusal to the model', async () => {
    jobs.createSpeechJob.mockResolvedValue({
      ok: false,
      status: 400,
      code: 'storage_quota_exceeded',
      message: 'Not enough free file storage for this clip',
      storage: {} as never,
    });
    await expect(run(context, { kind: 'speech', text: 'hello' }, { jobs })).resolves.toBe(
      'Error: speech request refused: Not enough free file storage for this clip'
    );
  });

  it('returns a free-tier admission refusal as the result, and rethrows anything else', async () => {
    jobs.createSpeechJob.mockRejectedValueOnce(
      new ForbiddenError('This model requires a paid plan', { errorCode: MODEL_REQUIRES_SUBSCRIPTION_ERROR_CODE })
    );
    await expect(run(context, { kind: 'speech', text: 'hello' }, { jobs })).resolves.toMatch(
      /^Error: This model requires a paid plan.*Do not retry it this turn/
    );

    jobs.createSpeechJob.mockRejectedValueOnce(new Error('database down'));
    await expect(run(context, { kind: 'speech', text: 'hello' }, { jobs })).rejects.toThrow('database down');
  });

  it.each(['blocked', 'failed'])(
    'reports a %s job with the sanitized provider message and shows nothing',
    async state => {
      jobs.runInline.mockResolvedValue(
        job(
          { state, error: { code: 'provider_error', message: 'upstream said key sk-123' } },
          { output: undefined, producedBy: undefined }
        )
      );
      await expect(run(context, { kind: 'speech', text: 'hello' }, { jobs })).resolves.toBe(
        'Error: TTS request rejected by the openai provider.'
      );
      expect(jobs.readOutput).not.toHaveBeenCalled();
      expect(context.imageGenerateStorage.upload).not.toHaveBeenCalled();
    }
  );

  it('says the clip is still generating when the inline run times out', async () => {
    jobs.runInline.mockResolvedValue(null);
    await expect(run(context, { kind: 'sound_effect', text: 'boom' }, { jobs })).resolves.toMatch(
      /^The sound effect is still generating\. It will be saved to the user's Files/
    );
    expect(context.imageGenerateStorage.upload).not.toHaveBeenCalled();
  });

  it('reports a clip that was generated but could not be staged for inline playback', async () => {
    jobs.readOutput.mockRejectedValue(new Error('NoSuchKey'));
    await expect(run(context, { kind: 'speech', text: 'hello' }, { jobs })).resolves.toBe(
      "The speech was generated and saved to the user's Files, but could not be shown inline in the chat."
    );
    expect(context.statusUpdate).not.toHaveBeenCalledWith({ images: expect.anything() });
  });
});
